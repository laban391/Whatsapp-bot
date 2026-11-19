const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;

const {
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');

const pino = require('pino');

const {
    handleMessages,
    handleGroupParticipantUpdate
} = require('./main');

const app = express();
app.use(express.json());

// ==================================================
// 1. DATABASE CONNECTION
// ==================================================

const MONGO_URI = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ Connected to MongoDB');
        restoreSessions();
    })
    .catch(err => {
        console.log('❌ MongoDB Error:', err.message);
    });

// ==================================================
// 2. DATABASE MODELS
// ==================================================

const SessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    phoneNumber: String,
    isConnected: { type: Boolean, default: false }
});

const UserSession =
    mongoose.models.UserSession ||
    mongoose.model('UserSession', SessionSchema);

// Stores actual Baileys credentials and Signal keys.
const AuthSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    key: { type: String, required: true },
    value: { type: String, required: true }
}, {
    timestamps: true
});

AuthSchema.index(
    { userId: 1, key: 1 },
    { unique: true }
);

const AuthData =
    mongoose.models.AuthData ||
    mongoose.model('AuthData', AuthSchema);

// ==================================================
// 3. GLOBAL SETTINGS
// ==================================================

const activeBots = new Map();

const logger = pino({
    level: 'silent'
});

// ==================================================
// 4. MONGODB AUTHENTICATION STORAGE
// ==================================================

async function useMongoAuthState(userId) {

    const encode = value =>
        JSON.stringify(value, BufferJSON.replacer);

    const decode = value =>
        JSON.parse(value, BufferJSON.reviver);

    // Load saved credentials.
    const savedCreds = await AuthData.findOne({
        userId,
        key: '__creds__'
    });

    const creds = savedCreds
        ? decode(savedCreds.value)
        : initAuthCreds();

    // Save credentials.
    const saveCreds = async () => {

        await AuthData.updateOne(
            {
                userId,
                key: '__creds__'
            },
            {
                $set: {
                    value: encode(creds)
                }
            },
            {
                upsert: true
            }
        );

    };

    // Signal key storage.
    const keys = {

        get: async (type, ids) => {

            const result = {};

            const dbKeys = ids.map(id => `${type}:${id}`);

            const documents = await AuthData.find({
                userId,
                key: { $in: dbKeys }
            });

            for (const doc of documents) {

                const id = doc.key.substring(
                    type.length + 1
                );

                let value = decode(doc.value);

                if (
                    type === 'app-state-sync-key' &&
                    value
                ) {

                    value =
                        proto.Message.AppStateSyncKeyData
                            .fromObject(value);

                }

                result[id] = value;

            }

            return result;

        },

        set: async data => {

            const operations = [];

            for (const category in data) {

                for (const id in data[category]) {

                    const value = data[category][id];

                    const key = `${category}:${id}`;

                    if (value === null || value === undefined) {

                        operations.push({
                            deleteOne: {
                                filter: {
                                    userId,
                                    key
                                }
                            }
                        });

                    } else {

                        operations.push({
                            updateOne: {
                                filter: {
                                    userId,
                                    key
                                },
                                update: {
                                    $set: {
                                        value: encode(value)
                                    }
                                },
                                upsert: true
                            }
                        });

                    }

                }

            }

            if (operations.length) {

                await AuthData.bulkWrite(
                    operations,
                    { ordered: false }
                );

            }

        }

    };

    return {
        state: {
            creds,
            keys
        },
        saveCreds
    };

}

// ==================================================
// 5. DELETE USER SESSION
// ==================================================

async function deleteUserSession(userId) {

    await AuthData.deleteMany({ userId });

    await UserSession.deleteOne({ userId });

    console.log(`🗑️ Deleted session: ${userId}`);

}

// ==================================================
// 6. BEAUTIFUL LABAN-XMD WEBSITE
// ==================================================

const htmlPage = `

<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width, initial-scale=1.0">

<title>LABAN-XMD WhatsApp Bot</title>

<style>

* {
    box-sizing: border-box;
}

body {

    margin: 0;
    min-height: 100vh;

    font-family: 'Segoe UI', Arial, sans-serif;

    background:
    radial-gradient(circle at 15% 20%, #392078 0%, transparent 40%),
    radial-gradient(circle at 85% 80%, #075c75 0%, transparent 40%),
    linear-gradient(135deg, #080b20, #11152f, #080b20);

    display: flex;
    align-items: center;
    justify-content: center;

    padding: 20px;

    color: white;

}

.container {

    width: 100%;
    max-width: 430px;

    padding: 35px 25px;

    border-radius: 25px;

    background: rgba(255,255,255,0.07);

    border: 1px solid rgba(255,255,255,0.15);

    backdrop-filter: blur(20px);

    box-shadow: 0 20px 70px rgba(0,0,0,0.4);

    text-align: center;

}

.logo {

    width: 85px;
    height: 85px;

    margin: auto auto 18px;

    border-radius: 25px;

    background: linear-gradient(
        135deg,
        #8b5cf6,
        #06b6d4,
        #ec4899
    );

    display: flex;
    align-items: center;
    justify-content: center;

    font-size: 30px;
    font-weight: 900;

    box-shadow: 0 0 30px rgba(139,92,246,0.4);

}

h1 {

    margin: 0;

    font-size: 27px;

    font-weight: 900;

    background: linear-gradient(
        90deg,
        #c084fc,
        #22d3ee,
        #f472b6
    );

    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;

}

.subtitle {

    color: #b9c2dc;

    font-size: 13px;

    margin-top: 10px;

    letter-spacing: 2px;

}

.badge {

    display: inline-block;

    margin: 20px 0;

    padding: 8px 16px;

    border-radius: 30px;

    background: rgba(139,92,246,0.16);

    border: 1px solid rgba(139,92,246,0.4);

    color: #c4b5fd;

    font-size: 12px;

}

.description {

    color: #d1d5db;

    font-size: 14px;

    line-height: 1.6;

}

input {

    width: 100%;

    padding: 16px;

    margin-top: 20px;

    border-radius: 12px;

    border: 1px solid rgba(255,255,255,0.15);

    background: rgba(255,255,255,0.08);

    color: white;

    font-size: 16px;

    outline: none;

    text-align: center;

}

input:focus {

    border-color: #a78bfa;

    box-shadow: 0 0 15px rgba(139,92,246,0.3);

}

input::placeholder {

    color: #8993ad;

}

button {

    width: 100%;

    padding: 16px;

    margin-top: 15px;

    border: none;

    border-radius: 12px;

    background: linear-gradient(
        100deg,
        #8b5cf6,
        #06b6d4,
        #ec4899
    );

    color: white;

    font-size: 15px;

    font-weight: bold;

    cursor: pointer;

    transition: 0.3s;

}

button:hover {

    transform: translateY(-2px);

    box-shadow: 0 8px 25px rgba(139,92,246,0.35);

}

button:disabled {

    opacity: 0.6;

    cursor: not-allowed;

}

.code-box {

    display: none;

    margin-top: 25px;

    padding: 20px;

    border-radius: 15px;

    background: rgba(6,182,212,0.08);

    border: 1px solid rgba(6,182,212,0.4);

}

.code-box h2 {

    font-size: 29px;

    letter-spacing: 5px;

    color: #67e8f9;

    margin: 15px 0;

}

.copy-btn {

    background: linear-gradient(
        100deg,
        #0891b2,
        #6366f1
    );

}

.instructions {

    margin-top: 20px;

    padding: 15px;

    background: rgba(255,255,255,0.04);

    border-radius: 12px;

    color: #cbd5e1;

    font-size: 12px;

    line-height: 1.8;

}

.footer {

    margin-top: 25px;

    color: #8993ad;

    font-size: 12px;

}

.footer strong {

    color: #c4b5fd;

}

</style>

</head>

<body>

<div class="container">

    <div class="logo">LX</div>

    <h1>LABAN-XMD</h1>

    <div class="subtitle">
        WHATSAPP MULTI-BOT
    </div>

    <div class="badge">
        ✦ OFFICIAL PAIRING PORTAL ✦
    </div>

    <p class="description">
        Connect your WhatsApp account to
        Laban-XMD using a secure pairing code.
    </p>

    <input
        type="text"
        id="number"
        placeholder="254712345678"
        autocomplete="tel"
    >

    <button id="pairButton" onclick="pair()">
        ✨ GENERATE PAIRING CODE
    </button>

    <div class="code-box" id="result">

        <p>Your WhatsApp pairing code</p>

        <h2 id="code">Loading...</h2>

        <button class="copy-btn" onclick="copyCode()">
            📋 COPY PAIRING CODE
        </button>

    </div>

    <div class="instructions">

        <strong>HOW TO CONNECT</strong><br>

        1. Open WhatsApp.<br>

        2. Go to Linked Devices.<br>

        3. Select Link with phone number.<br>

        4. Enter the pairing code above.

    </div>

    <div class="footer">

        POWERED BY <strong>LABAN-XMD</strong><br>

        © 2026 All Rights Reserved

    </div>

</div>

<script>

async function pair() {

    const num =
        document.getElementById('number').value.trim();

    const button =
        document.getElementById('pairButton');

    const result =
        document.getElementById('result');

    const code =
        document.getElementById('code');

    if (!/^\\d{8,15}$/.test(num)) {

        alert('Enter a valid phone number with country code.');

        return;

    }

    button.disabled = true;

    button.innerText = 'CONNECTING...';

    result.style.display = 'block';

    code.innerText = 'LOADING';

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

        alert('Server connection failed. Please try again.');

    } finally {

        button.disabled = false;

        button.innerText = '✨ GENERATE PAIRING CODE';

    }

}

function copyCode() {

    const code =
        document.getElementById('code').innerText;

    if (!code || code === 'LOADING') return;

    navigator.clipboard.writeText(code)
        .then(() => alert('Pairing code copied!'))
        .catch(() => alert('Please copy the code manually.'));

}

</script>

</body>

</html>

`;

app.get('/', (req, res) => {
    res.send(htmlPage);
});

// ==================================================
// 7. KEEP ALIVE
// ==================================================

app.get('/ping', (req, res) => {
    res.send('Laban-XMD is alive!');
});

// ==================================================
// 8. CONNECT WHATSAPP BOT
// ==================================================

async function connectBot(phoneNumber, userId, onCode) {

    const { state, saveCreds } =
        await useMongoAuthState(userId);

    const { version } =
        await fetchLatestWaWebVersion();

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

        markOnlineOnConnect: false,

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 30000

    });

    let bot = activeBots.get(userId);

    if (!bot) {

        bot = {
            sock: null,
            stopped: false,
            reconnecting: false
        };

        activeBots.set(userId, bot);

    }

    bot.sock = sock;

    // Save all updated credentials.
    sock.ev.on('creds.update', async () => {

        try {

            await saveCreds();

        } catch (error) {

            console.log(
                'Credential save error:',
                error.message
            );

        }

    });

    // Generate pairing code.
    if (!state.creds.registered && onCode) {

        setTimeout(async () => {

            try {

                if (
                    !state.creds.registered &&
                    !bot.stopped
                ) {

                    const code =
                        await sock.requestPairingCode(phoneNumber);

                    onCode(null, code);

                }

            } catch (error) {

                onCode(error);

            }

        }, 3000);

    }

    // CONNECTION EVENTS
    sock.ev.on('connection.update', async update => {

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {

            console.log(
                `✅ Laban-XMD connected: ${phoneNumber}`
            );

            bot.reconnecting = false;

            await UserSession.findOneAndUpdate(
                { userId },
                {
                    userId,
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
                statusCode
            );

            await UserSession.updateOne(
                { userId },
                { $set: { isConnected: false } }
            );

            if (statusCode === DisconnectReason.loggedOut) {

                console.log(
                    `🚪 WhatsApp logged out: ${phoneNumber}`
                );

                bot.stopped = true;

                activeBots.delete(userId);

                await deleteUserSession(userId);

                return;

            }

            // AUTOMATIC RECONNECTION
            if (!bot.stopped && !bot.reconnecting) {

                bot.reconnecting = true;

                setTimeout(async () => {

                    try {

                        if (!bot.stopped) {

                            await connectBot(
                                phoneNumber,
                                userId,
                                null
                            );

                        }

                    } catch (error) {

                        console.log(
                            'Reconnect error:',
                            error.message
                        );

                        bot.reconnecting = false;

                    }

                }, 5000);

            }

        }

    });

    // ORIGINAL GAAJU-XMD COMMAND HANDLER
    sock.ev.on('messages.upsert', async update => {

        try {

            if (
                !update.messages ||
                !update.messages.length
            ) return;

            await handleMessages(sock, update, true);

        } catch (error) {

            console.log(
                'Command Handler Error:',
                error.stack || error.message
            );

        }

    });

    // GROUP EVENTS
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

// ==================================================
// 9. PAIRING ENDPOINT
// ==================================================

app.get('/pair', async (req, res) => {

    let phoneNumber =
        String(req.query.number || '');

    phoneNumber =
        phoneNumber.replace(/[^0-9]/g, '');

    if (!/^[0-9]{8,15}$/.test(phoneNumber)) {

        return res.status(400).json({
            error: 'Please provide a valid phone number.'
        });

    }

    const userId = 'user_' + phoneNumber;

    if (mongoose.connection.readyState !== 1) {

        return res.status(503).json({
            error: 'Database is not connected. Please try again.'
        });

    }

    if (activeBots.has(userId)) {

        return res.status(409).json({
            error: 'This number already has an active bot!'
        });

    }

    try {

        // Check existing MongoDB authentication.
        const savedCreds = await AuthData.findOne({
            userId,
            key: '__creds__'
        });

        if (savedCreds) {

            const credentials = JSON.parse(
                savedCreds.value,
                BufferJSON.reviver
            );

            if (credentials.registered) {

                return res.status(409).json({
                    error: 'This number already has a saved WhatsApp session. It will reconnect automatically.'
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

                bot.sock?.end(
                    new Error('Pairing timeout')
                );

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

        await connectBot(
            phoneNumber,
            userId,
            onCode
        );

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

// ==================================================
// 10. RESTORE SAVED WHATSAPP SESSIONS
// ==================================================

async function restoreSessions() {

    try {

        console.log(
            '🔄 Checking MongoDB for saved WhatsApp sessions...'
        );

        const savedSessions = await AuthData.find({
            key: '__creds__'
        });

        for (const session of savedSessions) {

            const userId = session.userId;

            if (activeBots.has(userId)) continue;

            try {

                const credentials = JSON.parse(
                    session.value,
                    BufferJSON.reviver
                );

                if (!credentials.registered) continue;

                const phoneNumber =
                    userId.replace('user_', '');

                const bot = {
                    sock: null,
                    stopped: false,
                    reconnecting: false
                };

                activeBots.set(userId, bot);

                await connectBot(
                    phoneNumber,
                    userId,
                    null
                );

                console.log(
                    `♻️ Restoring WhatsApp: ${phoneNumber}`
                );

                await new Promise(resolve =>
                    setTimeout(resolve, 2000)
                );

            } catch (error) {

                console.log(
                    `Restore error ${userId}:`,
                    error.message
                );

                activeBots.delete(userId);

            }

        }

        console.log(
            '✅ WhatsApp session restoration completed.'
        );

    } catch (error) {

        console.log(
            'Session restoration error:',
            error.message
        );

    }

}

// ==================================================
// 11. START SERVER
// ==================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

    console.log(
        '🌐 LABAN-XMD pairing website is running!'
    );

});

// ==================================================
// 12. GRACEFUL SHUTDOWN
// ==================================================

async function shutdown() {

    console.log(
        '🛑 LABAN-XMD shutting down...'
    );

    for (const bot of activeBots.values()) {

        bot.stopped = true;

        try {

            bot.sock?.end(
                new Error('Server shutting down')
            );

        } catch (_) {}

    }

    try {

        await mongoose.disconnect();

    } catch (_) {}

    process.exit(0);

}

process.once('SIGINT', shutdown);

process.once('SIGTERM', shutdown);
