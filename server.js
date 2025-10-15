// Import necessary modules using ES Module syntax
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// --- ES Module Path Setup ---
// Define __dirname equivalent for ES Modules to correctly handle file paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file (for local testing only)
// This will pull TELEGRAM_BOT_TOKEN if running locally.
dotenv.config();

// --- Initialization ---
const app = express();

// Set the port. Render automatically provides a PORT environment variable.
const PORT = process.env.PORT || 3000;

// Get the Bot Token from environment variables (from Render or .env)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// --- Middleware ---
// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files (like index.html, CSS, images) from the 'public' directory
// When a user visits the root URL ('/'), Express serves 'public/index.html'
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes (API Endpoints) ---

// A simple test API route
app.get('/test', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    message: 'Testing route is working correctly!',
    port: PORT
  });
});

// NOTE: You would integrate your actual Telegram bot logic here.
// Example: Setting up a webhook to handle messages from Telegram
/*
app.post('/webhook', (req, res) => {
    // Process the incoming Telegram update (req.body)
    console.log('Received Telegram update:', req.body);
    // Respond quickly to Telegram to avoid timeouts
    res.status(200).send('OK'); 
});
*/

// --- Server Start ---

app.listen(PORT, () => {
  console.log(`✅ Express Server is listening on port ${PORT}`);
  
  // Confirmation message for Bot Token loading
  if (BOT_TOKEN) {
    // Display a masked version of the token for security in the console
    const tokenDisplay = BOT_TOKEN.substring(0, 4) + '...' + BOT_TOKEN.substring(BOT_TOKEN.length - 4);
    console.log(`🤖 Telegram Bot Token Loaded: ${tokenDisplay}`);
  } else {
    // Log an error if the token is missing
    console.error("❌ ERROR: TELEGRAM_BOT_TOKEN not found in environment variables!");
    console.error("   Please ensure you set the variable in Render's dashboard.");
  }
});
