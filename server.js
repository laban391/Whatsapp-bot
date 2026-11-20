'use strict';

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');
const path = require('path');

const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');

const {
    handleMessage,
    handleGroupUpdate
} = require('./main');

// ==================================================
// LABAN-XMD CONFIGURATION
// ==================================================

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';

const logger = pino({ level: 'silent' });

const MAX_RECONNECT_DELAY = 30000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (!MONGO_URI) {
    console.error('[FATAL] MONGO_URI is missing.');
    process.exit(1);
}

if (typeof handleMessage !== 'function') {
    console.error('[FATAL] handleMessage missing in main.js.');
    process.exit(1);
}

if (typeof handleGroupUpdate !== 'function') {
    console.error('[FATAL] handleGroupUpdate missing in main.js.');
    process.exit(1);
}

// ==================================================
// WEBSITE
// ==================================================

const publicFolder = path.join(__dirname, 'public');

app.use(express.static(publicFolder));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicFolder, 'index.html'));
});

// ==================================================
// MONGODB MODELS
// ==================================================

const SessionSchema = new mongoose.Schema({
    userId: {
        type: String,
        unique: true,
        required: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    isConnected: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastConnected: Date
}, {
    versionKey: false
});

const AuthDataSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true
    },
    key: {
        type: String,
        required: true
    },
    value: {
        type: String,
        default: null
    }
}, {
    versionKey: false
});

AuthDataSchema.index(
    { userId: 1, key: 1 },
    { unique: true }
);

const UserSession =
    mongoose.models.UserSession ||
    mongoose.model('UserSession', SessionSchema);

const AuthData =
    mongoose.models.AuthData ||
    mongoose.model('AuthData', AuthDataSchema);

// ==================================================
// ACTIVE BOT STORAGE
// ==================================================

const activeBots = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();

let httpServer = null;
let shuttingDown = false;

// ==================================================
// GENERAL HELPERS
// ==================================================

function normalizeNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function getUserId(phoneNumber) {
    return `user_${phoneNumber}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateConnectionStatus(userId, connected) {
    try {
        await UserSession.updateOne(
            { userId },
            {
                $set: {
                    isConnected: connected,
                    ...(connected ? {
                        lastConnected: new Date()
                    } : {})
                }
            }
        );
    } catch (error) {
        console.error('[DATABASE] Status update failed:', error.message);
    }
}

function clearReconnectTimer(userId) {
    const timer = reconnectTimers.get(userId);

    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(userId);
    }
}

// ==================================================
// MONGODB AUTHENTICATION
// ==================================================

async function useMongoAuthState(userId) {
    const CREDS_KEY = '__creds__';

    async function readValue(key) {
        const document = await AuthData.findOne({
            userId,
            key
        }).lean();

        if (!document || !document.value) {
            return null;
        }

        return JSON.parse(
            document.value,
            BufferJSON.reviver
        );
    }

    async function writeValue(key, value) {
        if (value === null || value === undefined) {
            await AuthData.deleteOne({ userId, key });
            return;
        }

        const serialized = JSON.stringify(
            value,
            BufferJSON.replacer
        );

        await AuthData.updateOne(
            { userId, key },
            {
                $set: {
                    userId,
                    key,
                    value: serialized
                }
            },
            { upsert: true }
        );
    }

    const creds =
        (await readValue(CREDS_KEY)) ||
        initAuthCreds();

    const keys = {
        async get(type, ids) {
            const result = {};

            if (!Array.isArray(ids)) {
                return result;
            }

            await Promise.all(
                ids.map(async id => {
                    const value = await readValue(`${type}:${id}`);

                    if (value !== null) {
                        result[id] =
                            type === 'app-state-sync-key'
                                ? proto.Message.AppStateSyncKeyData.fromObject(value)
                                : value;
                    }
                })
            );

            return result;
        },

        async set(data) {
            const jobs = [];

            for (const category of Object.keys(data || {})) {
                for (const id of Object.keys(data[category] || {})) {
                    jobs.push(
                        writeValue(
                            `${category}:${id}`,
                            data[category][id]
                        )
                    );
                }
            }

            await Promise.all(jobs);
        },

        async clear() {
            await AuthData.deleteMany({ userId });
        }
    };

    return {
        state: {
            creds,
            keys
        },

        async saveCreds() {
            await writeValue(CREDS_KEY, creds);
        }
    };
}

// ==================================================
// WAIT FOR PAIRING CONNECTION
// ==================================================

function waitForPairingReady(entry, timeoutMs = 20000) {
    const sock = entry.user;

    return new Promise((resolve, reject) => {
        let settled = false;
        let delayTimer = null;

        const timeout = setTimeout(() => {
            finish(new Error(
                'Timed out waiting for WhatsApp connection.'
            ));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            if (delayTimer) clearTimeout(delayTimer);

            sock.ev.off('connection.update', listener);
        }

        function finish(error) {
            if (settled) return;

            settled = true;
            cleanup();

            if (error) reject(error);
            else resolve();
        }

        function listener(update) {
            if (update.connection === 'close') {
                finish(new Error(
                    'WhatsApp connection closed before pairing.'
                ));
                return;
            }

            if (
                update.connection === 'connecting' ||
                update.qr
            ) {
                if (delayTimer) return;

                console.log(
                    `[PAIRING] WhatsApp connection starting for ${entry.phoneNumber}`
                );

                delayTimer = setTimeout(() => {
                    if (
                        entry.connectionState === 'close' ||
                        sock.ws?.isOpen === false
                    ) {
                        finish(new Error(
                            'WhatsApp connection closed before pairing code generation.'
                        ));
                        return;
                    }

                    finish();
                }, 2000);
            }

            if (update.connection === 'open') {
                finish();
            }
        }

        sock.ev.on('connection.update', listener);

        // Handle a connection event that arrived before this listener.
        if (entry.connectionState === 'connecting') {
            listener({ connection: 'connecting' });
        } else if (entry.connectionState === 'open') {
            finish();
        } else if (entry.connectionState === 'close') {
            finish(new Error('WhatsApp connection is closed.'));
        }
    });
}

// ==================================================
// RECONNECT SYSTEM
// ==================================================

function scheduleReconnect(userId, phoneNumber) {
    if (shuttingDown) return;
    if (reconnectTimers.has(userId)) return;
    if (activeBots.has(userId)) return;

    const attempts =
        (reconnectAttempts.get(userId) || 0) + 1;

    reconnectAttempts.set(userId, attempts);

    const delay = Math.min(
        2000 * Math.pow(2, attempts - 1),
        MAX_RECONNECT_DELAY
    );

    console.log(
        `[RECONNECT] ${phoneNumber} retrying in ${delay}ms`
    );

    const timer = setTimeout(async () => {
        reconnectTimers.delete(userId);

        if (shuttingDown || activeBots.has(userId)) {
            return;
        }

        try {
            const session = await UserSession.findOne({
                userId
            }).lean();

            if (!session) return;

            const saved = await AuthData.findOne({
                userId,
                key: '__creds__'
            }).lean();

            if (!saved) return;

            const creds = JSON.parse(
                saved.value,
                BufferJSON.reviver
            );

            if (!creds.registered) return;

            await connectBot(userId, phoneNumber);

        } catch (error) {
            console.error(
                '[RECONNECT] Error:',
                error.message
            );

            scheduleReconnect(userId, phoneNumber);
        }
    }, delay);

    reconnectTimers.set(userId, timer);
}

// ==================================================
// CONNECT WHATSAPP ACCOUNT
// ==================================================

async function connectBot(userId, phoneNumber) {
    if (shuttingDown) {
        throw new Error('Server is shutting down.');
    }

    const existing = activeBots.get(userId);

    if (existing) {
        return existing;
    }

    clearReconnectTimer(userId);

    const auth = await useMongoAuthState(userId);

    const latest = await fetchLatestBaileysVersion();
    const version = latest.version;

    console.log(
        `[BAILEYS] Using version ${version.join('.')}`
    );

    const sock = makeWASocket({
        version,
        logger,

        auth: {
            creds: auth.state.creds,
            keys: makeCacheableSignalKeyStore(
                auth.state.keys,
                logger
            )
        },

        browser: [
            'Ubuntu',
            'Chrome',
            '20.0.04'
        ],

        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    sock.__tenantId = userId;
    sock.__phoneNumber = phoneNumber;

    const entry = {
        user: sock,
        phoneNumber,
        auth,
        authState: auth.state,
        connectionState: 'initializing'
    };

    activeBots.set(userId, entry);

    sock.ev.on('creds.update', async () => {
        try {
            await auth.saveCreds();
        } catch (error) {
            console.error(
                `[AUTH] Save failed for ${phoneNumber}:`,
                error.message
            );
        }
    });

    // CONNECTION UPDATES
    sock.ev.on('connection.update', async update => {
        const {
            connection,
            lastDisconnect
        } = update;

        if (connection) {
            entry.connectionState = connection;
        }

        if (connection === 'open') {
            clearReconnectTimer(userId);
            reconnectAttempts.delete(userId);

            await updateConnectionStatus(userId, true);

            console.log(`[CONNECTED] ${phoneNumber}`);
        }

        if (connection === 'close') {
            await updateConnectionStatus(userId, false);

            if (activeBots.get(userId)?.user === sock) {
                activeBots.delete(userId);
            }

            const statusCode =
                lastDisconnect?.error?.output?.statusCode;

            const loggedOut =
                statusCode === DisconnectReason.loggedOut;

            const restartRequired =
                statusCode === DisconnectReason.restartRequired;

            console.log(
                `[DISCONNECTED] ${phoneNumber} | ${statusCode || 'unknown'}`
            );

            if (loggedOut) {
                console.log(`[LOGOUT] ${phoneNumber}`);

                clearReconnectTimer(userId);
                reconnectAttempts.delete(userId);

                await AuthData.deleteMany({ userId });
                await UserSession.deleteOne({ userId });

                return;
            }

            if (
                !shuttingDown &&
                auth.state.creds.registered
            ) {
                scheduleReconnect(userId, phoneNumber);
            } else if (restartRequired && !shuttingDown) {
                console.log(
                    `[RESTART] Pairing restart required for ${phoneNumber}`
                );
            }
        }
    });

    // INCOMING MESSAGES
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (
            type !== 'notify' ||
            !Array.isArray(messages)
        ) {
            return;
        }

        for (const message of messages) {
            if (!message || !message.message) continue;

            try {
                await handleMessage(sock, message);
            } catch (error) {
                console.error(
                    `[MESSAGE ERROR] ${phoneNumber}:`,
                    error.stack || error.message
                );
            }
        }
    });

    // GROUP UPDATES
    sock.ev.on('group-participants.update', async update => {
        try {
            await handleGroupUpdate(sock, update);
        } catch (error) {
            console.error(
                `[GROUP ERROR] ${phoneNumber}:`,
                error.message
            );
        }
    });

    return entry;
}

// ==================================================
// PAIRING API
// ==================================================

async function handlePairRequest(req, res) {
    const phoneNumber = normalizeNumber(
        req.body?.phoneNumber ||
        req.body?.number
    );

    if (
        phoneNumber.length < 8 ||
        phoneNumber.length > 15
    ) {
        return res.status(400).json({
            success: false,
            error: 'Enter a valid phone number with country code.'
        });
    }

    const userId = getUserId(phoneNumber);

    if (pairingLocks.has(userId)) {
        return res.status(409).json({
            success: false,
            error: 'A pairing request is already running. Please wait.'
        });
    }

    const existingEntry = activeBots.get(userId);

    if (existingEntry) {
        if (existingEntry.authState.creds.registered) {
            return res.status(409).json({
                success: false,
                error: 'This number already has a saved WhatsApp session.'
            });
        }

        return res.status(409).json({
            success: false,
            error: 'Pairing is already running for this number.'
        });
    }

    pairingLocks.add(userId);

    let entry = null;

    try {
        const saved = await AuthData.findOne({
            userId,
            key: '__creds__'
        }).lean();

        if (saved) {
            const savedCreds = JSON.parse(
                saved.value,
                BufferJSON.reviver
            );

            if (savedCreds.registered) {
                return res.status(409).json({
                    success: false,
                    error: 'This number already has a registered session. Log out before pairing again.'
                });
            }

            await AuthData.deleteMany({ userId });
        }

        await UserSession.updateOne(
            { userId },
            {
                $set: {
                    phoneNumber,
                    isConnected: false
                },
                $setOnInsert: {
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );

        entry = await connectBot(userId, phoneNumber);

        if (entry.authState.creds.registered) {
            return res.status(409).json({
                success: false,
                error: 'This number is already paired.'
            });
        }

        // Wait for Baileys connection readiness.
        await waitForPairingReady(entry);

        if (
            entry.connectionState === 'close' ||
            activeBots.get(userId)?.user !== entry.user
        ) {
            throw new Error(
                'WhatsApp connection closed. Please try again.'
            );
        }

        if (entry.authState.creds.registered) {
            return res.status(409).json({
                success: false,
                error: 'This number has already been paired.'
            });
        }

        if (
            typeof entry.user.requestPairingCode !== 'function'
        ) {
            throw new Error(
                'This Baileys version does not support pairing codes.'
            );
        }

        // Request pairing code only once per request.
        const rawCode =
            await entry.user.requestPairingCode(phoneNumber);

        if (
            typeof rawCode !== 'string' ||
            !rawCode.trim()
        ) {
            throw new Error(
                'WhatsApp did not return a pairing code.'
            );
        }

        const code = rawCode.trim();

        await entry.auth.saveCreds();

        console.log(
            `[PAIRING] Code generated for ${phoneNumber}`
        );

        return res.json({
            success: true,
            number: phoneNumber,
            phoneNumber,
            code,
            message: 'Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead.'
        });

    } catch (error) {
        console.error(
            `[PAIRING ERROR] ${phoneNumber}:`,
            error.stack || error.message
        );

        if (entry) {
            try {
                entry.user.end(undefined);
            } catch {}

            if (activeBots.get(userId)?.user === entry.user) {
                activeBots.delete(userId);
            }
        }

        return res.status(500).json({
            success: false,
            error: error.message ||
                'Could not generate pairing code. Please try again.'
        });

    } finally {
        pairingLocks.delete(userId);
    }
}

app.post('/api/pair', handlePairRequest);
app.post('/pair', handlePairRequest);

// ==================================================
// SERVER STATUS
// ==================================================

app.get('/ping', (req, res) => {
    res.json({
        status: 'online',
        service: 'LABAN-XMD',
        activeConnections: activeBots.size
    });
});

// ==================================================
// RESTORE SAVED SESSIONS
// ==================================================

async function restoreSessions() {
    console.log('[RESTORE] Checking saved MongoDB sessions...');

    const sessions = await UserSession.find({}).lean();

    let restored = 0;

    for (const session of sessions) {
        const {
            userId,
            phoneNumber
        } = session;

        if (
            !userId ||
            !phoneNumber ||
            activeBots.has(userId)
        ) {
            continue;
        }

        try {
            const saved = await AuthData.findOne({
                userId,
                key: '__creds__'
            }).lean();

            if (!saved) {
                await updateConnectionStatus(userId, false);
                continue;
            }

            const creds = JSON.parse(
                saved.value,
                BufferJSON.reviver
            );

            if (!creds.registered) {
                console.log(
                    `[RESTORE] ${phoneNumber} has not completed pairing.`
                );
                continue;
            }

            await connectBot(userId, phoneNumber);

            restored++;

            console.log(
                `[RESTORE] Reconnection started for ${phoneNumber}`
            );

            await sleep(1200);

        } catch (error) {
            console.error(
                `[RESTORE] ${phoneNumber}:`,
                error.message
            );

            scheduleReconnect(userId, phoneNumber);
        }
    }

    console.log(
        `[RESTORE] Started ${restored} saved session(s).`
    );
}

// ==================================================
// START SERVER
// ==================================================

async function startServer() {
    await mongoose.connect(MONGO_URI, {
        autoIndex: true,
        serverSelectionTimeoutMS: 30000
    });

    await Promise.all([
        UserSession.init(),
        AuthData.init()
    ]);

    console.log('[DATABASE] MongoDB connected successfully.');

    httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(
                `[SERVER] LABAN-XMD running on port ${PORT}`
            );
            resolve(server);
        });

        server.on('error', reject);
    });

    await restoreSessions();

    return httpServer;
}

// ==================================================
// SAFE SHUTDOWN
// ==================================================

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(
        `[SERVER] ${signal}: saving sessions...`
    );

    for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
    }

    reconnectTimers.clear();

    const saveJobs = [];

    for (const [userId, entry] of activeBots.entries()) {
        saveJobs.push(
            entry.auth.saveCreds().catch(error => {
                console.error(
                    `[SHUTDOWN] Save failed for ${userId}:`,
                    error.message
                );
            })
        );
    }

    await Promise.allSettled(saveJobs);

    for (const [userId, entry] of activeBots.entries()) {
        try {
            await updateConnectionStatus(userId, false);
            entry.user.end(undefined);
        } catch (error) {
            console.error(
                '[SHUTDOWN] Socket error:',
                error.message
            );
        }
    }

    activeBots.clear();

    if (httpServer) {
        await new Promise(resolve => {
            httpServer.close(resolve);
        });
    }

    try {
        await mongoose.disconnect();
    } catch (error) {
        console.error(
            '[SHUTDOWN] MongoDB error:',
            error.message
        );
    }

    console.log('[SERVER] Shutdown complete.');

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==================================================
// START APPLICATION
// ==================================================

if (require.main === module) {
    startServer().catch(error => {
        console.error(
            '[FATAL] LABAN-XMD startup failed:',
            error.stack || error.message
        );

        process.exit(1);
    });
}

module.exports = {
    app,
    startServer,
    connectBot,
    restoreSessions,
    activeBots
};
