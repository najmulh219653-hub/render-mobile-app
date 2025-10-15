import express from 'express';
import * as path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config'; // To load TELEGRAM_BOT_TOKEN locally
import { Telegraf } from 'telegraf'; // Telegraf library for bot logic

// --- Express Server Setup ---
const app = express();
// Render automatically provides a PORT environment variable
const PORT = process.env.PORT || 3000; 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Access the bot token from environment variables (set in Render dashboard)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  // This error will appear in Render logs if the token is missing
  console.error('❌ ERROR: TELEGRAM_BOT_TOKEN is not set in environment variables. Bot will not function.');
  process.exit(1);
}

// Initialize Telegraf bot
const bot = new Telegraf(BOT_TOKEN);

// --- Bot Logic ---

// Responds to the /start command
bot.start((ctx) => {
  ctx.reply('👋 নমস্কার! আপনার Render ডিপ্লয় করা Telegram Bot সফলভাবে চলছে! আপনি এখন এখানে আপনার কাস্টম লজিক যুক্ত করতে পারেন।');
  console.log(`[BOT] Received /start from ${ctx.from.id}`);
});

// Simple text handler (responds to any non-command text)
bot.on('text', (ctx) => {
  ctx.reply(`আপনি লিখেছেন: "${ctx.message.text}"। আমি একটি সাধারণ রিপ্লাই দিচ্ছি।`);
});

// --- Middleware and Routing ---

// 1. Static file serving (for public/index.html)
app.use(express.static(path.join(__dirname, 'public')));

// 2. Body Parser for Webhook
app.use(express.json());

// 3. Telegram Webhook Setup (CRITICAL FOR RENDER)
// Telegram sends updates to this path: /BOT_TOKEN
app.post(`/${BOT_TOKEN}`, (req, res) => {
  // Pass the incoming update to the Telegraf bot handler
  bot.handleUpdate(req.body, res);
  // Send 200 OK immediately to avoid Telegram retries
  res.sendStatus(200); 
});

// 4. Health Check / Test Route
app.get('/test', (req, res) => {
  const tokenDisplay = BOT_TOKEN.substring(0, 4) + '...' + BOT_TOKEN.substring(BOT_TOKEN.length - 4);
  res.json({
    status: 'Running',
    message: 'Testing route is working correctly!',
    botTokenLoaded: tokenDisplay,
    port: PORT,
    webhookListener: `/${BOT_TOKEN}`
  });
});

// --- Server Start ---

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`[INFO] Bot ready to handle updates via webhook at: /${BOT_TOKEN}`);
});
