// Import necessary modules
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
// Note: 'dotenv' is primarily for local development. Vercel handles environment variables directly.
// require('dotenv').config(); // You can keep this for local testing

// --- Google Sheets Authentication and Client Initialization ---

// IMPORTANT: For Vercel, store your credentials.json content as an environment variable.
// DO NOT commit the credentials.json file to your repository if it's private.
// If your repository is public, ABSOLUTELY DO NOT commit it.
// One common approach is to stringify the JSON content and store it in a Vercel environment variable.
let googleAuthClient;

async function initializeGoogleAuth() {
    if (googleAuthClient) {
        return googleAuthClient;
    }
    try {
        // Prefer loading from environment variable in Vercel
        const credentialsJsonString = process.env.GOOGLE_CREDENTIALS_JSON;
        if (!credentialsJsonString) {
            console.error("GOOGLE_CREDENTIALS_JSON environment variable is not set.");
            throw new Error("Google credentials are not configured.");
        }
        const credentials = JSON.parse(credentialsJsonString);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        googleAuthClient = await auth.getClient();
        return googleAuthClient;
    } catch (error) {
        console.error("Error initializing Google Auth:", error);
        // If running locally and GOOGLE_CREDENTIALS_JSON is not set,
        // you might fall back to reading from a local file for convenience.
        // However, this local file should NOT be deployed.
        if (process.env.NODE_ENV !== 'production' && !process.env.GOOGLE_CREDENTIALS_JSON) {
            console.warn("Falling back to local credentials.json for Google Auth (development only).");
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: "./credentials.json", // Path for local development
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                googleAuthClient = await auth.getClient();
                return googleAuthClient;
            } catch (localError) {
                console.error("Error initializing Google Auth with local keyFile:", localError);
                throw new Error("Failed to initialize Google Sheets client (local fallback failed).");
            }
        }
        throw new Error("Failed to initialize Google Sheets client.");
    }
}


/**
 * Asynchronously creates and returns a Google Sheets API client.
 * @returns {Promise<import('googleapis').sheets_v4.Sheets>} A promise that resolves to the Google Sheets API client.
 */
async function getGoogleSheetClient() {
    try {
        const authClient = await initializeGoogleAuth();
        return google.sheets({
            version: 'v4',
            auth: authClient,
        });
    } catch (error) {
        // Error is already logged in initializeGoogleAuth if it originated there
        console.error("Error creating Google Sheet client instance:", error.message);
        throw new Error("Failed to get Google Sheets client instance.");
    }
}

// --- Data Fetching Logic ---

const SPREADSHEET_ID = process.env.SHEET_ID; // From Vercel Environment Variables
const SHEET_RANGE = '!A2:F';

/**
 * Fetches a specific row from the Google Sheet based on date and ID.
 * @param {string} date - The date to search for (e.g., "DD.MM.YYYY").
 * @param {string} id - The ID to search for.
 * @returns {Promise<Array<string>|undefined>} A promise that resolves to the found row as an array, or undefined if not found.
 */
async function fetchRow(date, id) {
    if (!SPREADSHEET_ID) {
        console.error("SPREADSHEET_ID environment variable is not set.");
        return undefined;
    }
    try {
        const sheets = await getGoogleSheetClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "Свод ФОТ (адрес почты)" + SHEET_RANGE, // Make sure sheet name is correct
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log("No data found in the sheet.");
            return undefined;
        }
        // Find the row where the ID (column 3, index 2) and date (column 4, index 3) match
        // Original code: row[2] for ID, row[3] for date.
        // Column C is index 2 (ID), Column D is index 3 (Date)
        const foundRow = rows.find(row =>
            row && row.length > 3 && // Ensure row and relevant columns exist
            row[2] && row[2].toLowerCase() === id.toLowerCase() &&
            row[3] === date
        );
        return foundRow;

    } catch (error) {
        console.error(`Error fetching row for date "${date}" and ID "${id}":`, error.message);
        // Check for specific auth errors that might have slipped through
        if (error.message && error.message.includes("credential")) {
             console.error("This might be a Google API authentication or permission issue.");
        }
        return undefined;
    }
}

// --- Telegraf Bot Setup and Logic ---

const BOT_TOKEN = process.env.BOT_TOKEN; // From Vercel Environment Variables
if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN environment variable is not set!");
}
const bot = new Telegraf(BOT_TOKEN);

// In-memory store for user session states.
// WARNING: This will NOT work reliably in a serverless environment
// because each invocation can be a new instance.
// For Vercel, you need a persistent store like Vercel KV, Upstash Redis,
// a traditional database, or Firestore.
// For simplicity in this example, we'll keep it, but highlight this limitation.
const userSessionStore = {}; // <<-- THIS IS PROBLEMATIC FOR SERVERLESS
// Consider replacing with Vercel KV:
// const { kv } = require('@vercel/kv');
// async function getSession(userId) { return kv.get(`session:${userId}`); }
// async function setSession(userId, data) { return kv.set(`session:${userId}`, data); }
// async function deleteSession(userId) { return kv.del(`session:${userId}`); }


// Handler for the /start command
bot.start(async (ctx) => {
    // For Vercel KV example:
    // await setSession(ctx.from.id, { stage: 'awaiting_date' });
    userSessionStore[ctx.from.id] = { stage: 'awaiting_date' };
    await ctx.reply("Добро пожаловать! Пожалуйста, введите дату в формате ДД.ММ.ГГГГ или ДД/ММ/ГГ:");
});

// Handler for incoming messages
bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    // For Vercel KV example:
    // const userStatus = await getSession(userId);
    const userStatus = userSessionStore[userId];

    if (!userStatus) {
        await ctx.reply("Пожалуйста, начните сначала, введя команду /start.");
        return;
    }

    const messageText = ctx.text ? ctx.text.trim() : ''; // Ensure ctx.text exists

    switch (userStatus.stage) {
        case 'awaiting_date':
            const dateParts = messageText.split(/[.,/]/);
            if (dateParts.length === 3) {
                let [day, month, year] = dateParts;

                day = day.padStart(2, '0');
                month = month.padStart(2, '0');

                if (year.length === 2) {
                    year = `20${year}`;
                } else if (year.length !== 4) {
                    await ctx.reply("Неверный формат года. Пожалуйста, введите дату в формате ДД.ММ.ГГГГ или ДД/ММ/ГГ (например, 01.01.2023 или 01/01/23).");
                    return;
                }

                const parsedDate = new Date(`${year}-${month}-${day}`);
                // Check if day and month are within typical ranges and if the date object is valid
                const dayInt = parseInt(day, 10);
                const monthInt = parseInt(month, 10); // Month is 0-indexed in JS Date, but 1-indexed in input
                const yearInt = parseInt(year, 10);

                if (isNaN(parsedDate.getTime()) ||
                    parsedDate.getDate() !== dayInt ||
                    parsedDate.getMonth() !== monthInt - 1 || // Adjust for 0-indexed month
                    parsedDate.getFullYear() !== yearInt ||
                    dayInt < 1 || dayInt > 31 || monthInt < 1 || monthInt > 12) {
                    await ctx.reply("Неверная дата. Пожалуйста, введите дату в формате ДД.ММ.ГГГГ или ДД/ММ/ГГ (например, 01.01.2023 или 01/01/23).");
                    return;
                }

                userStatus.date = `${day}.${month}.${year}`;
                userStatus.stage = 'awaiting_table_id';
                // For Vercel KV example:
                // await setSession(userId, userStatus);
                userSessionStore[userId] = userStatus; // Update session
                await ctx.reply("Дата принята. Теперь введите Табельный номер:");
            } else {
                await ctx.reply("Неверный формат даты. Пожалуйста, введите дату в формате ДД.ММ.ГГГГ или ДД/ММ/ГГ (например, 01.01.2023 или 01/01/23).");
            }
            break;

        case 'awaiting_table_id':
            userStatus.tableID = messageText;

            try {
                const row = await fetchRow(userStatus.date, userStatus.tableID);

                // Original logic: row[4] is Telegram username (column E), row[5] is payment (column F)
                // Ensure row and expected data exist. Indices: ID=2, Date=3, TG_Username=4, Payment=5
                if (row) {
                    const telegramUsernameInSheet = row[4] ? String(row[4]).trim() : '';
                    const paymentAmount = row[5]; // Column F

                    if (telegramUsernameInSheet && telegramUsernameInSheet.startsWith('@') && telegramUsernameInSheet.slice(1).toLowerCase() !== ctx.from.username.toLowerCase()) {
                        await ctx.reply("Аккаунт Telegram не соответствует табельному номеру.");
                    } else if (paymentAmount !== undefined && paymentAmount !== null && paymentAmount !== '') {
                        await ctx.reply(`Запись найдена: Оплата ${paymentAmount}₽`);
                    } else {
                         // This case means the row was found but payment amount is missing/empty
                        await ctx.reply(`Запись найдена для даты ${userStatus.date} и табельного номера ${userStatus.tableID}, но информация об оплате отсутствует.`);
                    }
                } else {
                    await ctx.reply(`Не удалось найти запись для даты ${userStatus.date} и табельного номера ${userStatus.tableID}.`);
                }
            } catch (error) {
                console.error("Error processing table_id stage:", error);
                await ctx.reply("Произошла ошибка при поиске данных. Попробуйте позже.");
            }

            // Clear the user's session state
            // For Vercel KV example:
            // await deleteSession(userId);
            delete userSessionStore[userId];
            break;

        default:
            await ctx.reply("Произошла непредвиденная ошибка. Пожалуйста, начните сначала с /start.");
            // For Vercel KV example:
            // await deleteSession(userId);
            delete userSessionStore[userId];
            break;
    }
});

// --- Vercel Serverless Handler ---
/**
 * This is the main handler for Vercel.
 * It will be invoked by Vercel when Telegram sends an update to your webhook URL.
 */
module.exports = async (req, res) => {
    if (!BOT_TOKEN) {
        console.error("FATAL: BOT_TOKEN is not set. Cannot process request.");
        res.status(500).send("Bot token not configured.");
        return;
    }
    try {
        // Make sure to initialize Google Auth if it hasn't been already
        // This is important because serverless functions can be cold-started.
        await initializeGoogleAuth();

        // Telegraf's webhookCallback will parse the request and trigger the bot's listeners.
        // The second argument is the path for the webhook. Vercel handles routing,
        // so often just '/' is fine here if your function is at /api/bot.
        // Or, if you set a specific webhook path with Telegram, match it.
        const webhookCallback = bot.webhookCallback(`/${process.env.VERCEL_URL ? '' : 'api/index'}`); // Path relative to your domain

        await webhookCallback(req, res);

    } catch (error) {
        console.error('Error handling Telegraf update:', error);
        // Send a generic error response. Avoid leaking too much detail.
        if (!res.headersSent) {
            res.status(500).send('Error processing your request');
        }
    }
};

// --- Local Development (Optional) ---
// This part is for running the bot locally using polling, NOT for Vercel deployment.
// Vercel uses the module.exports handler above.
if (process.env.NODE_ENV !== 'production' && process.env.LOCAL_DEV_MODE === 'true') {
    (async () => {
        try {
            await initializeGoogleAuth(); // Initialize for local dev
            console.log("Attempting to launch bot locally with polling...");
            await bot.launch();
            console.log("Telegram bot started successfully locally with polling.");

            process.once('SIGINT', () => {
                bot.stop('SIGINT');
                console.log("Bot stopped due to SIGINT (local).");
                process.exit(0);
            });
            process.once('SIGTERM', () => {
                bot.stop('SIGTERM');
                console.log("Bot stopped due to SIGTERM (local).");
                process.exit(0);
            });
        } catch (e) {
            console.error("Failed to launch bot locally:", e);
        }
    })();
}

// IMPORTANT: After deploying to Vercel, you need to set the webhook for your bot.
// You can do this once using a curl command or a small script:
// curl -F "url=https://YOUR_VERCEL_APP_DOMAIN/api/bot" https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook
// Replace YOUR_VERCEL_APP_DOMAIN with your Vercel deployment URL and YOUR_BOT_TOKEN with your bot's token.
// Example: https://my-telegram-bot.vercel.app/api/bot
//
// To remove a webhook (e.g., to switch back to polling locally):
// curl https://api.telegram.org/botYOUR_BOT_TOKEN/deleteWebhook