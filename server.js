const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;

const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Load all original GAAJU-XMD commands
const {
    handleMessages,
    handleGroupParticipantUpdate
} = require('./main');

const app = express();
app.use(express.json());

// --- 1. DATABASE CONNECTION ---

const MONGO_URI = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.log('❌ MongoDB Error:', err.message));

const SessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    phoneNumber: String,
    isConnected: { type: Boolean, default: false }
});

const UserSession =
    mongoose.models.UserSession ||
    mongoose.model('UserSession', SessionSchema);

// Active bots
const activeBots = new Map();

const SESSION_DIR = path.join(__dirname, 'sessions');

// --- 2. FRONTEND WEBSITE ---

const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Multi-Bot Pairing</title>

    <style>
        body {
            font-family: 'Segoe UI', sans-serif;
            background-color: #121212;
            color: #fff;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 15px;
        }

        .container {
            background: #1e1e1e;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            text-align: center;
            max-width: 400px;
            width: 100%;
        }

        h1 { color: #25D366; }

        input {
            width: 100%;
            padding: 12px;
            margin: 15px 0;
            border: 1px solid #333;
            background: #2a2a2a;
            color: #fff;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }

        button {
            width: 100%;
            padding: 12px;
            background: #25D366;
            color: #000;
            border: none;
            border-radius: 6px;
            font-weight: bold;
            cursor: pointer;
        }

        .code-box {
            margin-top: 20px;
            padding: 15px;
            background: #2a2a2a;
            border: 1px dashed #25D366;
            border-radius: 6px;
            display: none;
        }

        .code-box h2 {
            color: #25D366;
            font-size: 28px;
            letter-spacing: 2px;
        }
    </style>
</head>

<body>

<div class="container">

    <h1>Link Your WhatsApp</h1>

    <p style="color:#aaa;font-size:14px;">
        Enter number with country code (no +)
    </p>

    <input
        type="text"
        id="number"
        placeholder="e.g. 254712345678"
    >

    <button id="pairButton" onclick="pair()">
        Get Pairing Code
    </button>

    <div class="code-box" id="result">

        <p>Your Pairing Code:</p>

        <h2 id="code"></h2>

        <p style="font-size:12px;color:#aaa;">
            WhatsApp > Linked Devices > Link with phone number
        </p>

    </div>

</div>

<script>

async function pair() {

    const num = document.getElementById('number').value.trim();

    const button = document.getElementById('pairButton');

    const result = document.getElementById('result');

    const code = document.getElementById('code');

    if (!/^\\d{8,15}$/.test(num)) {
        return alert('Enter a valid phone number with country code.');
    }

    button.disabled = true;
    button.innerText = 'Please wait...';

    result.style.display = 'block';
    code.innerText = 'Loading...';

    try {

        const res = await fetch(
            '/pair?number=' + encodeURIComponent(num)
        );

        const data = await res.json();

        if (!res.ok || data.error) {

            code.innerText = '';

            alert(data.error || 'Pairing failed.');

        } else {

            code.innerText = data.code;

        }

    } catch (e) {

        alert('Server is waking up. Please try again.');

    } finally {

        button.disabled = false;
        button.innerText = 'Get Pairing Code';

    }

}

</script>

</body>
</html>
`;

app.get('/', (req, res) => res.send(htmlPage));

// --- 3. KEEP ALIVE ---

app.get('/ping', (req, res) => res.send('alive'));

// --- 4. BOT CONNECTION ---

async function connectBot(phoneNumber, userId, onCode) {

    const sessionPath = path.join(SESSION_DIR, userId);

    await fs.promises.mkdir(sessionPath, { recursive: true });

    const { state, saveCreds } =
        await useMultiFileAuthState(sessionPath);

    const { version } = await fetchLatestWaWebVersion();

    const sock = makeWASocket({

        version,

        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'fatal' })
            )
        },

        logger: pino({ level: 'silent' }),

        printQRInTerminal: false,

        browser: Browsers.macOS('Safari'),

        syncFullHistory: false,

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 30000

    });

    const bot = activeBots.get(userId);

    if (bot) {
        bot.sock = sock;
    }

    sock.ev.on('creds.update', saveCreds);

    // --- PAIRING CODE ---

    if (!state.creds.registered && onCode) {

        setTimeout(async () => {

            try {

                if (!state.creds.registered) {

                    const code = await sock.requestPairingCode(phoneNumber);

                    onCode(null, code);

                }

            } catch (error) {

                onCode(error);

            }

        }, 3000);

    }

    // --- CONNECTION EVENTS ---

    sock.ev.on('connection.update', async update => {

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {

            console.log(`✅ User ${phoneNumber} connected!`);

            await UserSession.findOneAndUpdate(
                { userId },
                {
                    phoneNumber,
                    isConnected: true
                },
                { upsert: true }
            );

        }

        if (connection === 'close') {

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            console.log(
                `❌ Connection closed for ${phoneNumber}: ${statusCode}`
            );

            await UserSession.findOneAndUpdate(
                { userId },
                { isConnected: false }
            );

            if (statusCode === DisconnectReason.loggedOut) {

                console.log(`🚪 User ${phoneNumber} logged out.`);

                const currentBot = activeBots.get(userId);

                if (currentBot) {
                    currentBot.stopped = true;
                }

                activeBots.delete(userId);

                // DELETE SESSION AFTER LOGOUT

                try {

                    await fs.promises.rm(sessionPath, {
                        recursive: true,
                        force: true
                    });

                    console.log(`🗑️ Session deleted: ${phoneNumber}`);

                } catch (error) {

                    console.log(
                        'Session deletion error:',
                        error.message
                    );

                }

                return;
            }

            // AUTOMATIC RECONNECTION

            const currentBot = activeBots.get(userId);

            if (currentBot && !currentBot.stopped) {

                if (currentBot.reconnecting) return;

                currentBot.reconnecting = true;

                setTimeout(async () => {

                    try {

                        if (!currentBot.stopped) {

                            currentBot.reconnecting = false;

                            await connectBot(phoneNumber, userId, null);

                        }

                    } catch (error) {

                        console.log(
                            'Reconnect error:',
                            error.message
                        );

                        currentBot.reconnecting = false;

                    }

                }, 5000);

            }

        }

    });

    // --- 5. ALL ORIGINAL BOT COMMANDS ---

    sock.ev.on('messages.upsert', async update => {

        try {

            if (!update.messages || !update.messages.length) return;

            await handleMessages(sock, update, true);

        } catch (error) {

            console.log(
                '❌ Command Handler Error:',
                error.stack || error.message
            );

        }

    });

    // --- GROUP PARTICIPANT EVENTS ---

    sock.ev.on('group-participants.update', async update => {

        try {

            await handleGroupParticipantUpdate(sock, update);

        } catch (error) {

            console.log(
                'Group event error:',
                error.message
            );

        }

    });

    return sock;

}

// --- 6. PAIRING ENDPOINT ---

app.get('/pair', async (req, res) => {

    let phoneNumber = String(req.query.number || '');

    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

    if (!/^[0-9]{8,15}$/.test(phoneNumber)) {

        return res.status(400).json({
            error: 'Please provide a valid phone number.'
        });

    }

    const userId = 'user_' + phoneNumber;

    if (activeBots.has(userId)) {

        return res.status(409).json({
            error: 'This number already has an active bot!'
        });

    }

    if (mongoose.connection.readyState !== 1) {

        return res.status(503).json({
            error: 'Database is not connected. Please try again.'
        });

    }

    const sessionPath = path.join(SESSION_DIR, userId);

    try {

        await fs.promises.mkdir(SESSION_DIR, { recursive: true });

        if (fs.existsSync(sessionPath)) {

            const { state } = await useMultiFileAuthState(sessionPath);

            if (state.creds.registered) {

                return res.status(409).json({
                    error: 'A saved WhatsApp session already exists for this number.'
                });

            }

        }

        const bot = {
            sock: null,
            stopped: false,
            reconnecting: false
        };

        activeBots.set(userId, bot);

        let responseSent = false;

        const timeout = setTimeout(() => {

            if (responseSent) return;

            responseSent = true;

            bot.stopped = true;

            activeBots.delete(userId);

            try {
                bot.sock?.end(new Error('Pairing timeout'));
            } catch (_) {}

            if (!res.headersSent) {

                res.status(504).json({
                    error: 'Pairing timed out. Please try again.'
                });

            }

        }, 45000);

        const onCode = (error, code) => {

            if (responseSent) return;

            responseSent = true;

            clearTimeout(timeout);

            if (error) {

                bot.stopped = true;

                activeBots.delete(userId);

                return res.status(500).json({
                    error: error.message
                });

            }

            res.json({ code });

        };

        await connectBot(phoneNumber, userId, onCode);

    } catch (error) {

        activeBots.delete(userId);

        console.log(
            'Pairing error:',
            error.stack || error.message
        );

        if (!res.headersSent) {

            res.status(500).json({
                error: error.message
            });

        }

    }

});

// --- 7. START SERVER ---

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

    console.log(`🌐 Web server running on port ${PORT}`);

});

// --- 8. RESTORE SAVED SESSIONS ---

async function restoreSessions() {

    try {

        await fs.promises.mkdir(SESSION_DIR, { recursive: true });

        const folders = await fs.promises.readdir(
            SESSION_DIR,
            { withFileTypes: true }
        );

        for (const folder of folders) {

            if (!folder.isDirectory()) continue;

            if (!folder.name.startsWith('user_')) continue;

            const phoneNumber = folder.name.replace('user_', '');

            const userId = folder.name;

            const sessionPath = path.join(SESSION_DIR, userId);

            try {

                const { state } = await useMultiFileAuthState(sessionPath);

                if (!state.creds.registered) continue;

                const bot = {
                    sock: null,
                    stopped: false,
                    reconnecting: false
                };

                activeBots.set(userId, bot);

                await connectBot(phoneNumber, userId, null);

                console.log(`♻️ Restored session: ${phoneNumber}`);

                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {

                console.log(
                    `Restore error ${phoneNumber}:`,
                    error.message
                );

            }

        }

    } catch (error) {

        console.log('Session restore error:', error.message);

    }

}

// Wait for MongoDB before restoring sessions.
mongoose.connection.once('open', () => {

    console.log('🔄 Restoring saved WhatsApp sessions...');

    restoreSessions();

});

// --- 9. GRACEFUL SHUTDOWN ---

async function shutdown() {

    console.log('🛑 Shutting down...');

    for (const bot of activeBots.values()) {

        bot.stopped = true;

        try {
            bot.sock?.end(new Error('Server shutting down'));
        } catch (_) {}

    }

    try {
        await mongoose.disconnect();
    } catch (_) {}

    process.exit(0);

}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
