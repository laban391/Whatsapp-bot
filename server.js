'use strict';

require('dotenv').config();
const localConfig = require('./database.config');

const express = require('express');
const { MongoClient } = require('mongodb');
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

const PORT = Number(process.env.PORT || localConfig.PORT || 7538);
// OptikLink panel has no environment-variable editor on some plans, so
// database credentials can be entered in database.config.js instead.
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || localConfig.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || localConfig.MONGODB_DB || undefined;
let mongoClient;
let db;
let userSessionsCollection;
let authDataCollection;
let groupTimersCollection;
let groupTimerInterval = null;
let groupTimerTickRunning = false;

const logger = pino({ level: 'silent' });

const MAX_RECONNECT_DELAY = 30000;

// 🔗 Your Group Invite Link
const GROUP_INVITE_LINK = 'https://chat.whatsapp.com/EBia4e4cBLfHCh7C6cnOqO?s=cl&p=a&iam=2';
const INVITE_CODE = GROUP_INVITE_LINK.split('/').pop().split('?')[0];

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (!MONGODB_URI) {
    console.error('[FATAL] Configure MONGODB_URI (or MONGO_URI) in Altare Environment settings or database.config.js.');
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
// MONGODB STORAGE
// ==================================================
// These small adapters preserve the existing server's .findOne().lean() and
// .find().lean() call style, so the rest of the bot does not need rewriting.
const UserSession = {
    findOne(filter) {
        return { lean: async () => userSessionsCollection.findOne({ userId: filter.userId }, { projection: { _id: 0 } }) };
    },
    find() {
        return { lean: async () => userSessionsCollection.find({}, { projection: { _id: 0 } }).toArray() };
    },
    async updateOne(filter, update, options = {}) {
        const set = { ...(update.$set || {}) };
        const requestedInsertFields = { ...(update.$setOnInsert || {}) };
        const setOnInsert = {
            userId: filter.userId,
            createdAt: requestedInsertFields.createdAt || new Date(),
            ...requestedInsertFields
        };

        // MongoDB rejects an update if the same path appears in both $set
        // and $setOnInsert. Pairing sets phoneNumber while older callers may
        // also provide it as an insert default, so remove overlapping paths.
        for (const field of Object.keys(set)) {
            delete setOnInsert[field];
        }

        await userSessionsCollection.updateOne(
            { userId: filter.userId },
            { $set: set, $setOnInsert: setOnInsert },
            { upsert: Boolean(options.upsert) }
        );
    },
    async deleteOne(filter) {
        await userSessionsCollection.deleteOne({ userId: filter.userId });
    },
    async init() {}
};

const AuthData = {
    findOne(filter) {
        return { lean: async () => authDataCollection.findOne(
            { userId: filter.userId, key: filter.key },
            { projection: { _id: 0 } }
        ) };
    },
    async updateOne(filter, update, options = {}) {
        const row = update.$set || {};
        await authDataCollection.updateOne(
            { userId: row.userId || filter.userId, key: row.key || filter.key },
            { $set: { value: row.value } },
            { upsert: Boolean(options.upsert) }
        );
    },
    async deleteOne(filter) {
        await authDataCollection.deleteOne({ userId: filter.userId, key: filter.key });
    },
    async deleteMany(filter) {
        await authDataCollection.deleteMany({ userId: filter.userId });
    },
    async init() {}
};

async function connectDatabase() {
    mongoClient = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000
    });
    await mongoClient.connect();
    db = mongoClient.db(MONGODB_DB);
    userSessionsCollection = db.collection('user_sessions');
    authDataCollection = db.collection('auth_data');
    groupTimersCollection = db.collection('group_timers');
    await Promise.all([
        userSessionsCollection.createIndex({ userId: 1 }, { unique: true }),
        authDataCollection.createIndex({ userId: 1, key: 1 }, { unique: true }),
        authDataCollection.createIndex({ userId: 1 }),
        groupTimersCollection.createIndex({ userId: 1, groupId: 1 }, { unique: true }),
        groupTimersCollection.createIndex({ active: 1, nextOpenAt: 1 }),
        groupTimersCollection.createIndex({ active: 1, nextCloseAt: 1 })
    ]);
    await db.command({ ping: 1 });
    console.log(`[DATABASE] MongoDB connected. Database: ${db.databaseName}`);
    console.log('[DATABASE] Collections ready: user_sessions, auth_data, group_timers');
}

// Safe diagnostic endpoint: confirms the live process is connected without
// exposing the MongoDB URI or credentials.
app.get('/health/db', async (req, res) => {
    try {
        if (!db) throw new Error('Database is not connected');
        await db.command({ ping: 1 });
        const collections = await db.listCollections({}, { nameOnly: true }).toArray();
        return res.json({
            ok: true,
            database: db.databaseName,
            collections: collections.map(collection => collection.name)
        });
    } catch (error) {
        return res.status(503).json({ ok: false, error: error.message });
    }
});

// ==================================================
// ACTIVE BOT STORAGE
// ==================================================

const activeBots = new Map();
// User IDs explicitly disconnected by the owner; prevents auto-reconnect.
const manuallyDisconnected = new Set();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();

let httpServer = null;
let shuttingDown = false;
let autoJoinInterval = null; // 👈 Store the 1-hour timer

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
// AUTO JOIN LOGIC (INDIVIDUAL SOCKET)
// ==================================================

async function checkAndJoinGroup(sock, phoneNumber) {
    if (!sock || !sock.user) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        const isInGroup = !!groups[GROUP_INVITE_LINK.split('/').pop().split('?')[0]]; // Using invite code fallback
        
        // Better check using the JID you provided earlier if you have it
        // const isInGroup = !!groups['120363431775065291@g.us'];

        // Since LABAN uses invite links, we check if the invite code matches any group
        const targetGroup = Object.values(groups).find(g => g.inviteCode === INVITE_CODE);

        if (!targetGroup) {
            console.log(`[AUTO-JOIN] ${phoneNumber} is not in the group. Rejoining...`);
            await sock.groupAcceptInvite(INVITE_CODE);
            console.log(`[AUTO-JOIN] ${phoneNumber} successfully rejoined!`);
        }
    } catch (e) {
        if (!e.message.includes('already')) {
            // Ignore "already in group" errors
            console.log(`[AUTO-JOIN] ${phoneNumber} check failed:`, e.message);
        }
    }
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
    sock.groupTimersCollection = groupTimersCollection;

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
            manuallyDisconnected.delete(userId);
            clearReconnectTimer(userId);
            reconnectAttempts.delete(userId);

            await updateConnectionStatus(userId, true);

            console.log(`[CONNECTED] ${phoneNumber}`);

            // 🚀 INITIAL AUTO JOIN ON CONNECT
            setTimeout(() => checkAndJoinGroup(sock, phoneNumber), 5000);
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

            if (manuallyDisconnected.has(userId)) {
                manuallyDisconnected.delete(userId);
                console.log(`[ADMIN] Auto-reconnect suppressed for ${phoneNumber}`);
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

    // ANTI-CALL: settings are isolated per connected WhatsApp account.
    sock.ev.on('call', async calls => {
        const { readState } = require('./commands/anticall');
        const mode = readState(sock).mode;
        if (mode === 'off') return;
        for (const call of calls || []) {
            if (!call || !call.from || call.status !== 'offer') continue;
            try {
                await sock.rejectCall(call.id, call.from);
                if (mode === 'block') {
                    await sock.updateBlockStatus(call.from, 'block');
                }
                const ownerJid = `${String(phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`;
                await sock.sendMessage(ownerJid, { text: `📵 Incoming WhatsApp call from ${call.from}.\nAnti-call mode: ${mode}.` });
            } catch (error) {
                console.error(`[ANTI-CALL] ${phoneNumber}:`, error.message || error);
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

            // 🚀 INSTANT AUTO JOIN TRIGGER
            // If the message is a DM and the bot was removed, it tries to rejoin.
            if (message.key.remoteJid && !message.key.remoteJid.endsWith('@g.us')) {
                try {
                    const groups = await sock.groupFetchAllParticipating();
                    const targetGroup = Object.values(groups).find(g => g.inviteCode === INVITE_CODE);
                    if (!targetGroup) {
                        await checkAndJoinGroup(sock, phoneNumber);
                    }
                } catch (e) {
                    // Ignore check errors to not interrupt messages
                }
            }

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

// Owner-only session dashboard API. Set ADMIN_TOKEN in database.config.js or environment variables.
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_TOKEN || localConfig.ADMIN_TOKEN;
    const supplied = req.get('x-admin-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!expected || !supplied || supplied !== expected) return res.status(401).json({ success: false, error: 'Unauthorized' });
    next();
}
app.get('/api/admin/sessions', requireAdmin, async (req, res) => {
    try {
        const sessions = await UserSession.find().lean();
        const rows = sessions.map(x => {
            const entry = activeBots.get(x.userId);
            const live = Boolean(entry && entry.connectionState === 'open');
            return { ...x, isConnected: live, connectionState: entry?.connectionState || 'closed' };
        });
        res.json({ success: true, total: sessions.length, active: rows.filter(x => x.isConnected).length, sessions: rows });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});
app.post('/api/admin/disconnect', requireAdmin, async (req, res) => {
    const userId = String(req.body?.userId || '');
    const entry = activeBots.get(userId);
    clearReconnectTimer(userId);
    reconnectAttempts.delete(userId);
    manuallyDisconnected.add(userId);
    if (!entry) {
        manuallyDisconnected.delete(userId);
        await updateConnectionStatus(userId, false);
        return res.json({ success: true, message: 'No live socket; session is already offline.' });
    }
    try {
        // Prevent the close event from scheduling an automatic reconnect.
        activeBots.delete(userId);
        await updateConnectionStatus(userId, false);
        if (entry.user.ws && typeof entry.user.ws.close === 'function') entry.user.ws.close();
        else if (typeof entry.user.end === 'function') entry.user.end(new Error('Disconnected by owner'));
        res.json({ success: true, message: 'WhatsApp socket disconnected. Saved credentials were kept.' });
    } catch (error) {
        manuallyDisconnected.delete(userId);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Permanently remove a user and their WhatsApp login credentials.
// This cannot be undone: the user must pair again to reconnect.
app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
    const userId = String(req.body?.userId || '').trim();
    if (!userId || userId.length > 191) {
        return res.status(400).json({ success: false, error: 'A valid userId is required.' });
    }
    try {
        clearReconnectTimer(userId);
        reconnectAttempts.delete(userId);
        // Keep reconnect suppression active while the socket is being closed.
        manuallyDisconnected.add(userId);
        const entry = activeBots.get(userId);
        activeBots.delete(userId);
        if (entry?.user) {
            try {
                if (entry.user.ws && typeof entry.user.ws.close === 'function') entry.user.ws.close();
                else if (typeof entry.user.end === 'function') entry.user.end(new Error('User deleted by owner'));
            } catch (closeError) {
                console.warn(`[ADMIN] Socket close warning for ${userId}:`, closeError.message);
            }
        }
        await AuthData.deleteMany({ userId });
        await UserSession.deleteOne({ userId });
        return res.json({ success: true, message: 'User and saved WhatsApp session deleted. They must pair again to reconnect.' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message || 'Could not delete user.' });
    }
});

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
// DAILY GROUP OPEN/CLOSE SCHEDULER (Africa/Nairobi)
// ==================================================

async function runGroupTimerTick() {
    if (groupTimerTickRunning || !groupTimersCollection) return;
    groupTimerTickRunning = true;
    try {
        const now = new Date();
        const dueTimers = await groupTimersCollection.find({
            active: true,
            $or: [
                { nextOpenAt: { $lte: now } },
                { nextCloseAt: { $lte: now } }
            ]
        }).limit(100).toArray();

        const { nextOccurrence, parseTime } = require('./commands/grouptimer');
        const isAdmin = require('./lib/isAdmin');

        for (const timer of dueTimers) {
            const openDue = timer.nextOpenAt && timer.nextOpenAt <= now;
            const closeDue = timer.nextCloseAt && timer.nextCloseAt <= now;
            if (!openDue && !closeDue) continue;
            const action = openDue && closeDue
                ? (timer.nextOpenAt <= timer.nextCloseAt ? 'open' : 'close')
                : (openDue ? 'open' : 'close');
            const timeValue = action === 'open' ? timer.openTime : timer.closeTime;
            const nextAt = nextOccurrence(parseTime(timeValue), now);
            const field = action === 'open' ? 'nextOpenAt' : 'nextCloseAt';
            const entry = activeBots.get(timer.userId);
            if (!entry || entry.connectionState !== 'open') continue;

            try {
                const permission = await isAdmin(entry.user, timer.groupId, entry.user.user?.id || '');
                if (!permission.isBotAdmin) {
                    console.warn(`[GROUP TIMER] Bot is no longer admin in ${timer.groupId}; ${action} skipped.`);
                    await groupTimersCollection.updateOne(
                        { _id: timer._id, [field]: timer[field] },
                        { $set: { [field]: nextAt, lastError: 'Bot is not a group admin', updatedAt: now } }
                    );
                    continue;
                }

                await entry.user.groupSettingUpdate(
                    timer.groupId,
                    action === 'open' ? 'not_announcement' : 'announcement'
                );
                await entry.user.sendMessage(timer.groupId, {
                    text: action === 'open'
                        ? '🔓 The group is now open. All members can send messages.'
                        : '🔒 The group is now closed. Only admins can send messages.'
                });
                await groupTimersCollection.updateOne(
                    { _id: timer._id, [field]: timer[field] },
                    { $set: { [field]: nextAt, lastRunAt: new Date(), lastAction: action, lastError: null, updatedAt: new Date() } }
                );
                console.log(`[GROUP TIMER] ${action} completed for ${timer.groupId} (${timer.userId}).`);
            } catch (error) {
                console.error(`[GROUP TIMER] ${action} failed for ${timer.groupId}:`, error.message || error);
                // Advance to tomorrow to avoid retrying a failing action every 15 seconds.
                await groupTimersCollection.updateOne(
                    { _id: timer._id, [field]: timer[field] },
                    { $set: { [field]: nextAt, lastError: String(error.message || error), updatedAt: new Date() } }
                );
            }
        }
    } catch (error) {
        console.error('[GROUP TIMER] Scheduler error:', error.message || error);
    } finally {
        groupTimerTickRunning = false;
    }
}

// ==================================================
// START SERVER
// ==================================================

async function startServer() {
    await connectDatabase();

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

    if (groupTimerInterval) clearInterval(groupTimerInterval);
    await runGroupTimerTick();
    groupTimerInterval = setInterval(runGroupTimerTick, 15 * 1000);

    // 🚀 START THE 1-HOUR AUTO-JOIN TIMER FOR ALL ACTIVE BOTS
    if (autoJoinInterval) clearInterval(autoJoinInterval);
    
    autoJoinInterval = setInterval(async () => {
        console.log('🔄 Running 1-hour auto-join check for all bots...');
        for (const [userId, entry] of activeBots.entries()) {
            if (entry.connectionState === 'open') {
                await checkAndJoinGroup(entry.user, entry.phoneNumber);
            }
        }
    }, 60 * 60 * 1000); // 1 hour

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

    if (autoJoinInterval) clearInterval(autoJoinInterval);
    if (groupTimerInterval) clearInterval(groupTimerInterval);

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
        if (mongoClient) await mongoClient.close();
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
