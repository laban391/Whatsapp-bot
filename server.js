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

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI;

const SESSION_DIR =
    process.env.SESSION_DIR || './sessions';

if (!MONGO_URI) {
    throw new Error('MONGO_URI environment variable is missing.');
}

// ==========================================
// 1. DATABASE CONNECTION
// ==========================================

const SessionSchema = new mongoose.Schema({
    userId: {
        type: String,
        unique: true,
        required: true
    },

    phoneNumber: String,

    isConnected: {
        type: Boolean,
        default: false
    }
});

const UserSession = mongoose.model(
    'UserSession',
    SessionSchema
);

// ==========================================
// 2. ACTIVE BOTS
// ==========================================

const activeBots = new Map();

const logger = pino({
    level: 'silent'
});

// ==========================================
// 3. WEBSITE
// ==========================================

const htmlPage = `
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>WhatsApp Multi-Bot Pairing</title>

<style>

* {
    box-sizing: border-box;
}

body {
    font-family: 'Segoe UI', sans-serif;
    background: #121212;
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

    text-align: center;

    max-width: 400px;
    width: 100%;

    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
}

h1 {
    color: #25D366;
}

input {
    width: 100%;
    padding: 12px;
    margin: 15px 0;

    border: 1px solid #333;
    background: #2a2a2a;
    color: #fff;

    border-radius: 6px;
    font-size: 16px;
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

button:disabled {
    opacity: 0.6;
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
    letter-spacing: 3px;
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

<button id="pairBtn" onclick="pair()">
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

    const button = document.getElementById('pairBtn');

    const result = document.getElementById('result');

    const code = document.getElementById('code');

    if (!/^[0-9]{8,15}$/.test(num)) {
        return alert('Enter a valid phone number.');
    }

    button.disabled = true;
    button.innerText = 'Please wait...';

    result.style.display = 'block';
    code.innerText = 'Generating...';

    try {

        const response = await fetch(
            '/pair?number=' + encodeURIComponent(num)
        );

        const data = await response.json();

        if (!response.ok) {

            code.innerText = '';

            alert(data.error || 'Pairing failed.');

        } else {

            code.innerText = data.code;

        }

    } catch (error) {

        alert('Connection error. Please try again.');

    } finally {

        button.disabled = false;
        button.innerText = 'Get Pairing Code';

    }

}

</script>

</body>
</html>
`;

// ==========================================
// 4. WEBSITE ROUTES
// ==========================================

app.get('/', (req, res) => {
    res.send(htmlPage);
});

app.get('/ping', (req, res) => {
    res.send('alive');
});

// ==========================================
// 5. BOT COMMANDS
// ==========================================

function registerCommands(sock, phoneNumber) {

    sock.ev.on('messages.upsert', async ({ messages, type }) => {

        if (type !== 'notify') return;

        for (const m of messages) {

            if (!m.message || m.key.fromMe) continue;

            try {

                const text =
                    m.message.conversation ||
                    m.message.extendedTextMessage?.text ||
                    m.message.imageMessage?.caption ||
                    '';

                if (!text) continue;

                const prefix = '.';

                if (!text.startsWith(prefix)) continue;

                const command = text
                    .slice(prefix.length)
                    .trim()
                    .split(/\s+/)[0]
                    .toLowerCase();

                const from = m.key.remoteJid;

                const reply = async (message) => {

                    await sock.sendMessage(
                        from,
                        { text: message },
                        { quoted: m }
                    );

                };

                // MENU

                if (command === 'menu') {

                    const menuText = `
╭━━━〔 MULTI-USER BOT 〕━━━╮

┃
┃ ▢ Botname: Multi-User Bot
┃ ▢ Connected as: ${phoneNumber}
┃
┣━━━〔 COMMANDS 〕━━━
┃
┃ .menu
┃ .ping
┃ .owner
┃
╰━━━━━━━━━━━━━━━━━━╯
`;

                    await reply(menuText);

                }

                // PING

                else if (command === 'ping') {

                    await reply(
                        '🏓 Pong! Your bot is active.'
                    );

                }

                // OWNER

                else if (command === 'owner') {

                    await reply(
                        '👤 Owner: +254708700675'
                    );

                }

            } catch (error) {

                console.error(
                    'COMMAND ERROR:',
                    error.message
                );

            }

        }

    });

}

// ==========================================
// 6. SOCKET CONNECTION
// ==========================================

async function connectSocket(bot, onPairingCode = null) {

    if (bot.stopped) return;

    const sessionPath = bot.sessionPath;

    const { state, saveCreds } =
        await useMultiFileAuthState(sessionPath);

    let version;

    try {

        const result = await fetchLatestWaWebVersion();

        version = result.version;

        console.log(
            'Using WhatsApp Web version:',
            version
        );

    } catch (error) {

        throw new Error(
            'Unable to fetch WhatsApp Web version: ' +
            error.message
        );

    }

    if (bot.stopped) return;

    const sock = makeWASocket({

        version,

        auth: {
            creds: state.creds,

            keys: makeCacheableSignalKeyStore(
                state.keys,
                logger
            )
        },

        logger,

        printQRInTerminal: false,

        browser: Browsers.macOS('Safari'),

        syncFullHistory: false,

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 30000,

        markOnlineOnConnect: false

    });

    bot.sock = sock;

    bot.reconnecting = false;

    let pairingRequested = false;
    let connectionClosed = false;

    // SAVE AUTHENTICATION

    sock.ev.on('creds.update', saveCreds);

    // REGISTER COMMANDS

    registerCommands(sock, bot.phoneNumber);

    // ======================================
    // PAIRING CODE
    // ======================================

    if (!state.creds.registered && onPairingCode) {

        bot.pairingTimer = setTimeout(async () => {

            try {

                if (
                    bot.stopped ||
                    pairingRequested ||
                    state.creds.registered
                ) return;

                pairingRequested = true;

                console.log(
                    'Requesting pairing code:',
                    bot.phoneNumber
                );

                const code = await sock.requestPairingCode(
                    bot.phoneNumber
                );

                console.log(
                    'Pairing code generated:',
                    bot.phoneNumber
                );

                onPairingCode(null, code);

            } catch (error) {

                console.error(
                    'PAIRING ERROR:',
                    error.message
                );

                if (onPairingCode) {
                    onPairingCode(error);
                }

            }

        }, 3000);

    }

    // ======================================
    // CONNECTION UPDATE
    // ======================================

    sock.ev.on('connection.update', async (update) => {

        const {
            connection,
            lastDisconnect
        } = update;

        if (connection === 'connecting') {

            console.log(
                'Connecting:',
                bot.phoneNumber
            );

        }

        // ==================================
        // CONNECTED
        // ==================================

        if (connection === 'open') {

            console.log(
                '✅ WhatsApp connected:',
                bot.phoneNumber
            );

            try {

                await UserSession.findOneAndUpdate(

                    { userId: bot.userId },

                    {
                        phoneNumber: bot.phoneNumber,
                        isConnected: true
                    },

                    { upsert: true }

                );

            } catch (error) {

                console.error(
                    'DATABASE ERROR:',
                    error.message
                );

            }

        }

        // ==================================
        // DISCONNECTED
        // ==================================

        if (connection === 'close') {

            if (connectionClosed) return;

            connectionClosed = true;

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const errorMessage =
                lastDisconnect?.error?.message ||
                'Unknown error';

            console.log(
                '❌ Connection closed:',
                bot.phoneNumber,
                statusCode,
                errorMessage
            );

            try {

                await UserSession.findOneAndUpdate(

                    { userId: bot.userId },

                    { isConnected: false }

                );

            } catch (error) {

                console.error(
                    'DATABASE UPDATE ERROR:',
                    error.message
                );

            }

            // ==================================
            // LOGGED OUT
            // ==================================

            if (
                statusCode === DisconnectReason.loggedOut
            ) {

                console.log(
                    '🚪 User logged out:',
                    bot.phoneNumber
                );

                bot.stopped = true;

                if (bot.pairingTimer) {
                    clearTimeout(bot.pairingTimer);
                }

                if (bot.reconnectTimer) {
                    clearTimeout(bot.reconnectTimer);
                }

                if (activeBots.get(bot.userId) === bot) {
                    activeBots.delete(bot.userId);
                }

                // CLEAR INVALID SESSION

                try {

                    await fs.promises.rm(
                        sessionPath,
                        {
                            recursive: true,
                            force: true
                        }
                    );

                    console.log(
                        '🧹 Old session cleared:',
                        bot.phoneNumber
                    );

                } catch (error) {

                    console.error(
                        'SESSION CLEANUP ERROR:',
                        error.message
                    );

                }

                if (onPairingCode) {

                    onPairingCode(
                        new Error(
                            'WhatsApp session expired. Please request a new code.'
                        )
                    );

                }

                return;

            }

            // ==================================
            // OTHER DISCONNECTIONS
            // ==================================

            if (!bot.stopped) {

                scheduleReconnect(bot);

            }

        }

    });

}

// ==========================================
// 7. AUTOMATIC RECONNECTION
// ==========================================

function scheduleReconnect(bot) {

    if (
        bot.stopped ||
        bot.reconnecting ||
        bot.reconnectTimer
    ) return;

    bot.reconnecting = true;

    console.log(
        '🔄 Reconnecting:',
        bot.phoneNumber
    );

    bot.reconnectTimer = setTimeout(async () => {

        bot.reconnectTimer = null;

        try {

            if (bot.stopped) return;

            await connectSocket(bot, null);

        } catch (error) {

            console.error(
                'RECONNECTION ERROR:',
                error.message
            );

            bot.reconnecting = false;

            scheduleReconnect(bot);

        }

    }, 5000);

}

// ==========================================
// 8. START BOT
// ==========================================

async function startBot(
    phoneNumber,
    userId,
    onPairingCode = null
) {

    if (activeBots.has(userId)) {

        throw new Error(
            'A bot for this number is already running.'
        );

    }

    const sessionPath = path.join(
        SESSION_DIR,
        userId
    );

    await fs.promises.mkdir(
        sessionPath,
        { recursive: true }
    );

    const bot = {

        userId,

        phoneNumber,

        sessionPath,

        sock: null,

        stopped: false,

        reconnecting: false,

        reconnectTimer: null,

        pairingTimer: null

    };

    activeBots.set(userId, bot);

    try {

        await connectSocket(
            bot,
            onPairingCode
        );

        return bot;

    } catch (error) {

        activeBots.delete(userId);

        bot.stopped = true;

        throw error;

    }

}

// ==========================================
// 9. PAIRING ENDPOINT
// ==========================================

app.get('/pair', async (req, res) => {

    let phoneNumber = req.query.number;

    if (!phoneNumber) {

        return res.status(400).json({
            error: 'Please provide a phone number.'
        });

    }

    phoneNumber = String(phoneNumber).replace(
        /[^0-9]/g,
        ''
    );

    if (!/^[0-9]{8,15}$/.test(phoneNumber)) {

        return res.status(400).json({
            error: 'Invalid phone number.'
        });

    }

    const userId = 'user_' + phoneNumber;

    const sessionPath = path.join(
        SESSION_DIR,
        userId
    );

    try {

        if (mongoose.connection.readyState !== 1) {

            return res.status(503).json({
                error: 'MongoDB is not ready. Try again.'
            });

        }

        if (activeBots.has(userId)) {

            return res.status(409).json({
                error: 'This number already has an active connection or pairing request.'
            });

        }

        // CHECK EXISTING SESSION

        if (fs.existsSync(sessionPath)) {

            const { state } =
                await useMultiFileAuthState(sessionPath);

            if (state.creds.registered) {

                return res.status(409).json({
                    error: 'An existing WhatsApp session was found. If you have unlinked the device, wait for the server to detect logout and clear the old session, then try again.'
                });

            }

        }

        let responseSent = false;

        let bot;

        const timeout = setTimeout(async () => {

            if (responseSent) return;

            responseSent = true;

            if (bot) {

                bot.stopped = true;

                if (bot.sock) {
                    try {
                        bot.sock.end(
                            new Error('Pairing timed out')
                        );
                    } catch (_) {}
                }

                activeBots.delete(userId);

            }

            if (!res.headersSent) {

                res.status(504).json({
                    error: 'Pairing timed out. Please try again and check Render logs.'
                });

            }

        }, 45000);

        const pairingCallback = (error, code) => {

            if (responseSent) return;

            responseSent = true;

            clearTimeout(timeout);

            if (error) {

                if (!res.headersSent) {

                    res.status(500).json({
                        error: error.message
                    });

                }

                return;

            }

            if (!res.headersSent) {

                res.json({
                    code
                });

            }

        };

        bot = await startBot(
            phoneNumber,
            userId,
            pairingCallback
        );

    } catch (error) {

        console.error(
            'PAIR ENDPOINT ERROR:',
            error
        );

        if (!res.headersSent) {

            res.status(500).json({
                error: error.message
            });

        }

    }

});

// ==========================================
// 10. RESTORE SAVED SESSIONS
// ==========================================

async function restoreSessions() {

    console.log(
        '🔄 Checking saved WhatsApp sessions...'
    );

    await fs.promises.mkdir(
        SESSION_DIR,
        { recursive: true }
    );

    const folders = await fs.promises.readdir(
        SESSION_DIR,
        { withFileTypes: true }
    );

    for (const folder of folders) {

        if (!folder.isDirectory()) continue;

        if (!folder.name.startsWith('user_')) continue;

        const phoneNumber = folder.name.slice(5);

        if (!/^[0-9]{8,15}$/.test(phoneNumber)) continue;

        const userId = folder.name;

        try {

            const sessionPath = path.join(
                SESSION_DIR,
                userId
            );

            const { state } =
                await useMultiFileAuthState(sessionPath);

            if (!state.creds.registered) {

                console.log(
                    'Skipping incomplete session:',
                    phoneNumber
                );

                continue;

            }

            console.log(
                '♻️ Restoring session:',
                phoneNumber
            );

            await startBot(
                phoneNumber,
                userId,
                null
            );

        } catch (error) {

            console.error(
                'SESSION RESTORE ERROR:',
                phoneNumber,
                error.message
            );

        }

    }

}

// ==========================================
// 11. SERVER START
// ==========================================

async function startServer() {

    try {

        await mongoose.connect(MONGO_URI);

        console.log(
            '✅ Connected to MongoDB'
        );

        await fs.promises.mkdir(
            SESSION_DIR,
            { recursive: true }
        );

        app.listen(PORT, async () => {

            console.log(
                `🌐 Web server running on port ${PORT}`
            );

            console.log(
                '🚀 Your WhatsApp multi-user service is live!'
            );

            await restoreSessions();

        });

    } catch (error) {

        console.error(
            '❌ SERVER START ERROR:',
            error
        );

        process.exit(1);

    }

}

startServer();
