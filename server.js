'use strict';

const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const PhoneNumber = require('awesome-phonenumber');

// GAAJU-XMD support files
global.File = global.File || class File {};

require('./settings');
require('./config.js');

const settings = require('./settings');
const store = require('./lib/lightweight_store');

const { smsg } = require('./lib/myfunc');

const {
    handleMessages,
    handleGroupParticipantUpdate
} = require('./main');

const {
    handleStatusUpdate,
    handleBulkStatusUpdate
} = require('./commands/autostatus');

const { storeMessage } = require('./commands/antidelete');
const { handleAnticall } = require('./commands/anticall');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidDecode
} = require('@whiskeysockets/baileys');

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

// PASTE YOUR NEW MONGODB CONNECTION URL HERE
const MONGO_URL = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';

const SESSION_DIR = path.resolve(
    process.env.SESSION_DIR || './sessions'
);

const logger = pino({ level: 'silent' });

if (!MONGO_URL || MONGO_URL === 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/') {
    throw new Error('Please add your MongoDB connection URL.');
}

// GAAJU-XMD global settings
global.packname = settings.packname;
global.author = settings.author;
global.botname = settings.botName || 'GAAJU-XMD';
global.themeemoji = '🤖';
global.channelLink = 'https://whatsapp.com/channel/0029VbBvGgyFsn0alyIDjw0z';
global.ytch = settings.ytChannel || 'Xchristech';

// MongoDB session model
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
}, {
    timestamps: true
});

const UserSession =
    mongoose.models.UserSession ||
    mongoose.model('UserSession', SessionSchema);

// Active WhatsApp connections
const activeBots = new Map();

// Pairing website
const htmlPage = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WhatsApp Multi-Bot Pairing</title>

<style>
* {
    box-sizing: border-box;
}

body {
    font-family: Segoe UI, sans-serif;
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
    padding: 35px;
    border-radius: 12px;
    text-align: center;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 4px 15px rgba(0,0,0,.5);
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
    border: 0;
    border-radius: 6px;
    font-weight: bold;
    cursor: pointer;
}

button:disabled {
    opacity: .6;
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
WhatsApp &gt; Linked Devices &gt; Link with phone number
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

        if (!response.ok || data.error) {

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
</html>`;

app.get('/', (_req, res) => {
    res.send(htmlPage);
});

app.get('/ping', (_req, res) => {
    res.send('alive');
});

// Read autostatus settings
function readStatusConfig() {

    try {

        const file = path.join(
            __dirname,
            'data',
            'autostatus.json'
        );

        if (fs.existsSync(file)) {

            const data = JSON.parse(
                fs.readFileSync(file, 'utf8')
            );

            return {
                enabled: data.enabled === true,
                likeOn: data.likeOn === true,
                selfOn: data.selfOn === true
            };
        }

    } catch (error) {

        console.error(
            'Status config read error:',
            error.message
        );

    }

    return {
        enabled: false,
        likeOn: false,
        selfOn: false
    };
}

// Socket helper functions
function attachSocketHelpers(sock) {

    sock.decodeJid = (jid) => {

        if (!jid) return jid;

        if (/:[0-9]+@/i.test(jid)) {

            const decoded = jidDecode(jid) || {};

            return decoded.user && decoded.server
                ? `${decoded.user}@${decoded.server}`
                : jid;
        }

        return jid;
    };

    sock.getName = (jid, withoutContact = false) => {

        const id = sock.decodeJid(jid);

        const contact = store.contacts?.[id] || {};

        if (id?.endsWith('@g.us')) {

            const group = store.chats?.[id] || {};

            return group.subject || contact.name || id;
        }

        if (id === '0@s.whatsapp.net') {
            return 'WhatsApp';
        }

        if (id === sock.decodeJid(sock.user?.id)) {

            return sock.user?.name ||
                sock.user?.verifiedName ||
                id;
        }

        if (!withoutContact &&
            (contact.name || contact.notify || contact.verifiedName)) {

            return contact.name ||
                contact.notify ||
                contact.verifiedName;
        }

        const number = String(id || '')
            .split('@')[0]
            .split(':')[0];

        try {

            return new PhoneNumber(`+${number}`)
                .getNumber('international') || number;

        } catch (_) {

            return number;

        }
    };

    sock.serializeM = (message) => {
        return smsg(sock, message, store);
    };

    sock.public = true;
}

// Attach original GAAJU-XMD command handlers
function bindBotEvents(sock, bot) {

    try {

        store.bind(sock.ev);

    } catch (error) {

        console.error('Store bind warning:', error.message);

    }

    sock.ev.on('contacts.update', updates => {

        for (const contact of updates || []) {

            const id = sock.decodeJid(contact.id);

            if (id && store.contacts) {

                store.contacts[id] = {
                    id,
                    name: contact.notify || contact.name
                };

            }
        }
    });

    sock.ev.on('messages.upsert', async update => {

        try {

            if (!update?.messages?.length) return;

            for (const message of update.messages) {

                if (!message?.message) continue;

                const jid = message.key?.remoteJid;

                if (jid === 'status@broadcast') {

                    if (!message.key.fromMe) {

                        try {
                            storeMessage(sock, message);
                        } catch (_) {}

                        const statusConfig = readStatusConfig();

                        if (statusConfig.enabled) {

                            handleStatusUpdate(
                                sock,
                                {
                                    messages: [message],
                                    type: update.type
                                }
                            ).catch(() => {});

                        }
                    }

                    continue;
                }
            }

            // Original command pipeline
            await handleMessages(sock, update, true);

            if (update.messages.length > 1) {

                const statusMessages = update.messages.filter(
                    m =>
                        m?.key?.remoteJid === 'status@broadcast' &&
                        !m.key.fromMe &&
                        m.key.participant
                );

                if (statusMessages.length) {

                    const statusConfig = readStatusConfig();

                    if (statusConfig.enabled) {

                        handleBulkStatusUpdate(
                            sock,
                            statusMessages
                        ).catch(() => {});

                    }
                }
            }

        } catch (error) {

            console.error(
                `[${bot.phoneNumber}] MESSAGE HANDLER ERROR:`,
                error.stack || error.message
            );

        }
    });

    sock.ev.on('group-participants.update', async update => {

        try {

            await handleGroupParticipantUpdate(sock, update);

        } catch (error) {

            console.error(
                `[${bot.phoneNumber}] GROUP EVENT ERROR:`,
                error.message
            );

        }
    });

    sock.ev.on('call', async calls => {

        try {

            await handleAnticall(sock, calls);

        } catch (error) {

            console.error(
                `[${bot.phoneNumber}] CALL HANDLER ERROR:`,
                error.message
            );

        }
    });
}

// Connect WhatsApp socket
async function connectSocket(bot, onPairingCode = null) {

    if (bot.stopped) return;

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(bot.sessionPath);

    const { version } = await fetchLatestBaileysVersion();

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

        markOnlineOnConnect: false,

        connectTimeoutMs: 60000,

        keepAliveIntervalMs: 30000,

        defaultQueryTimeoutMs: 60000,

        getMessage: async key => {

            try {

                const saved = await store.loadMessage(
                    key.remoteJid,
                    key.id
                );

                return saved?.message || undefined;

            } catch (_) {

                return undefined;

            }
        }
    });

    bot.sock = sock;

    bot.reconnecting = false;

    bot.connectionClosed = false;

    attachSocketHelpers(sock);

    sock.ev.on('creds.update', saveCreds);

    bindBotEvents(sock, bot);

    if (!state.creds.registered && onPairingCode) {

        bot.pairingTimer = setTimeout(async () => {

            try {

                if (
                    bot.stopped ||
                    bot.pairingRequested ||
                    state.creds.registered
                ) return;

                bot.pairingRequested = true;

                console.log(
                    `Requesting pairing code: ${bot.phoneNumber}`
                );

                const code = await sock.requestPairingCode(
                    bot.phoneNumber
                );

                console.log(
                    `Pairing code generated: ${bot.phoneNumber}`
                );

                onPairingCode(null, code);

            } catch (error) {

                console.error(
                    'PAIRING ERROR:',
                    error.stack || error.message
                );

                onPairingCode(error);

            }

        }, 3000);
    }

    sock.ev.on('connection.update', async update => {

        const {
            connection,
            lastDisconnect
        } = update;

        if (connection === 'connecting') {

            console.log(
                `Connecting: ${bot.phoneNumber}`
            );

        }

        if (connection === 'open') {

            console.log(
                `WhatsApp connected: ${bot.phoneNumber}`
            );

            bot.reconnecting = false;

            try {

                await UserSession.findOneAndUpdate(

                    { userId: bot.userId },

                    {
                        phoneNumber: bot.phoneNumber,
                        isConnected: true
                    },

                    {
                        upsert: true,
                        new: true
                    }

                );

            } catch (error) {

                console.error(
                    'DATABASE CONNECTED UPDATE ERROR:',
                    error.message
                );

            }

            try {

                const groups =
                    await sock.groupFetchAllParticipating();

                for (const group of Object.values(groups || {})) {

                    if (store.chats) {

                        store.chats[group.id] = {
                            id: group.id,
                            ...group
                        };

                    }
                }

            } catch (error) {

                console.error(
                    `[${bot.phoneNumber}] GROUP CACHE ERROR:`,
                    error.message
                );

            }
        }

        if (connection === 'close') {

            if (bot.connectionClosed) return;

            bot.connectionClosed = true;

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const errorMessage =
                lastDisconnect?.error?.message || 'Unknown error';

            console.log(
                `Connection closed: ${bot.phoneNumber} | ${statusCode || 'no status'} | ${errorMessage}`
            );

            try {

                await UserSession.findOneAndUpdate(

                    { userId: bot.userId },

                    { isConnected: false }

                );

            } catch (error) {

                console.error(
                    'DATABASE DISCONNECT UPDATE ERROR:',
                    error.message
                );

            }

            // Remove credentials only after a real logout
            if (statusCode === DisconnectReason.loggedOut) {

                console.log(
                    `User logged out: ${bot.phoneNumber}`
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

                try {

                    await fs.promises.rm(
                        bot.sessionPath,
                        {
                            recursive: true,
                            force: true
                        }
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
                            'WhatsApp session expired. Request a new pairing code.'
                        )
                    );

                }

                return;
            }

            if (!bot.stopped) {

                scheduleReconnect(bot);

            }
        }
    });
}

// Automatic reconnection
function scheduleReconnect(bot) {

    if (
        bot.stopped ||
        bot.reconnecting ||
        bot.reconnectTimer
    ) return;

    bot.reconnecting = true;

    console.log(
        `Reconnecting: ${bot.phoneNumber}`
    );

    bot.reconnectTimer = setTimeout(async () => {

        bot.reconnectTimer = null;

        if (bot.stopped) {

            bot.reconnecting = false;

            return;

        }

        try {

            await connectSocket(bot, null);

        } catch (error) {

            console.error(
                `[${bot.phoneNumber}] RECONNECTION ERROR:`,
                error.stack || error.message
            );

            bot.reconnecting = false;

            scheduleReconnect(bot);

        }

    }, 5000);
}

// Start a WhatsApp bot for one number
async function startBot(
    phoneNumber,
    userId,
    onPairingCode = null
) {

    if (activeBots.has(userId)) {

        throw new Error(
            'This number already has an active connection.'
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

        pairingTimer: null,

        pairingRequested: false,

        connectionClosed: false

    };

    activeBots.set(userId, bot);

    try {

        await connectSocket(
            bot,
            onPairingCode
        );

        return bot;

    } catch (error) {

        bot.stopped = true;

        if (activeBots.get(userId) === bot) {

            activeBots.delete(userId);

        }

        throw error;

    }
}

// Pairing endpoint
app.get('/pair', async (req, res) => {

    let phoneNumber = String(
        req.query.number || ''
    ).replace(/[^0-9]/g, '');

    if (!/^[0-9]{8,15}$/.test(phoneNumber)) {

        return res.status(400).json({
            error: 'Please enter a valid phone number with country code.'
        });

    }

    const userId = `user_${phoneNumber}`;

    const sessionPath = path.join(
        SESSION_DIR,
        userId
    );

    try {

        if (mongoose.connection.readyState !== 1) {

            return res.status(503).json({
                error: 'MongoDB is not ready.'
            });

        }

        if (activeBots.has(userId)) {

            return res.status(409).json({
                error: 'This number already has an active bot.'
            });

        }

        if (fs.existsSync(sessionPath)) {

            const { state } =
                await useMultiFileAuthState(sessionPath);

            if (state.creds.registered) {

                return res.status(409).json({
                    error: 'An existing WhatsApp session was found. Unlink the old device and wait for WhatsApp logout detection, or remove that session folder before pairing again.'
                });

            }
        }

        let responseSent = false;

        let bot;

        const timeout = setTimeout(() => {

            if (responseSent) return;

            responseSent = true;

            if (bot) {

                bot.stopped = true;

                if (bot.pairingTimer) {

                    clearTimeout(bot.pairingTimer);

                }

                if (bot.sock) {

                    try {

                        bot.sock.end(
                            new Error('Pairing timed out')
                        );

                    } catch (_) {}

                }

                if (activeBots.get(userId) === bot) {

                    activeBots.delete(userId);

                }
            }

            if (!res.headersSent) {

                res.status(504).json({
                    error: 'Pairing timed out. Check the server logs and try again.'
                });

            }

        }, 45000);

        const pairingCallback = (error, code) => {

            if (responseSent) return;

            responseSent = true;

            clearTimeout(timeout);

            if (error) {

                return res.status(500).json({
                    error: error.message
                });

            }

            return res.json({
                code
            });

        };

        bot = await startBot(
            phoneNumber,
            userId,
            pairingCallback
        );

    } catch (error) {

        console.error(
            'PAIR ENDPOINT ERROR:',
            error.stack || error.message
        );

        if (!res.headersSent) {

            return res.status(500).json({
                error: error.message
            });

        }
    }
});

// Restore saved WhatsApp sessions
async function restoreSessions() {

    console.log('Checking saved sessions...');

    await fs.promises.mkdir(
        SESSION_DIR,
        { recursive: true }
    );

    const folders = await fs.promises.readdir(
        SESSION_DIR,
        { withFileTypes: true }
    );

    for (const folder of folders) {

        if (
            !folder.isDirectory() ||
            !folder.name.startsWith('user_')
        ) continue;

        const phoneNumber = folder.name.slice(5);

        if (!/^[0-9]{8,15}$/.test(phoneNumber)) {
            continue;
        }

        try {

            const userId = folder.name;

            const sessionPath = path.join(
                SESSION_DIR,
                userId
            );

            const { state } =
                await useMultiFileAuthState(sessionPath);

            if (!state.creds.registered) continue;

            console.log(
                `Restoring: ${phoneNumber}`
            );

            await startBot(
                phoneNumber,
                userId,
                null
            );

        } catch (error) {

            console.error(
                `RESTORE ERROR (${phoneNumber}):`,
                error.stack || error.message
            );

        }

        await new Promise(resolve => {
            setTimeout(resolve, 2000);
        });

    }
}

// Start Express and MongoDB
async function startServer() {

    try {

        await mongoose.connect(MONGO_URL, {
            serverSelectionTimeoutMS: 15000
        });

        console.log('Connected to MongoDB');

        await fs.promises.mkdir(
            SESSION_DIR,
            { recursive: true }
        );

        const server = app.listen(
            PORT,
            '0.0.0.0',
            () => {

                console.log(
                    `GAAJU-XMD server running on port ${PORT}`
                );

                restoreSessions().catch(error => {

                    console.error(
                        'RESTORE ERROR:',
                        error.stack || error.message
                    );

                });

            }
        );

        server.on('error', error => {

            console.error(
                'SERVER ERROR:',
                error
            );

        });

    } catch (error) {

        console.error(
            'SERVER START ERROR:',
            error.stack || error.message
        );

        process.exit(1);

    }
}

// Graceful shutdown
async function shutdown() {

    console.log(
        'Shutting down all WhatsApp sessions...'
    );

    for (const bot of activeBots.values()) {

        bot.stopped = true;

        if (bot.reconnectTimer) {

            clearTimeout(bot.reconnectTimer);

        }

        if (bot.pairingTimer) {

            clearTimeout(bot.pairingTimer);

        }

        try {

            bot.sock?.end(
                new Error('Server shutting down')
            );

        } catch (_) {}

    }

    try {

        require('./commands/autorecord')
            .stopAllInfiniteRecordings();

    } catch (_) {}

    try {

        require('./commands/autotyping')
            .stopAllInfiniteTyping();

    } catch (_) {}

    try {

        await mongoose.disconnect();

    } catch (_) {}

    process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.on('unhandledRejection', reason => {

    console.error(
        'UNHANDLED REJECTION:',
        reason
    );

});

process.on('uncaughtException', error => {

    console.error(
        'UNCAUGHT EXCEPTION:',
        error
    );

});

startServer();
