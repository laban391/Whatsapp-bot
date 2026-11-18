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

// Use Render persistent disk for SESSION_DIR.
// Example mount path: /var/data
const SESSION_DIR = process.env.SESSION_DIR || './sessions';

if (!MONGO_URI) {
    throw new Error('MONGO_URI environment variable is missing.');
}

// ===============================
// 1. DATABASE
// ===============================

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB');
    })
    .catch(err => {
        console.error('❌ MongoDB Error:', err.message);
    });

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

// ===============================
// 2. ACTIVE BOTS
// ===============================

const activeBots = new Map();

// ===============================
// 3. WEBSITE
// ===============================

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
    color: white;

    display: flex;
    justify-content: center;
    align-items: center;

    min-height: 100vh;
    margin: 0;
    padding: 15px;
}

.container {
    background: #1e1e1e;
    padding: 35px;
    border-radius: 12px;

    text-align: center;

    max-width: 400px;
    width: 100%;

    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
}

h1 {
    color: #25D366;
}

p {
    color: #aaa;
}

input {
    width: 100%;
    padding: 13px;
    margin: 15px 0;

    border: 1px solid #333;
    background: #2a2a2a;
    color: white;

    border-radius: 6px;
    font-size: 16px;
}

button {
    width: 100%;
    padding: 13px;

    background: #25D366;
    color: black;

    border: none;
    border-radius: 6px;

    font-weight: bold;
    cursor: pointer;
}

button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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

<p>Enter number with country code (no +)</p>

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

<p style="font-size:12px">
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

    if (!/^\\d{8,15}$/.test(num)) {
        return alert('Enter a valid phone number with country code.');
    }

    button.disabled = true;
    button.innerText = 'Please wait...';

    result.style.display = 'block';
    code.innerText = 'Generating...';

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

    } catch (error) {

        code.innerText = '';

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

app.get('/', (req, res) => {
    res.send(htmlPage);
});

app.get('/ping', (req, res) => {
    res.send('alive');
});

// ===============================
// 4. BOT COMMAND HANDLER
// ===============================

function registerCommands(sock, phoneNumber) {

    sock.ev.on('messages.upsert', async ({ messages, type }) => {

        if (type !== 'notify') return;

        for (const m of messages) {

            if (!m.message || m.key.fromMe) continue;

            try {

                const message =
                    m.message.conversation ||
                    m.message.extendedTextMessage?.text ||
                    '';

                if (!message) continue;

                const prefix = '.';

                if (!message.startsWith(prefix)) continue;

                const command = message
                    .slice(prefix.length)
                    .trim()
                    .split(/\s+/)[0]
                    .toLowerCase();

                const from = m.key.remoteJid;

                const reply = async (text) => {
                    await sock.sendMessage(
                        from,
                        { text },
                        { quoted: m }
                    );
                };

                // MENU

                if (command === 'menu') {

                    const menuText = `
╭━━━〔 MULTI-USER BOT 〕━━━╮

┃
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

                    await reply('🏓 Pong! Your bot is active.');

                }

                // OWNER

                else if (command === 'owner') {

                    await reply('👤 Owner: +254708700675');

                }

            } catch (error) {

                console.error(
                    'Command Handler Error:',
                    error.message
                );

            }

        }

    });

}

// ===============================
// 5. SOCKET CREATION
// ===============================

async function startBot(phoneNumber, userId, onPairingCode) {

    const sessionPath = path.join(
        SESSION_DIR,
        userId
    );

    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } =
        await useMultiFileAuthState(sessionPath);

    let version;

    try {

        const result = await fetchLatestWaWebVersion();

        version = result.version;

        console.log('Using WhatsApp Web version:', version);

    } catch (error) {

        console.error(
            'Version fetch failed:',
            error.message
        );

        throw error;

    }

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

        keepAliveIntervalMs: 30000,

        markOnlineOnConnect: false

    });

    const botData = {
        sock,
        phoneNumber,
        stopped: false,
        reconnectTimer: null,
        reconnecting: false
    };

    activeBots.set(userId, botData);

    sock.ev.on('creds.update', saveCreds);

    registerCommands(sock, phoneNumber);

    // ===============================
    // PAIRING CODE
    // ===============================

    if (!state.creds.registered && onPairingCode) {

        setTimeout(async () => {

            try {

                if (
                    botData.stopped ||
                    state.creds.registered
                ) return;

                const code = await sock.requestPairingCode(
                    phoneNumber
                );

                console.log(
                    `Pairing code generated for ${phoneNumber}`
                );

                onPairingCode(null, code);

            } catch (error) {

                console.error(
                    'PAIRING ERROR:',
                    error.message
                );

                onPairingCode(error);

            }

        }, 3000);

    }

    // ===============================
    // CONNECTION UPDATE
    // ===============================

    sock.ev.on('connection.update', async (update) => {

        const {
            connection,
            lastDisconnect
        } = update;

        if (connection === 'connecting') {

            console.log(
                `🔄 Connecting ${phoneNumber}...`
            );

        }

        if (connection === 'open') {

            console.log(
                `✅ WhatsApp connected: ${phoneNumber}`
            );

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
                `❌ Connection closed: ${phoneNumber}`,
                statusCode,
                lastDisconnect?.error?.message
            );

            await UserSession.findOneAndUpdate(

                { userId },

                { isConnected: false }

            );

            if (botData.stopped) return;

            if (statusCode === DisconnectReason.loggedOut) {

                console.log(
                    `User ${phoneNumber} logged out.`
                );

                botData.stopped = true;

                activeBots.delete(userId);

                return;

            }

            scheduleReconnect(
                phoneNumber,
                userId,
                botData
            );

        }

    });

    return sock;

}

// ===============================
// 6. RECONNECTION
// ===============================

function scheduleReconnect(phoneNumber, userId, botData) {

    if (botData.stopped || botData.reconnecting) return;

    botData.reconnecting = true;

    const statusDelay = 5000;

    console.log(
        `🔄 Reconnecting ${phoneNumber} in 5 seconds...`
    );

    botData.reconnectTimer = setTimeout(async () => {

        try {

            if (botData.stopped) return;

            // Prevent overlapping socket connections.
            activeBots.delete(userId);

            await startBot(
                phoneNumber,
                userId,
                null
            );

            console.log(
                `🔄 New connection started for ${phoneNumber}`
            );

        } catch (error) {

            console.error(
                'RECONNECTION ERROR:',
                error.message
            );

            botData.reconnecting = false;

            scheduleReconnect(
                phoneNumber,
                userId,
                botData
            );

        }

    }, statusDelay);

}

// ===============================
// 7. PAIRING ENDPOINT
// ===============================

app.get('/pair', async (req, res) => {

    let phoneNumber = req.query.number;

    if (!phoneNumber) {

        return res.status(400).json({
            error: 'Please provide a phone number.'
        });

    }

    phoneNumber = String(phoneNumber).replace(/\D/g, '');

    if (!/^\d{8,15}$/.test(phoneNumber)) {

        return res.status(400).json({
            error: 'Invalid phone number.'
        });

    }

    const userId = 'user_' + phoneNumber;

    try {

        if (mongoose.connection.readyState !== 1) {

            return res.status(503).json({
                error: 'Database is not ready. Try again.'
            });

        }

        const existing = activeBots.get(userId);

        if (existing) {

            return res.status(409).json({
                error: 'A connection or pairing request is already running for this number.'
            });

        }

        const dbUser = await UserSession.findOne({ userId });

        if (dbUser && dbUser.isConnected) {

            return res.status(409).json({
                error: 'This number is already connected.'
            });

        }

        let responseSent = false;

        const pairingTimeout = setTimeout(() => {

            if (!responseSent && !res.headersSent) {

                responseSent = true;

                res.status(504).json({
                    error: 'Pairing timed out. Check Render logs and try again.'
                });

            }

        }, 45000);

        const sendPairingResult = (error, code) => {

            if (responseSent || res.headersSent) return;

            responseSent = true;

            clearTimeout(pairingTimeout);

            if (error) {

                return res.status(500).json({
                    error: error.message
                });

            }

            res.json({
                code
            });

        };

        await startBot(
            phoneNumber,
            userId,
            sendPairingResult
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

// ===============================
// 8. SERVER START
// ===============================

app.listen(PORT, () => {

    console.log(
        `🌐 Web server running on port ${PORT}`
    );

});
