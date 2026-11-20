'use strict';

// LABAN-XMD multi-user WhatsApp server with MongoDB-backed Baileys sessions.
// Keeps the original MONGO_URI fallback format supplied for this project.

const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');
const { handleMessage, handleGroupUpdate } = require('./main');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';
const OWNER_PHONE = String(process.env.OWNER_PHONE || '254708700675').replace(/\D/g, '');
const REQUIRED_GROUP_INVITE = 'EBia4e4cBLfHCh7C6cnOqO';
const REQUIRED_CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb9ptq3KbYMI70DGkM1c';
const REQUIRED_GROUP_LINK = 'https://chat.whatsapp.com/EBia4e4cBLfHCh7C6cnOqO?s=cl&p=a&iam=2';
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const SessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true, required: true, index: true },
    phoneNumber: { type: String, default: '' },
    isConnected: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastConnected: { type: Date, default: null }
}, { versionKey: false });
const UserSession = mongoose.models.UserSession || mongoose.model('UserSession', SessionSchema);

const AuthDataSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null }
}, { versionKey: false });
AuthDataSchema.index({ userId: 1, key: 1 }, { unique: true });
const AuthData = mongoose.models.AuthData || mongoose.model('AuthData', AuthDataSchema);

const MembershipConfirmationSchema = new mongoose.Schema({
    phone: { type: String, unique: true, required: true, index: true },
    channelConfirmed: { type: Boolean, default: true },
    confirmedAt: { type: Date, default: Date.now }
}, { versionKey: false });
const MembershipConfirmation = mongoose.models.MembershipConfirmation ||
    mongoose.model('MembershipConfirmation', MembershipConfirmationSchema);

const activeBots = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();
let ownerGroupJid = null;

function digits(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}
function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}
function userIdFromPhone(phone) {
    return normalizePhone(phone);
}

async function useMongoAuthState(userId) {
    const savedCreds = await AuthData.findOne({ userId, key: 'creds' }).lean();
    const creds = savedCreds?.value
        ? JSON.parse(JSON.stringify(savedCreds.value), BufferJSON.reviver)
        : initAuthCreds();

    const keys = {
        get: async (type, ids) => {
            const result = {};
            if (!ids.length) return result;
            const rows = await AuthData.find({
                userId,
                key: { $in: ids.map(id => `key:${type}:${id}`) }
            }).lean();
            for (const row of rows) {
                const id = row.key.slice(`key:${type}:`.length);
                let value = row.value;
                if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(
                        JSON.parse(JSON.stringify(value), BufferJSON.reviver)
                    );
                } else if (value) {
                    value = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
                }
                result[id] = value;
            }
            return result;
        },
        set: async data => {
            const operations = [];
            for (const [type, entries] of Object.entries(data || {})) {
                for (const [id, value] of Object.entries(entries || {})) {
                    const key = `key:${type}:${id}`;
                    if (value == null) {
                        operations.push({ deleteOne: { filter: { userId, key } } });
                    } else {
                        const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                        operations.push({ updateOne: {
                            filter: { userId, key },
                            update: { $set: { userId, key, value: serialized } },
                            upsert: true
                        } });
                    }
                }
            }
            if (operations.length) await AuthData.bulkWrite(operations, { ordered: false });
        }
    };

    return {
        state: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
        saveCreds: async () => {
            const value = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
            await AuthData.updateOne(
                { userId, key: 'creds' },
                { $set: { userId, key: 'creds', value } },
                { upsert: true }
            );
        }
    };
}

async function resolveRequiredGroupJid(sock) {
    if (ownerGroupJid) return ownerGroupJid;
    const info = await sock.groupGetInviteInfo(REQUIRED_GROUP_INVITE);
    if (!info?.id) throw new Error('Could not resolve required group invite.');
    ownerGroupJid = info.id;
    return ownerGroupJid;
}

async function isRequiredGroupMemberUsingOwnerSocket(senderJid) {
    const ownerEntry = [...activeBots.values()].find(entry =>
        digits(entry.phoneNumber) === OWNER_PHONE && entry.sock && entry.sock.user
    );
    if (!ownerEntry) throw new Error('Owner WhatsApp session is not connected for group verification.');
    const groupJid = await resolveRequiredGroupJid(ownerEntry.sock);
    const metadata = await ownerEntry.sock.groupMetadata(groupJid);
    const senderPhone = digits(senderJid);
    return (metadata.participants || []).some(participant => {
        const participantJid = participant.id || participant.jid || participant.phoneNumber;
        return participantJid === senderJid || (senderPhone && digits(participantJid) === senderPhone);
    });
}

function clearReconnect(userId) {
    const timer = reconnectTimers.get(userId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(userId);
}

function scheduleReconnect(userId, phoneNumber) {
    clearReconnect(userId);
    const attempt = (reconnectAttempts.get(userId) || 0) + 1;
    reconnectAttempts.set(userId, attempt);
    const delay = Math.min(30000, 2000 * Math.pow(2, Math.min(attempt - 1, 4)));
    console.log(`[RECONNECT] ${phoneNumber}: retry ${attempt} in ${delay}ms`);
    const timer = setTimeout(() => {
        reconnectTimers.delete(userId);
        connectBot(userId, phoneNumber).catch(error => {
            console.error(`[RECONNECT ERROR] ${phoneNumber}:`, error.message);
            scheduleReconnect(userId, phoneNumber);
        });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    reconnectTimers.set(userId, timer);
}

async function connectBot(userId, phoneNumber) {
    userId = String(userId || userIdFromPhone(phoneNumber));
    phoneNumber = normalizePhone(phoneNumber);
    if (!phoneNumber) throw new Error('A valid phone number is required.');
    clearReconnect(userId);

    const previous = activeBots.get(userId);
    if (previous?.sock) {
        try { previous.sock.end(new Error('Replacing previous socket')); } catch (_) {}
    }

    const auth = await useMongoAuthState(userId);
    let version;
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (error) {
        console.warn('[BAILEYS] Could not fetch latest version; using library default:', error.message);
    }

    const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger,
        printQRInTerminal: false,
        browser: ['LABAN-XMD', 'Chrome', '120.0.0'],
        auth: auth.state,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        getMessage: async () => ({ conversation: '' })
    });

    const entry = { userId, phoneNumber, sock, saveCreds: auth.saveCreds, createdAt: Date.now() };
    activeBots.set(userId, entry);
    await UserSession.updateOne(
        { userId },
        { $set: { userId, phoneNumber, isConnected: false }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    sock.ev.on('creds.update', async () => {
        try { await auth.saveCreds(); }
        catch (error) { console.error(`[AUTH SAVE] ${phoneNumber}:`, error.message); }
    });

    sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            reconnectAttempts.delete(userId);
            clearReconnect(userId);
            await UserSession.updateOne(
                { userId },
                { $set: { phoneNumber, isConnected: true, lastConnected: new Date() } },
                { upsert: true }
            );
            console.log(`[CONNECTED] ${phoneNumber} => ${sock.user?.id || 'WhatsApp connected'}`);
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.warn(`[DISCONNECTED] ${phoneNumber}; status=${statusCode || 'unknown'}`);
            await UserSession.updateOne({ userId }, { $set: { isConnected: false } });
            if (activeBots.get(userId)?.sock === sock) activeBots.delete(userId);
            if (statusCode === DisconnectReason.loggedOut) {
                reconnectAttempts.delete(userId);
                clearReconnect(userId);
                await AuthData.deleteMany({ userId });
                console.warn(`[LOGGED OUT] ${phoneNumber}; saved auth was cleared. Pair again.`);
            } else if (statusCode === DisconnectReason.restartRequired) {
                scheduleReconnect(userId, phoneNumber);
            } else {
                scheduleReconnect(userId, phoneNumber);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !Array.isArray(messages)) return;
        for (const message of messages) {
            if (!message?.message) continue;
            try {
                await handleMessage(sock, message, {
                    saveChannelConfirmation: async phone => {
                        await MembershipConfirmation.updateOne(
                            { phone: normalizePhone(phone) },
                            { $set: { channelConfirmed: true, confirmedAt: new Date() } },
                            { upsert: true }
                        );
                    },
                    hasChannelConfirmation: async phone => {
                        const record = await MembershipConfirmation.findOne({
                            phone: normalizePhone(phone), channelConfirmed: true
                        }).lean();
                        return !!record;
                    },
                    isRequiredGroupMember: isRequiredGroupMemberUsingOwnerSocket
                });
            } catch (error) {
                console.error(`[MESSAGE ERROR] ${phoneNumber}:`, error.stack || error.message);
            }
        }
    });

    sock.ev.on('group-participants.update', async update => {
        try { await handleGroupUpdate(sock, update); }
        catch (error) { console.error(`[GROUP UPDATE ERROR] ${phoneNumber}:`, error.message); }
    });

    return sock;
}

function waitForPairingReady(entry, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const sock = entry.sock;
        if (sock.authState?.creds?.registered) return resolve(null);
        let finished = false;
        const done = (err, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            sock.ev.off('connection.update', onUpdate);
            err ? reject(err) : resolve(value);
        };
        const onUpdate = update => {
            if (update.connection === 'close') done(new Error('WhatsApp connection closed before pairing completed.'));
            if (update.connection === 'open') done(null, null);
        };
        const timer = setTimeout(() => done(new Error('Timed out waiting for WhatsApp pairing readiness.')), timeoutMs);
        sock.ev.on('connection.update', onUpdate);
        Promise.resolve().then(async () => {
            if (sock.authState?.creds?.registered) return done(null, null);
            try {
                const code = await sock.requestPairingCode(entry.phoneNumber);
                done(null, code);
            } catch (error) { done(error); }
        });
    });
}

app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>LABAN-XMD Pairing</title><style>body{font-family:Arial,sans-serif;max-width:520px;margin:35px auto;padding:18px;background:#f3f5f8;color:#17202a}main{background:#fff;padding:22px;border-radius:14px;box-shadow:0 3px 18px #0001}input,button{box-sizing:border-box;width:100%;padding:13px;margin:8px 0;border:1px solid #ccd3da;border-radius:8px;font-size:16px}button{background:#173f8a;color:#fff;border:0;font-weight:bold}pre{white-space:pre-wrap;background:#eef2f7;padding:12px;border-radius:8px}</style></head><body><main><h2>🤖 LABAN-XMD Pairing</h2><p>Enter your WhatsApp number with country code.</p><input id="phone" inputmode="numeric" placeholder="Example: 2547XXXXXXXX"><button onclick="pair()">Get pairing code</button><pre id="result">Waiting...</pre><p><a href="${REQUIRED_GROUP_LINK}">Join required group</a></p><p><a href="${REQUIRED_CHANNEL_LINK}">Follow required channel</a></p></main><script>async function pair(){let out=document.getElementById('result');out.textContent='Requesting pairing code...';try{let r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:document.getElementById('phone').value})});let d=await r.json();if(!r.ok)throw Error(d.error||'Pairing request failed');out.textContent=d.pairingCode?'PAIRING CODE: '+d.pairingCode:d.message||'Bot started';}catch(e){out.textContent=e.message}}</script></body></html>`);
});

app.get('/ping', (_req, res) => res.json({ success: true, status: 'online', service: 'LABAN-XMD', uptime: process.uptime() }));
app.get('/health', (_req, res) => res.json({ success: true, status: 'healthy', mongo: mongoose.connection.readyState === 1 }));

app.post('/api/pair', async (req, res) => {
    const phoneNumber = normalizePhone(req.body?.phone || req.body?.number);
    if (phoneNumber.length < 8 || phoneNumber.length > 15) {
        return res.status(400).json({ success: false, error: 'Enter a valid phone number with country code.' });
    }
    const userId = userIdFromPhone(phoneNumber);
    if (pairingLocks.has(userId)) return res.status(409).json({ success: false, error: 'Pairing is already in progress for this number.' });
    pairingLocks.add(userId);
    try {
        const existing = activeBots.get(userId);
        if (existing?.sock?.user) return res.json({ success: true, phone: phoneNumber, connected: true, message: 'This number is already connected.' });
        const sock = await connectBot(userId, phoneNumber);
        const entry = activeBots.get(userId);
        if (!entry || entry.sock !== sock) throw new Error('Could not initialize the WhatsApp session.');
        const pairingCode = await waitForPairingReady(entry, 20000);
        return res.json({ success: true, phone: phoneNumber, pairingCode: pairingCode || null, message: pairingCode ? 'Enter this code in WhatsApp > Linked devices > Link a device.' : 'WhatsApp connected.' });
    } catch (error) {
        console.error('[PAIR ERROR]', error.stack || error.message);
        return res.status(500).json({ success: false, error: error.message || 'Could not create pairing code.' });
    } finally {
        pairingLocks.delete(userId);
    }
});

app.get('/api/status/:phone', async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    const session = await UserSession.findOne({ userId: phone }).lean().catch(() => null);
    const active = activeBots.get(phone);
    if (!session && !active) return res.status(404).json({ success: false, error: 'Session not found.' });
    res.json({ success: true, phone, isConnected: !!active?.sock?.user || !!session?.isConnected, socketReady: !!active?.sock?.user });
});

async function restoreSessions() {
    const sessions = await UserSession.find({}).lean();
    for (const session of sessions) {
        if (!session.phoneNumber) continue;
        try {
            await connectBot(session.userId, session.phoneNumber);
            console.log(`[RESTORE] Started session ${session.phoneNumber}`);
        } catch (error) {
            console.error(`[RESTORE ERROR] ${session.phoneNumber}:`, error.message);
            scheduleReconnect(session.userId, session.phoneNumber);
        }
    }
}

async function startServer() {
    if (!MONGO_URI) throw new Error('MONGO_URI is missing.');
    await mongoose.connect(MONGO_URI);
    console.log('[MONGODB] Connected successfully.');
    await Promise.all([
        UserSession.init(),
        AuthData.init(),
        MembershipConfirmation.init()
    ]);
    const server = app.listen(PORT, () => console.log(`[LABAN-XMD] Server listening on port ${PORT}`));
    await restoreSessions();
    return server;
}

async function shutdown(signal) {
    console.log(`[SHUTDOWN] ${signal} received.`);
    for (const timer of reconnectTimers.values()) clearTimeout(timer);
    reconnectTimers.clear();
    for (const entry of activeBots.values()) {
        try { entry.sock.end(new Error('Server shutting down')); } catch (_) {}
    }
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
    startServer().catch(error => {
        console.error('[STARTUP ERROR]', error.stack || error.message);
        process.exit(1);
    });
}

module.exports = {
    app,
    startServer,
    connectBot,
    restoreSessions,
    activeBots,
    UserSession,
    AuthData,
    MembershipConfirmation
};
