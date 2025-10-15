import telegram
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters
import datetime
import logging
import os
import sys
import psycopg2
from psycopg2 import sql

# ⭐ লগিং সেটআপ ⭐
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

# --- ১. আপনার তথ্য দিন (SETTINGS) ---

# ⭐ টোকেন ও আইডি Render Environment Variables থেকে নেওয়া হচ্ছে ⭐
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN") 
try:
    ADMIN_USER_ID = int(os.environ.get("ADMIN_USER_ID"))
except (TypeError, ValueError):
    # WARNING: এটি আপনার সঠিক অ্যাডমিন আইডি দিয়ে প্রতিস্থাপন করা নিশ্চিত করুন!
    ADMIN_USER_ID = 12345678 
    
# ⭐ PostgreSQL সংযোগের ভেরিয়েবল ⭐
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    logger.error("❌ DATABASE_URL এনভায়রনমেন্ট ভেরিয়েবলে পাওয়া যায়নি।")


# ✅ আপনার Adsterra Smart Link
ADSTERRA_DIRECT_LINK = "https://roughlydispleasureslayer.com/ykawxa7tnr?key=bacb6ca047e4fabf73e54c2eaf85b2a5" 
TASK_LANDING_PAGE = "https://newspaper.42web.io"

# --- ⭐ চ্যানেল সেটিংস ⭐ ---
CHANNEL_USERNAME = "@EarnQuickOfficial"
CHANNEL_INVITE_LINK = "https://t.me/EarnQuickOfficial"

# --- ⭐ পয়েন্ট ও বোনাস সেটিংস ⭐ ---
DAILY_REWARD_POINTS = 10 
REFERRAL_JOIN_BONUS = 50 
REFERRAL_DAILY_COMMISSION = 2
MIN_WITHDRAW_POINTS = 1000 

# --- ২. ডেটাবেস ম্যানেজমেন্ট ফাংশন ---

def get_db_connection():
    """PostgreSQL ডেটাবেসের সাথে সংযোগ স্থাপন করে"""
    if not DATABASE_URL:
        return None
    try:
        # Render/Heroku-এর জন্য SSL প্রয়োজন
        conn = psycopg2.connect(DATABASE_URL, sslmode='require') 
        return conn
    except Exception as e:
        logger.error(f"ডেটাবেসে সংযোগ ব্যর্থ: {e}")
        return None

def init_db():
    """ইউজার ডেটা টেবিল তৈরি করে"""
    conn = get_db_connection()
    if not conn: return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id BIGINT PRIMARY KEY,
                    username VARCHAR(255),
                    points INTEGER DEFAULT 0,
                    last_claim_date DATE,
                    referrer_id BIGINT,
                    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            """)
            conn.commit()
            logger.info("✅ PostgreSQL টেবিল সফলভাবে প্রস্তুত করা হয়েছে।")
    except Exception as e:
        logger.error(f"টেবিল তৈরিতে সমস্যা: {e}")
    finally:
        if conn: conn.close()

def get_user_data(user_id):
    """নির্দিষ্ট ইউজারের ডেটাবেস থেকে তথ্য লোড করে"""
    conn = get_db_connection()
    if not conn: return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, username, points, last_claim_date, referrer_id FROM users WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if row:
                return {
                    'user_id': row[0],
                    'username': row[1],
                    'points': row[2],
                    'last_claim_date': row[3],
                    'referrer_id': row[4]
                }
            return None
    except Exception as e:
        logger.error(f"ইউজার ডেটা লোড করতে সমস্যা: {e}")
        return None
    finally:
        if conn: conn.close()

def add_new_user(user_id, username, referrer_id=None):
    """নতুন ইউজারকে ডেটাবেসে যোগ করে"""
    conn = get_db_connection()
    if not conn: return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (user_id, username, referrer_id) VALUES (%s, %s, %s) ON CONFLICT (user_id) DO NOTHING",
                (user_id, username, referrer_id)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"নতুন ইউজার যোগ করতে সমস্যা: {e}")
    finally:
        if conn: conn.close()

def update_user_points(user_id, points_change, last_claim_date=None):
    """ইউজারের পয়েন্ট আপডেট করে এবং ঐচ্ছিকভাবে ক্লেমের তারিখ সেট করে"""
    conn = get_db_connection()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            if last_claim_date:
                cur.execute(
                    "UPDATE users SET points = points + %s, last_claim_date = %s WHERE user_id = %s",
                    (points_change, last_claim_date, user_id)
                )
            else:
                cur.execute(
                    "UPDATE users SET points = points + %s WHERE user_id = %s",
                    (points_change, user_id)
                )
            conn.commit()
            return cur.rowcount > 0
    except Exception as e:
        logger.error(f"পয়েন্ট আপডেটে সমস্যা: {e}")
        return False
    finally:
        if conn: conn.close()
        
# --- অ্যাডমিন ডেটাবেস ফাংশন ---

def get_bot_stats():
    """মোট ইউজার সংখ্যা এবং মোট পয়েন্ট বের করে"""
    conn = get_db_connection()
    if not conn: return {'total_users': 0, 'total_points': 0}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(user_id) AS total_users, COALESCE(SUM(points), 0) AS total_points FROM users;")
            row = cur.fetchone()
            if row:
                return {
                    'total_users': int(row[0]),
                    'total_points': int(row[1])
                }
            return {'total_users': 0, 'total_points': 0}
    except Exception as e:
        logger.error(f"বট পরিসংখ্যান লোড করতে সমস্যা: {e}")
        return {'total_users': 0, 'total_points': 0}
    finally:
        if conn: conn.close()

def get_user_id_list():
    """ডেটাবেসে থাকা সমস্ত ইউজারের ID বের করে"""
    conn = get_db_connection()
    if not conn: return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM users")
            rows = cur.fetchall()
            return [row[0] for row in rows]
    except Exception as e:
        logger.error(f"ইউজার ID তালিকা লোড করতে সমস্যা: {e}")
        return []
    finally:
        if conn: conn.close()


# --- ৩. সাহায্যকারী ফাংশন: চ্যানেল মেম্বারশিপ চেক ---

async def check_channel_member(context: ContextTypes.DEFAULT_TYPE, user_id):
    """ইউজার চ্যানেলে জয়েন করেছে কিনা তা পরীক্ষা করে"""
    try:
        member = await context.bot.get_chat_member(CHANNEL_USERNAME, user_id)
        return member.status in ['member', 'administrator', 'creator']
    except Exception as e:
        # বট যদি চ্যানেলের অ্যাডমিন না হয়, তবে এই এরর আসতে পারে।
        logger.warning(f"চ্যানেল সদস্যপদ পরীক্ষা করতে সমস্যা: {e}") 
        return False 

async def show_join_prompt(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """জয়েন করার শর্ত এবং বাটন দেখায়"""
    join_message = (
        f"⛔ **কাজ শুরু করার জন্য টেলিগ্রাম চ্যানেলে জয়েন করা আবশ্যক!**\n\n"
        f"অনুগ্রহ করে আমাদের অফিশিয়াল টেলিগ্রাম চ্যানেলে জয়েন করুন। জয়েন করার পরেই আপনি বটের মেনু ব্যবহার করতে পারবেন।"
    )
    
    join_keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("🔔 টেলিগ্রাম চ্যানেলে জয়েন করুন", url=CHANNEL_INVITE_LINK)],
        [InlineKeyboardButton("✅ জয়েন করেছি, আবার দেখুন", callback_data='check_join')]
    ])
    
    # Message type check to decide whether to edit or reply
    if update.callback_query:
        await update.callback_query.edit_message_text(join_message, reply_markup=join_keyboard, parse_mode=telegram.constants.ParseMode.MARKDOWN)
    elif update.message:
        await update.message.reply_text(join_message, reply_markup=join_keyboard, parse_mode=telegram.constants.ParseMode.MARKDOWN)


# --- ৪. কীবোর্ড তৈরি ---

def get_main_keyboard(user_data_row):
    """বটের প্রধান ইনলাইন কীবোর্ড তৈরি করে"""
    current_points = user_data_row.get('points', 0) if user_data_row else 0
    
    keyboard = [
        # --- ইনকাম ট্র্যাক ---
        [InlineKeyboardButton("💰 দৈনিক বোনাস ক্লেম করুন", callback_data='daily_reward')],
        [InlineKeyboardButton("📰 ট্র্যাক ১: আজকের খবর দেখুন", url=ADSTERRA_DIRECT_LINK)],
        [InlineKeyboardButton("🔗 ট্র্যাক ২: অ্যাপ লিঙ্ক দেখুন", url=TASK_LANDING_PAGE)],
        [InlineKeyboardButton("🧠 ট্র্যাক ৩: কুইজ খেলুন", url=TASK_LANDING_PAGE)],
        # --- অ্যাকাউন্ট ও উইথড্রয়াল ---
        [InlineKeyboardButton(f"📊 আমার ব্যালেন্স: {current_points} পয়েন্ট", callback_data='my_account')],
        [InlineKeyboardButton("💸 উইথড্রয়াল রিকোয়েস্ট", callback_data='withdraw_request')],
        # ⭐ হোম মেনু বাটন
        [InlineKeyboardButton("🏠 মূল মেনু", callback_data='start_menu_btn')], 
    ]
    return InlineKeyboardMarkup(keyboard)

# --- ৫. মূল ফাংশন (COMMAND HANDLERS) ---

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/start কমান্ড হ্যান্ডেল করে"""
    user_id = update.effective_user.id
    username = update.effective_user.first_name or "New User"
    
    # --- ⭐ চ্যানেল জয়েনিং শর্ত ---
    is_member = await check_channel_member(context, user_id)
    if not is_member:
        await show_join_prompt(update, context)
        return
    
    # --- ডেটা লোডিং ও রেফারেল হ্যান্ডলিং ---
    user_data_row = get_user_data(user_id)
    
    referrer_id = None
    if context.args and context.args[0].startswith('ref'):
        try:
            # রেফারেল আইডি যাচাই করা
            referrer_id_from_link = int(context.args[0][3:])
            # রেফারার যদি নিজেকে রেফার না করে এবং রেফারারের ডেটা পাওয়া যায়
            if referrer_id_from_link != user_id and get_user_data(referrer_id_from_link):
                referrer_id = referrer_id_from_link
        except ValueError:
            referrer_id = None
            
    # নতুন ইউজার হলে ডেটাবেসে যোগ করা
    if not user_data_row:
        add_new_user(user_id, username, referrer_id)
        user_data_row = get_user_data(user_id) # ডেটাবেস থেকে রি-লোড
        logger.info(f"New user registered: {user_id}. Referrer: {referrer_id}")
        
        # রেফারারকে জয়েনিং বোনাস দেওয়া (যদি থাকে)
        if referrer_id and referrer_id != user_id:
            if update_user_points(referrer_id, REFERRAL_JOIN_BONUS):
                logger.info(f"Referral bonus {REFERRAL_JOIN_BONUS} added to referrer {referrer_id}")
                try:
                    await context.bot.send_message(
                        chat_id=referrer_id, 
                        text=f"🎁 অভিনন্দন! আপনার রেফার করা নতুন ইউজার ({username}) জয়েন করেছেন। আপনি **{REFERRAL_JOIN_BONUS} বোনাস পয়েন্ট** পেয়েছেন।",
                        parse_mode=telegram.constants.ParseMode.MARKDOWN
                    )
                except telegram.error.BadRequest:
                    pass 

    welcome_message = (
        f"🎉 স্বাগতম, **{username}**!\n\n"
        "✅ আপনার চ্যানেল জয়েনিং সফল হয়েছে। এখন আপনি কাজ শুরু করতে পারেন।\n"
        "আপনার টেলিগ্রাম আয়ের স্মার্ট চাবিকাঠি এটাই! নিচের মেনু ব্যবহার করে আপনার ইনকাম শুরু করুন।"
    )
    
    reply_markup = get_main_keyboard(user_data_row)
    
    if update.callback_query:
        await update.callback_query.edit_message_text(welcome_message, reply_markup=reply_markup, parse_mode=telegram.constants.ParseMode.MARKDOWN)
    else:
        await update.message.reply_text(welcome_message, reply_markup=reply_markup, parse_mode=telegram.constants.ParseMode.MARKDOWN)


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """ইনলাইন বাটনে ক্লিক হ্যান্ডেল করে"""
    query = update.callback_query
    await query.answer()

    user_id = query.from_user.id
    
    # --- ⭐ চ্যানেল জয়েনিং চেক ---
    is_member = await check_channel_member(context, user_id)
    if not is_member and query.data not in ['check_join', 'start_menu_btn']:
        await show_join_prompt(query, context)
        return
    
    # ডেটা লোড করা
    user_data_row = get_user_data(user_id)
    if not user_data_row:
        await query.edit_message_text("⛔ আপনার ডেটা খুঁজে পাওয়া যায়নি। দয়া করে /start লিখে বটটি আবার শুরু করুন।", 
                                      reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🏠 মূল মেনু", callback_data='start_menu_btn')]]),
                                      parse_mode=telegram.constants.ParseMode.MARKDOWN)
        return

    # --- জয়েন চেক বাটন ---
    if query.data == 'check_join':
        is_member_after_check = await check_channel_member(context, user_id)
        if is_member_after_check:
            await start(query, context) 
        else:
            await show_join_prompt(query, context)
        return
            
    # --- দৈনিক রিওয়ার্ড ক্লেম ---
    elif query.data == 'daily_reward':
        today = datetime.date.today()
        last_claim = user_data_row.get('last_claim_date')

        if last_claim and last_claim == today:
            message = "❌ আপনি আজকের রিওয়ার্ড ইতিমধ্যেই ক্লেম করেছেন। আগামীকাল আবার চেষ্টা করুন।"
        else:
            # পয়েন্ট যোগ ও ডেটাবেসে সংরক্ষণ
            if update_user_points(user_id, DAILY_REWARD_POINTS, today):
                
                # রেফারারকে কমিশন দেওয়া
                referrer_id = user_data_row.get('referrer_id')
                if referrer_id:
                    if update_user_points(referrer_id, REFERRAL_DAILY_COMMISSION):
                        try:
                            await context.bot.send_message(
                                chat_id=referrer_id, 
                                text=f"🎁 কমিশন! আপনার রেফার করা ইউজার আজ দৈনিক রিওয়ার্ড ক্লেম করেছেন। আপনি **{REFERRAL_DAILY_COMMISSION} পয়েন্ট** পেলেন।",
                                parse_mode=telegram.constants.ParseMode.MARKDOWN
                            )
                        except telegram.error.BadRequest:
                            pass 

                # আপডেট করা ডেটাবেস থেকে পয়েন্ট পুনরায় লোড
                updated_user_data = get_user_data(user_id)
                current_points = updated_user_data['points']
                
                message = (
                    f"✅ সফল! আপনি আজ **{DAILY_REWARD_POINTS} পয়েন্ট** পেলেন।\n"
                    f"আয় দ্বিগুণ করতে অন্যান্য ট্র্যাকে কাজ করুন।\n"
                    f"আপনার বর্তমান ব্যালেন্স: {current_points} পয়েন্ট।"
                )
            else:
                 message = "❌ পয়েন্ট আপডেটে ত্রুটি হয়েছে। পরে চেষ্টা করুন।"


        await query.edit_message_text(message, reply_markup=get_main_keyboard(get_user_data(user_id)), parse_mode=telegram.constants.ParseMode.MARKDOWN)
    
    # --- আমার অ্যাকাউন্ট ---
    elif query.data == 'my_account':
        bot_username = context.bot.username if context.bot.username else "Your_Bot_Username"
        referral_link = f"https://t.me/{bot_username}?start=ref{user_id}"
        
        current_points = user_data_row['points']

        account_info = (
            "📊 **আমার অ্যাকাউন্ট ও রিফারেল**\n"
            f"পয়েন্ট: **{current_points}**\n"
            f"উইথড্র করার জন্য প্রয়োজন: {MIN_WITHDRAW_POINTS} পয়েন্ট\n\n"
            "🔗 আপনার রিফারেল লিংক: \n"
            f"`{referral_link}`\n\n"
            f"আপনার রেফারেন্সে কেউ জয়েন করলে **{REFERRAL_JOIN_BONUS} পয়েন্ট** এবং সে দৈনিক রিওয়ার্ড ক্লেম করলে আপনি **{REFERRAL_DAILY_COMMISSION} পয়েন্ট** কমিশন পাবেন!"
        )
        
        back_to_main = InlineKeyboardMarkup([
            [InlineKeyboardButton("🏠 মূল মেনু", callback_data='start_menu_btn')]
        ])
        
        await query.edit_message_text(account_info, reply_markup=back_to_main, parse_mode=telegram.constants.ParseMode.MARKDOWN)

    # --- উইথড্রয়াল ---
    elif query.data == 'withdraw_request':
        current_points = user_data_row['points']
        
        message = ""
        if current_points >= MIN_WITHDRAW_POINTS:
            message = (
                f"💸 **উইথড্রয়াল রিকোয়েস্ট**\n\n"
                f"আপনার পয়েন্ট: {current_points}\n"
                f"অনুগ্রহ করে আপনার **পেমেন্ট পদ্ধতি** (বিকাশ/নগদ/রকেট/অন্যান্য) এবং **আইডি** লিখে মেসেজ করুন। উদাহরণ:\n"
                "`বিকাশ, 01XXXXXXXXX`\n"
                "`নগদ, 01XXXXXXXXX`\n"
                "`রকেট, 01XXXXXXXXX`\n\n"
                "আমাদের অ্যাডমিন আপনার অনুরোধটি দ্রুত রিভিউ করবে।"
            )
        else:
            message = (
                f"❌ দুঃখিত, উইথড্র করার জন্য আপনার কমপক্ষে **{MIN_WITHDRAW_POINTS} পয়েন্ট** প্রয়োজন।\n"
                f"আপনার বর্তমান পয়েন্ট: {current_points}"
            )

        back_to_main = InlineKeyboardMarkup([
            [InlineKeyboardButton("🏠 মূল মেনু", callback_data='start_menu_btn')]
        ])
        
        await query.edit_message_text(message, reply_markup=back_to_main, parse_mode=telegram.constants.ParseMode.MARKDOWN)

    # --- মেনু বাটন ---
    elif query.data == 'start_menu_btn':
        await start(query, context)

# --- ৬. অ্যাডমিন কমান্ড হ্যান্ডলার ---

async def admin_stats(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """মোট ইউজার সংখ্যা এবং পয়েন্ট দেখায়"""
    user_id = update.effective_user.id
    if user_id != ADMIN_USER_ID:
        await update.message.reply_text("❌ এই কমান্ডটি শুধুমাত্র অ্যাডমিনের জন্য।")
        return

    stats = get_bot_stats()
    
    stats_message = (
        f"📊 **বট পরিসংখ্যান (Admin)**\n"
        f"মোট ইউজার সংখ্যা: **{stats['total_users']}**\n"
        f"ডেটাবেসে মোট পয়েন্ট: **{stats['total_points']}**"
    )
    await update.message.reply_text(stats_message, parse_mode=telegram.constants.ParseMode.MARKDOWN)

async def admin_broadcast(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """সমস্ত ইউজারকে মেসেজ পাঠায়"""
    user_id = update.effective_user.id
    if user_id != ADMIN_USER_ID:
        await update.message.reply_text("❌ এই কমান্ডটি শুধুমাত্র অ্যাডমিনের জন্য।")
        return
    
    # Check if a message is provided after /broadcast
    if not context.args:
        await update.message.reply_text("❌ অ্যাডমিন কমান্ডের ব্যবহার: /broadcast <মেসেজ>")
        return
        
    # Get the full message text after the command
    broadcast_message = update.message.text.replace("/broadcast", "", 1).strip()
    
    user_ids = get_user_id_list()
    sent_count = 0
    blocked_count = 0

    await update.message.reply_text(f"📢 সমস্ত {len(user_ids)} ইউজারের কাছে মেসেজ পাঠানো শুরু হচ্ছে...")

    for target_id in user_ids:
        try:
            # Send message with Markdown formatting
            await context.bot.send_message(chat_id=target_id, text=broadcast_message, parse_mode=telegram.constants.ParseMode.MARKDOWN)
            sent_count += 1
        except telegram.error.Forbidden:
            # User blocked the bot
            blocked_count += 1
        except Exception as e:
            logger.error(f"Error sending broadcast message to user {target_id}: {e}")

    result_message = (
        f"✅ ব্রডকাস্ট সফলভাবে শেষ হয়েছে।\n"
        f"মোট ইউজার: {len(user_ids)}\n"
        f"সফলভাবে পাঠানো হয়েছে: {sent_count}\n"
        f"বট ব্লক করেছে: {blocked_count}"
    )
    await update.message.reply_text(result_message)


# --- ৭. সাধারণ মেসেজ হ্যান্ডলার ---

async def message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """সাধারণ মেসেজ এবং অ্যাডমিন কমান্ড হ্যান্ডেল করে"""
    user_id = update.effective_user.id
    text = update.message.text
    
    # ডেটা লোড করা
    user_data_row = get_user_data(user_id)
    if not user_data_row:
        # যদি ডেটাবেসে না থাকে, তবে /start করতে বলা
        await update.message.reply_text("⛔ আপনার ডেটা খুঁজে পাওয়া যায়নি। দয়া করে /start লিখে বটটি আবার শুরু করুন।")
        return
        
    # --- ⭐ অ্যাডমিন কমান্ড: /addpoints ⭐ ---
    if user_id == ADMIN_USER_ID and text.startswith('/addpoints '):
        try:
            parts = text.split()
            target_id = int(parts[1])
            points = int(parts[2])
            
            if update_user_points(target_id, points):
                target_data = get_user_data(target_id)
                current_points = target_data['points'] if target_data else 0

                logger.info(f"Admin {user_id} added {points} to user {target_id}. New points: {current_points}")
                
                await update.message.reply_text(f"✅ সফল! ইউজার {target_id} এর অ্যাকাউন্টে {points} পয়েন্ট যোগ করা হলো। বর্তমান পয়েন্ট: {current_points}")
                
                # টার্গেট ইউজারকে নোটিফিকেশন পাঠানো
                try:
                    await context.bot.send_message(
                        chat_id=target_id, 
                        text=f"🎉 অভিনন্দন! অ্যাডমিন আপনার অ্যাকাউন্টে **{points} পয়েন্ট** যোগ করেছেন। আপনার বর্তমান ব্যালেন্স: **{current_points}**",
                        parse_mode=telegram.constants.ParseMode.MARKDOWN
                    )
                except telegram.error.BadRequest:
                    pass 
            else:
                await update.message.reply_text("❌ ত্রুটি: টার্গেট ইউজার ID খুঁজে পাওয়া যায়নি বা ডেটাবেস ত্রুটি।")
                
        except (ValueError, IndexError):
            await update.message.reply_text("❌ অ্যাডমিন কমান্ডের ব্যবহার: /addpoints <ইউজার_আইডি> <পয়েন্ট>")
            
    # --- ⭐ অ্যাডমিন কমান্ড: /checkuser ⭐ ---
    elif user_id == ADMIN_USER_ID and text.startswith('/checkuser '):
        try:
            target_id = int(text.split()[1])
            target_data = get_user_data(target_id)
            
            if target_data:
                info = (
                    f"👤 ইউজার তথ্য ({target_id}):\n"
                    f"নাম: {target_data.get('username', 'N/A')}\n"
                    f"পয়েন্ট: {target_data['points']}\n"
                    f"শেষ ক্লেম: {target_data['last_claim_date']}\n"
                    f"রেফারার ID: {target_data['referrer_id']}"
                )
                await update.message.reply_text(info)
            else:
                await update.message.reply_text("❌ ত্রুটি: টার্গেট ইউজার ID খুঁজে পাওয়া যায়নি।")
        except (ValueError, IndexError):
            await update.message.reply_text("❌ অ্যাডমিন কমান্ডের ব্যবহার: /checkuser <ইউজার_আইডি>")

    # --- সাধারণ মেসেজ (উইথড্রয়াল রিকোয়েস্ট) ---
    else:
        # উইথড্রয়াল রিকোয়েস্ট অ্যাডমিনকে ফরোয়ার্ড করার জন্য
        await context.bot.send_message(
            chat_id=ADMIN_USER_ID,
            text=f"💸 **নতুন উইথড্রয়াল রিকোয়েস্ট!**\n"
                 f"ইউজার ID: `{user_id}`\n"
                 f"বর্তমান পয়েন্ট: {user_data_row.get('points', 0)}\n"
                 f"মেসেজ: {text}",
            parse_mode=telegram.constants.ParseMode.MARKDOWN
        )

        await update.message.reply_text(
            "আপনার মেসেজটি (সম্ভাব্য উইথড্রয়াল রিকোয়েস্ট) অ্যাডমিনকে পাঠানো হয়েছে। এটি ম্যানুয়ালি দেখা হচ্ছে।\n"
            "অন্যান্য অপশনের জন্য মেনু ব্যবহার করুন:",
            reply_markup=get_main_keyboard(user_data_row)
        )

# --- ৮. বট চালানো (MAIN EXECUTION) ---

def main() -> None:
    """বট অ্যাপ্লিকেশন শুরু করে"""
    
    if not TELEGRAM_BOT_TOKEN or not DATABASE_URL:
        logger.error("❌ পরিবেশ ভেরিয়েবল সেট করুন (TELEGRAM_BOT_TOKEN, DATABASE_URL)।")
        # Ensure the application doesn't proceed without tokens
        sys.exit(1) 
    
    # ডেটাবেস ইনিশিয়ালাইজেশন
    init_db()

    logger.info("Starting Smart Earn Bot with PostgreSQL...") 
    
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    # --- হ্যান্ডলার যোগ করা ---
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CallbackQueryHandler(button_callback))

    # অ্যাডমিন কমান্ড হ্যান্ডলার
    application.add_handler(CommandHandler("stats", admin_stats))
    application.add_handler(CommandHandler("broadcast", admin_broadcast))
    application.add_handler(CommandHandler("addpoints", message_handler)) # Using message_handler for parsing
    application.add_handler(CommandHandler("checkuser", message_handler)) # Using message_handler for parsing

    # মেসেজ হ্যান্ডলার (অন্যান্য টেক্সট মেসেজের জন্য, যা উইথড্রয়াল রিকোয়েস্ট হিসাবে বিবেচিত)
    application.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), message_handler)) 

    print("✅ Smart Earn Bot Running... Check console for logs.")
    
    # For long polling (সাধারণত Render/Railway-এ ব্যবহৃত হয়, কিন্তু ওয়েবহুক-এর জন্য এটি উপযুক্ত নয়)
    # যেহেতু আপনি Node.js থেকে Python-এ এসেছেন এবং Render-এ deployment করতে চান,
    # যদি আপনি ওয়েবহুক ব্যবহার করতে না পারেন তবে এই পদ্ধতিটিই সেরা:
    application.run_polling(poll_interval=3)

if __name__ == '__main__':
    # Add an exception handler for the main function
    try:
        main()
    except Exception as e:
        logger.critical(f"Fatal error in main execution: {e}")
        sys.exit(1)
```eof

---

## 💡 মনে রাখবেন

1.  **এনভায়রনমেন্ট ভেরিয়েবল:** নিশ্চিত করুন যে Render-এ **`TELEGRAM_BOT_TOKEN`**, **`DATABASE_URL`** এবং আপনার **`ADMIN_USER_ID`** সঠিকভাবে সেট করা আছে।
2.  **পাইথন প্যাকেজ:** আপনার `requirements.txt` ফাইলে নিম্নলিখিত প্যাকেজগুলি অবশ্যই থাকতে হবে:
    ```
    python-telegram-bot
    psycopg2-binary
    ```
3.  **ডিপ্লয়মেন্ট:** এই `server.py` ফাইলটি আপনার রিপোজিটরিতে যোগ করুন এবং ডিপ্লয় করুন। এটি এখন **লং পোলিং (long polling)** মোডে কাজ করার জন্য কনফিগার করা হয়েছে, যা ছোট অ্যাপ্লিকেশনের জন্য Render-এ উপযুক্ত।
