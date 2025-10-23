#!/usr/bin/env python3
"""
SmartEarnbdBot - Updated for PostgreSQL (psycopg2) and Render deployment.
"""

import logging
import os
import datetime
# PostgreSQL Libraries
import psycopg2 
from urllib.parse import urlparse
# Telegram Libraries
from dotenv import load_dotenv
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# Load env
load_dotenv()

# --- CONFIGURATION (Environment Variables) ---
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID") or 0)
REF_BONUS = int(os.getenv("REF_BONUS") or 10)
MIN_WITHDRAW = int(os.getenv("MIN_WITHDRAW") or 200)
DAILY_TASK_LIMIT = int(os.getenv("DAILY_TASK_LIMIT") or 30)
SIGNUP_BONUS = int(os.getenv("SIGNUP_BONUS") or 50) 
TASK_REWARD = int(os.getenv("TASK_REWARD") or 5) 

# --- POSTGRES SETUP ---
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL is not set in environment variables.")

# Parse URL for psycopg2 connection
try:
    url = urlparse(DATABASE_URL)
    DB_PARAMS = {
        'database': url.path[1:],
        'user': url.username,
        'password': url.password,
        'host': url.hostname,
        'port': url.port,
        'sslmode': 'require' # Neon/Render usually requires SSL
    }
except Exception as e:
     raise ValueError(f"Invalid DATABASE_URL format: {e}")


# Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


# --- DB CONNECTION & HELPERS ---

def get_conn():
    """Establishes and returns a PostgreSQL connection."""
    return psycopg2.connect(**DB_PARAMS)


def init_db():
    """Initializes tables using PostgreSQL syntax."""
    conn = get_conn()
    cur = conn.cursor()
    
    # Using BIGSERIAL for auto-increment and TIMESTAMP WITH TIME ZONE for time data
    cur.execute("""
        -- users table
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            telegram_id BIGINT UNIQUE NOT NULL,
            first_name TEXT,
            username TEXT,
            balance BIGINT DEFAULT 0, 
            bonus_given INTEGER DEFAULT 0,
            referred_by BIGINT DEFAULT NULL,
            referrals_count INTEGER DEFAULT 0,
            tasks_done_date TEXT DEFAULT NULL,
            tasks_done_count INTEGER DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        -- withdrawals table
        CREATE TABLE IF NOT EXISTS withdrawals (
            id BIGSERIAL PRIMARY KEY,
            telegram_id BIGINT,
            method TEXT,
            account TEXT,
            amount BIGINT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            processed_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
        );
    """)
    conn.commit()
    conn.close()


def get_user(telegram_id):
    conn = get_conn()
    cur = conn.cursor()
    # Note: Using %s placeholder for psycopg2
    cur.execute("SELECT * FROM users WHERE telegram_id=%s", (telegram_id,)) 
    row = cur.fetchone()
    conn.close()
    return row


def add_user(telegram_id, first_name="", username="", referred_by=None):
    conn = get_conn()
    cur = conn.cursor()
    # Insert new user
    cur.execute(
        "INSERT INTO users (telegram_id, first_name, username, referred_by) VALUES (%s, %s, %s, %s) ON CONFLICT (telegram_id) DO NOTHING",
        (telegram_id, first_name, username, referred_by),
    )
    
    # Handle referral bonus if a new user was inserted AND referred_by is set
    if referred_by and cur.rowcount > 0: # Check if a row was actually inserted
        if referred_by != telegram_id and get_user(referred_by):
            cur.execute(
                "UPDATE users SET referrals_count = referrals_count + 1, balance = balance + %s WHERE telegram_id=%s",
                (REF_BONUS, referred_by),
            )
    conn.commit()
    conn.close()


def give_signup_bonus_if_needed(telegram_id, amount=SIGNUP_BONUS): 
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT bonus_given FROM users WHERE telegram_id=%s", (telegram_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return False
    if row[0] == 0:
        cur.execute(
            "UPDATE users SET balance = balance + %s, bonus_given = 1 WHERE telegram_id=%s",
            (amount, telegram_id),
        )
        conn.commit()
        conn.close()
        return True
    conn.close()
    return False


def get_balance(telegram_id):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT balance FROM users WHERE telegram_id=%s", (telegram_id,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else 0


def add_balance(telegram_id, amount):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("UPDATE users SET balance = balance + %s WHERE telegram_id=%s", (amount, telegram_id))
    conn.commit()
    conn.close()


def record_task_done(telegram_id):
    today = datetime.date.today().isoformat()
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT tasks_done_date, tasks_done_count FROM users WHERE telegram_id=%s", (telegram_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return (0, False)
    tdate, tcount = row
    
    if tdate is None or tdate != today:
        tcount = 0
        tdate = today
    
    if tcount >= DAILY_TASK_LIMIT:
        conn.close()
        return (tcount, False)
    
    tcount += 1
    cur.execute("UPDATE users SET tasks_done_date=%s, tasks_done_count=%s WHERE telegram_id=%s", (today, tcount, telegram_id))
    conn.commit()
    conn.close()
    return (tcount, True)


def save_withdraw_request(telegram_id, method, account, amount):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO withdrawals (telegram_id, method, account, amount) VALUES (%s, %s, %s, %s) RETURNING id",
        (telegram_id, method, account, amount),
    )
    withdraw_id = cur.fetchone()[0] # Fetch the ID of the new row
    conn.commit()
    conn.close()
    return withdraw_id # Return the ID


def update_withdraw_status(withdraw_id, status):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(
        "UPDATE withdrawals SET status=%s, processed_at=NOW() WHERE id=%s",
        (status, withdraw_id),
    )
    conn.commit()
    conn.close()

def get_withdraw_details(withdraw_id):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT telegram_id, amount FROM withdrawals WHERE id=%s", (withdraw_id,))
    row = cur.fetchone()
    conn.close()
    return row 


# --- TELEGRAM HANDLERS (Same as before, with minor updates) ---

MAIN_MENU_KBD = ReplyKeyboardMarkup(
    [
        [KeyboardButton("💰 ইনকাম শুরু করুন"), KeyboardButton("👥 রেফারেল সিস্টেম")],
        [KeyboardButton("💸 উইথড্র"), KeyboardButton("ℹ️ টিউটোরিয়াল")],
    ],
    resize_keyboard=True,
)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_user = update.effective_user
    tid = tg_user.id
    args = context.args
    referred_by = None
    if args:
        try:
            referred_by = int(args[0])
            if referred_by == tid:
                 referred_by = None
        except Exception:
            referred_by = None

    add_user(tid, first_name=tg_user.first_name or "", username=tg_user.username or "", referred_by=referred_by)
    given = give_signup_bonus_if_needed(tid, amount=SIGNUP_BONUS)
    text = f"স্বাগতম, {tg_user.first_name or 'বন্ধু'}!\n\n"
    if given:
        text += f"🎉 আপনার এককালীন বোনাস Tk {SIGNUP_BONUS} দেওয়া হয়েছে।\n"
    else:
        text += "আপনি আগেই রেজিস্টার করেছেন বা বোনাস পেয়েছেন।\n"
    text += "\nনীচের মেনু থেকে শুরু করুন।"
    await update.message.reply_text(text, reply_markup=MAIN_MENU_KBD)


async def message_router(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text or ""
    tid = update.effective_user.id
    
    expect_withdraw_amount = context.user_data.get("expect_withdraw_amount")
    pending_withdraw_method = context.user_data.get("pending_withdraw_method")


    if text in ["💰 ইনকাম শুরু করুন", "👥 রেফারেল সিস্টেম", "💸 উইথড্র", "ℹ️ টিউটোরিয়াল"]:
        # Clear state if a main menu button is pressed
        context.user_data.clear()

    if text == "💰 ইনকাম শুরু করুন":
        
        balance = get_balance(tid)
        user_row = get_user(tid)
        tdone = user_row[9] if user_row else 0 # tasks_done_count (index 9)

        await update.message.reply_text(
            f"ড্যাশবোর্ড\n\nবর্তমান ব্যালেন্স: Tk {balance}\nআজকের টাস্ক সম্পন্ন: {tdone}/{DAILY_TASK_LIMIT}\nপ্রতি টাস্কের রিওয়ার্ড: Tk {TASK_REWARD}\n\nবাছাই করুন:",
            reply_markup=InlineKeyboardMarkup(
                [
                    [InlineKeyboardButton("বিজ্ঞাপন দেখুন (Watch Ad)", callback_data="watch_ad")],
                    [InlineKeyboardButton("Mini Web App খুলুন (Demo)", url="https://web.telegram.org/a/#-1001000000000")],
                ]
            ),
        )
    
    elif text == "👥 রেফারেল সিস্টেম":
        ref_link = f"t.me/{context.bot.username}?start={tid}"
        user = get_user(tid)
        referrals = user[7] if user else 0  # referrals_count
        await update.message.reply_text(
            f"আপনার রেফারেল লিঙ্ক:\n`{ref_link}`\n\nআপনি মোট {referrals} জনকে রেফার করেছেন।\nপ্রতিটি সফল রেফারে রেফারারকে Tk {REF_BONUS} বোনাস দেওয়া হয়।",
            parse_mode='Markdown',
            reply_markup=MAIN_MENU_KBD,
        )
    
    elif text == "💸 উইথড্র":
        balance = get_balance(tid)
        await update.message.reply_text(
            f"আপনার ব্যালেন্স: Tk {balance}\n\nনূ্যতম উইথড্র: Tk {MIN_WITHDRAW}\nকত টাকা উইথড্র করতে চান? (সংখ্যা লিখে পাঠান)\nউদাহরণ: {MIN_WITHDRAW}",
            reply_markup=ReplyKeyboardRemove(),
        )
        context.user_data["expect_withdraw_amount"] = True
    
    elif text == "ℹ️ টিউটোরিয়াল":
        await update.message.reply_text(
            f"টিউটোরিয়াল:\n\n1) **ইনকাম শুরু করুন** > **বিজ্ঞাপন দেখুন** > বিজ্ঞাপনটি দেখার পর 'I finished' ক্লিক করলে টাকা ক্রেডিট হবে।\n2) **রেফারেল সিস্টেম** থেকে আপনার লিঙ্কটি বন্ধুদের সাথে শেয়ার করুন।\n3) **উইথড্র** করতে নূন্যতম Tk {MIN_WITHDRAW} ব্যালেন্স প্রয়োজন।"
        )
    
    # --- State Handling for Withdraw ---
    
    elif expect_withdraw_amount and text.isdigit():
        context.user_data["expect_withdraw_amount"] = False
        amount = int(text)
        balance = get_balance(tid)
        
        if amount < MIN_WITHDRAW:
            await update.message.reply_text(f"নূ্যতম উইথড্র হল Tk {MIN_WITHDRAW}. আবার চেষ্টা করুন।", reply_markup=MAIN_MENU_KBD)
            context.user_data.clear()
        elif amount > balance:
            await update.message.reply_text("আপনার ব্যালেন্স পর্যাপ্ত নেই।", reply_markup=MAIN_MENU_KBD)
            context.user_data.clear()
        else:
            context.user_data["pending_withdraw_amount"] = amount
            
            await update.message.reply_text(
                "পেমেন্ট পদ্ধতি বাছাই করুন:\n1) Bkash\n2) Nagad\n3) Rocket\n\nউপরোক্ত নামগুলির মধ্যে যেকোনো একটি টাইপ করুন (উদাহরণ: Bkash)",
                reply_markup=ReplyKeyboardRemove(),
            )
            context.user_data["expect_withdraw_method"] = True
    
    elif context.user_data.get("expect_withdraw_method"):
        method = text.strip().lower()
        if method in ["bkash", "nagad", "rocket"]:
            context.user_data["expect_withdraw_method"] = False
            context.user_data["pending_withdraw_method"] = text.strip()
            
            await update.message.reply_text(f"আপনার {text.strip()} অ্যাকাউন্ট নম্বর/ইনফো দিন:", reply_markup=ReplyKeyboardRemove())
            context.user_data["expect_withdraw_account"] = True
        else:
            await update.message.reply_text("দয়া করে সঠিক পেমেন্ট পদ্ধতির নাম লিখুন (Bkash/Nagad/Rocket):")

    elif context.user_data.get("expect_withdraw_account"):
        context.user_data["expect_withdraw_account"] = False
        
        method = context.user_data.pop("pending_withdraw_method")
        account = text.strip()
        amount = context.user_data.pop("pending_withdraw_amount", 0)
        
        # Deduct balance immediately
        add_balance(tid, -amount)
        withdraw_id = save_withdraw_request(tid, method, account, amount)
        
        # notify admin
        try:
            await context.bot.send_message(
                chat_id=ADMIN_ID,
                text=f"🚨 নতুন উইথড্র রিকোয়েস্ট (ID: {withdraw_id})\n"
                     f"User: {update.effective_user.full_name} (`{tid}`)\n"
                     f"Amount: Tk {amount}\nMethod: {method}\nAccount: `{account}`\n\n"
                     f"Admin Action:",
                parse_mode='Markdown',
                reply_markup=InlineKeyboardMarkup(
                    [
                        [
                            InlineKeyboardButton("✅ Approve", callback_data=f"w_approve_{withdraw_id}"),
                            InlineKeyboardButton("❌ Reject", callback_data=f"w_reject_{withdraw_id}"),
                        ]
                    ]
                )
            )
        except Exception as e:
            logger.error("Failed to notify admin: %s", e)
        
        await update.message.reply_text(
            f"আপনার উইথড্র রিকোয়েস্ট (Tk {amount}) জমা হয়েছে।\nঅ্যাডমিন রিভিউ করবেন। ⏳", 
            reply_markup=MAIN_MENU_KBD
        )
        context.user_data.clear()
    
    else:
        if any(key in context.user_data for key in ["expect_withdraw_amount", "expect_withdraw_method", "expect_withdraw_account"]):
            context.user_data.clear()
            await update.message.reply_text("উইথড্রয়াল রিকোয়েস্ট বাতিল করা হয়েছে। মেনু থেকে আবার চেষ্টা করুন।", reply_markup=MAIN_MENU_KBD)
        else:
            await update.message.reply_text("আর্জি বুঝতে পারিনি। মেনু থেকে বাছাই করুন।", reply_markup=MAIN_MENU_KBD)


async def callback_query_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    await q.answer()
    data = q.data
    tid = q.from_user.id
    
    if data == "watch_ad":
        context.user_data.clear()

        await q.edit_message_text(
            "বিজ্ঞাপন লোড হচ্ছে... (অনুগ্রহ করে ১০ সেকেন্ড অপেক্ষা করুন)।\n\nবিজ্ঞাপন দেখা শেষ হলে 'I finished' চাপুন।",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("I finished - আমি দেখেছি", callback_data="ad_finished")]]),
        )
    
    elif data == "ad_finished":
        count, allowed = record_task_done(tid)
        
        if not allowed:
            await q.edit_message_text(f"আপনি আজকের সর্বোচ্চ টাস্ক সীমা **{DAILY_TASK_LIMIT}** ব্যবহার করেছেন।", 
                                      reply_markup=MAIN_MENU_KBD)
            return
        
        credit = TASK_REWARD
        add_balance(tid, credit)
        balance = get_balance(tid)
        
        await q.edit_message_text(
            f"ধন্যবাদ! Tk {credit} ক্রেডিট হয়েছে।\nআপনার বর্তমান ব্যালেন্স Tk {balance}।\n(আজকের টাস্ক সম্পন্ন: **{count}/{DAILY_TASK_LIMIT}**)", 
            reply_markup=MAIN_MENU_KBD
        )
        
    elif data.startswith("w_approve_") or data.startswith("w_reject_"):
        if tid != ADMIN_ID:
            await q.answer("আপনি অ্যাডমিন নন।")
            return
            
        action, withdraw_id = data.split('_')[1], int(data.split('_')[2])
        withdraw_details = get_withdraw_details(withdraw_id)
        
        if not withdraw_details:
             await q.edit_message_text("উইথড্রয়াল আইডি খুঁজে পাওয়া যায়নি।")
             return
             
        w_tid, w_amount = withdraw_details
        
        if action == "approve":
            update_withdraw_status(withdraw_id, "approved")
            status_text = "✅ অনুমোদিত (পেমেন্ট সম্পন্ন)"
            
            try:
                await context.bot.send_message(
                    chat_id=w_tid,
                    text=f"🎉 আপনার Tk {w_amount} উইথড্রয়াল রিকোয়েস্ট **অনুমোদিত (Approved)** হয়েছে এবং পেমেন্ট সম্পন্ন হয়েছে। ধন্যবাদ!"
                )
            except Exception:
                logger.error(f"Failed to notify user {w_tid} about approved withdraw {withdraw_id}")

        elif action == "reject":
            update_withdraw_status(withdraw_id, "rejected")
            status_text = "❌ বাতিল (ব্যালেন্স রিফান্ড)"
            
            add_balance(w_tid, w_amount)
            
            try:
                await context.bot.send_message(
                    chat_id=w_tid,
                    text=f"❌ দুঃখিত! আপনার Tk {w_amount} উইথড্রয়াল রিকোয়েস্ট **বাতিল (Rejected)** হয়েছে। কারণ জানতে অ্যাডমিনের সাথে যোগাযোগ করুন। আপনার ব্যালেন্স রিফান্ড করা হয়েছে।"
                )
            except Exception:
                logger.error(f"Failed to notify user {w_tid} about rejected withdraw {withdraw_id}")

        await q.edit_message_text(
            q.message.text + f"\n\n--- Processed ---\nStatus: {status_text} by Admin.",
            reply_markup=None
        )

    elif data == "noop":
        pass 
        
    else:
        await q.edit_message_text("অজানা অপশন।", reply_markup=MAIN_MENU_KBD)


async def admin_withdraws(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != ADMIN_ID:
        await update.message.reply_text("আপনি এটি চালাতে পারবেন না।")
        return
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT id, telegram_id, method, account, amount, status, created_at FROM withdrawals WHERE status='pending' ORDER BY created_at DESC")
    rows = cur.fetchall()
    conn.close()
    if not rows:
        await update.message.reply_text("No pending withdrawals.")
        return
        
    for r in rows:
        wid, tid, method, account, amount, status, created_at = r
        
        await update.message.reply_text(
            f"--- WID: {wid} ---\nUser: `{tid}`\nAmount: Tk {amount}\nMethod: {method}\nAccount: `{account}`\nRequested: {created_at.strftime('%Y-%m-%d %H:%M:%S')}",
            parse_mode='Markdown',
            reply_markup=InlineKeyboardMarkup(
                [
                    [
                        InlineKeyboardButton("✅ Approve", callback_data=f"w_approve_{wid}"),
                        InlineKeyboardButton("❌ Reject (Refund)", callback_data=f"w_reject_{wid}"),
                    ]
                ]
            )
        )
    await update.message.reply_text(f"Total {len(rows)} pending requests listed.")


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "এই বটের মেনুভিত্তিক কমান্ডগুলো ব্যবহার করুন।\n\n"
        "**কমান্ড:**\n"
        "/start - শুরু করুন\n"
        "/help - এই সাহায্য মেনুটি দেখায়\n\n"
        "**মূল কাজ:** ব্যালেন্স চেক, টাস্ক, উইথড্র করার জন্য মেনু বাটন ব্যবহার করুন।"
    )


def main():
    if not BOT_TOKEN:
        logger.error("BOT_TOKEN is not set in the .env file.")
        return

    init_db()
    
    if not ADMIN_ID:
         logger.warning("ADMIN_ID is not set in the .env file. Admin commands will not work.")

    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("withdraws", admin_withdraws, filters=filters.Chat(ADMIN_ID)))

    app.add_handler(CallbackQueryHandler(callback_query_handler))
    app.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), message_router))

    logger.info("SmartEarnbdBot started. Polling...")
    app.run_polling()


if __name__ == "__main__":
    main()
