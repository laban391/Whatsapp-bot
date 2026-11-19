
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');
const path = require('path');

const baileys = require('@whiskeysockets/baileys');

const makeWASocket = baileys.default || baileys.makeWASocket;

const {
  DisconnectReason,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
  proto
} = baileys;

const {
  handleMessage,
  handleGroupUpdate
} = require('./main');

// ======================================================
// LABAN-XMD CONFIGURATION
// ======================================================

const PORT = Number(process.env.PORT) || 3000;

// Replace YOUR_NEW_PASSWORD with your new MongoDB Atlas password.
// URL-encode special characters in the password.
const MONGO_URI =
  'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';

if (MONGO_URI.includes('YOUR_NEW_PASSWORD')) {
  console.error('[LABAN-XMD] Add your new MongoDB password in server.js.');
  process.exit(1);
}

const logger = pino({ level: 'silent' });

// ======================================================
// EXPRESS SERVER
// ======================================================

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const publicFolder = path.join(__dirname, 'public');

app.use(express.static(publicFolder));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicFolder, 'index.html'));
});

// ======================================================
// ACTIVE CONNECTION STORAGE
// ======================================================

const activeBots = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();

let httpServer = null;
let shuttingDown = false;

// ======================================================
// DATABASE MODELS
// ======================================================

const sessionSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true
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
  lastConnected: {
    type: Date,
    default: null
  }
}, { versionKey: false });

const authDataSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  key: {
    type: String,
    required: true
  },
  value: {
    type: String,
    required: true
  }
}, { versionKey: false });

authDataSchema.index(
  { userId: 1, key: 1 },
  { unique: true }
);

const UserSession =
  mongoose.models.UserSession ||
  mongoose.model('UserSession', sessionSchema);

const AuthData =
  mongoose.models.AuthData ||
  mongoose.model('AuthData', authDataSchema);

// ======================================================
// GENERAL HELPERS
// ======================================================

function normalizePhoneNumber(number) {
  return String(number || '').replace(/\D/g, '');
}

function getUserId(phoneNumber) {
  return `user_${phoneNumber}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSocketActive(sock) {
  return Boolean(sock && sock.user && sock.user.id);
}

async function updateSessionStatus(userId, connected) {
  try {
    await UserSession.updateOne(
      { userId },
      {
        $set: {
          isConnected: connected,
          ...(connected ? { lastConnected: new Date() } : {})
        }
      }
    );
  } catch (error) {
    console.error('[DATABASE] Status update failed:', error.message);
  }
}

// ======================================================
// MONGODB AUTHENTICATION STORAGE
// ======================================================

async function useMongoAuthState(userId) {
  const credentialsDocument = await AuthData.findOne({
    userId,
    key: '__creds__'
  }).lean();

  let creds;

  if (credentialsDocument && credentialsDocument.value) {
    creds = JSON.parse(
      credentialsDocument.value,
      BufferJSON.reviver
    );
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    await AuthData.updateOne(
      {
        userId,
        key: '__creds__'
      },
      {
        $set: {
          value: JSON.stringify(creds, BufferJSON.replacer)
        }
      },
      { upsert: true }
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};

      if (!ids || !ids.length) {
        return result;
      }

      const documents = await AuthData.find({
        userId,
        key: {
          $in: ids.map(id => `${type}:${id}`)
        }
      }).lean();

      for (const document of documents) {
        const id = document.key.slice(type.length + 1);

        try {
          let value = JSON.parse(
            document.value,
            BufferJSON.reviver
          );

          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }

          result[id] = value;
        } catch (error) {
          console.error('[AUTH] Could not read key:', error.message);
        }
      }

      return result;
    },

    set: async data => {
      const operations = [];

      for (const [type, entries] of Object.entries(data || {})) {
        for (const [id, value] of Object.entries(entries || {})) {
          const key = `${type}:${id}`;

          if (value === null || value === undefined) {
            operations.push({
              deleteOne: {
                filter: { userId, key }
              }
            });
          } else {
            operations.push({
              updateOne: {
                filter: { userId, key },
                update: {
                  $set: {
                    value: JSON.stringify(value, BufferJSON.replacer)
                  }
                },
                upsert: true
              }
            });
          }
        }
      }

      if (operations.length) {
        await AuthData.bulkWrite(operations, {
          ordered: false
        });
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

// ======================================================
// WAIT FOR WHATSAPP CONNECTION TO INITIALIZE
// ======================================================

function waitForPairingReady(sock, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = () => {
      clearTimeout(timer);
      sock.ev.off('connection.update', onUpdate);
    };

    const finish = error => {
      if (finished) return;

      finished = true;
      cleanup();

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onUpdate = update => {
      if (
        update.connection === 'connecting' ||
        update.connection === 'open'
      ) {
        finish();
      }

      if (update.connection === 'close') {
        finish(new Error(
          'WhatsApp disconnected before the pairing code was generated.'
        ));
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(
        'WhatsApp connection timed out. Please try again.'
      ));
    }, timeoutMs);

    sock.ev.on('connection.update', onUpdate);

    if (
      sock.__connectionState === 'connecting' ||
      sock.__connectionState === 'open'
    ) {
      finish();
    }
  });
}

// ======================================================
// RECONNECTION SYSTEM
// ======================================================

function clearReconnectTimer(userId) {
  const timer = reconnectTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(userId);
  }
}

function scheduleReconnect(userId, phoneNumber) {
  if (shuttingDown || reconnectTimers.has(userId)) {
    return;
  }

  const attempts = (reconnectAttempts.get(userId) || 0) + 1;
  reconnectAttempts.set(userId, attempts);

  const delay = Math.min(
    5000 * Math.pow(2, Math.min(attempts - 1, 5)),
    120000
  );

  console.log(
    `[RECONNECT] ${phoneNumber} retrying in ${Math.round(delay / 1000)} seconds`
  );

  const timer = setTimeout(async () => {
    reconnectTimers.delete(userId);

    if (shuttingDown || activeBots.has(userId)) {
      return;
    }

    try {
      await connectBot(phoneNumber);
    } catch (error) {
      console.error('[RECONNECT] Failed:', error.message);
      scheduleReconnect(userId, phoneNumber);
    }
  }, delay);

  reconnectTimers.set(userId, timer);
}

// ======================================================
// CONNECT WHATSAPP BOT
// ======================================================

async function connectBot(phoneNumber) {
  const userId = getUserId(phoneNumber);

  if (shuttingDown) {
    throw new Error('Server is shutting down.');
  }

  if (activeBots.has(userId)) {
    return activeBots.get(userId);
  }

  clearReconnectTimer(userId);

  const { state, saveCreds } = await useMongoAuthState(userId);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: ['LABAN-XMD', 'Chrome', '1.0.0'],
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  sock.__tenantId = userId;
  sock.__phoneNumber = phoneNumber;
  sock.__authState = state;
  sock.__connectionState = null;

  activeBots.set(userId, sock);

  // Save authentication updates.
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      console.error('[AUTH] Credential save failed:', error.message);
    }
  });

  // Monitor WhatsApp connection.
  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;

    sock.__connectionState = connection;

    if (connection === 'open') {
      reconnectAttempts.delete(userId);

      await updateSessionStatus(userId, true);

      console.log(`[CONNECTED] LABAN-XMD: ${phoneNumber}`);
    }

    if (connection === 'close') {
      await updateSessionStatus(userId, false);

      if (activeBots.get(userId) === sock) {
        activeBots.delete(userId);
      }

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        statusCode === DisconnectReason.loggedOut;

      console.log(
        `[DISCONNECTED] ${phoneNumber} | ${statusCode || 'unknown'}`
      );

      // Delete credentials only after an actual WhatsApp logout.
      if (loggedOut) {
        console.log(`[LOGOUT] ${phoneNumber} logged out.`);

        clearReconnectTimer(userId);
        reconnectAttempts.delete(userId);

        await AuthData.deleteMany({ userId });

        return;
      }

      if (!shuttingDown) {
        scheduleReconnect(userId, phoneNumber);
      }
    }
  });

  // Incoming messages.
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!Array.isArray(messages)) return;

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

  // Group updates.
  sock.ev.on('group-participants.update', async update => {
    try {
      await handleGroupUpdate(sock, update);
    } catch (error) {
      console.error(
        `[GROUP UPDATE ERROR] ${phoneNumber}:`,
        error.stack || error.message
      );
    }
  });

  return sock;
}

// ======================================================
// PAIRING API
// ======================================================

async function handlePairRequest(req, res) {
  const phoneNumber = normalizePhoneNumber(
    req.body?.phoneNumber || req.body?.number
  );

  if (!phoneNumber || phoneNumber.length < 8 || phoneNumber.length > 15) {
    return res.status(400).json({
      success: false,
      error: 'Enter a valid phone number with country code. Use digits only.'
    });
  }

  const userId = getUserId(phoneNumber);

  if (pairingLocks.has(userId)) {
    return res.status(429).json({
      success: false,
      error: 'Pairing is already in progress. Please wait.'
    });
  }

  pairingLocks.add(userId);

  try {
    const existingBot = activeBots.get(userId);

    if (existingBot && isSocketActive(existingBot)) {
      return res.status(409).json({
        success: false,
        error: 'This WhatsApp number is already connected.'
      });
    }

    // Never generate a new pairing code for an existing session.
    const savedCredentials = await AuthData.findOne({
      userId,
      key: '__creds__'
    }).lean();

    if (savedCredentials) {
      const savedCreds = JSON.parse(
        savedCredentials.value,
        BufferJSON.reviver
      );

      if (savedCreds.registered) {
        return res.status(409).json({
          success: false,
          error: 'This number already has a saved session. It should reconnect automatically. Do not pair again unless you have logged out.'
        });
      }
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

    const sock = await connectBot(phoneNumber);

    if (sock.__authState?.creds?.registered) {
      return res.status(409).json({
        success: false,
        error: 'This number already has a registered WhatsApp session.'
      });
    }

    // Wait for the socket to initialize before requesting a code.
    await waitForPairingReady(sock);

    // Give the connection handshake a little time to settle.
    await sleep(2000);

    if (sock.__authState?.creds?.registered) {
      return res.status(409).json({
        success: false,
        error: 'This number has already been registered.'
      });
    }

    if (typeof sock.requestPairingCode !== 'function') {
      throw new Error(
        'Pairing code generation is unavailable in this Baileys version.'
      );
    }

    // Pass the international phone number as digits only.
    const rawCode = await sock.requestPairingCode(phoneNumber);

    if (!rawCode || !String(rawCode).trim()) {
      throw new Error('WhatsApp did not return a pairing code. Try again.');
    }

    // Preserve the code exactly as returned by Baileys.
    const code = String(rawCode).trim();

    console.log(`[PAIRING] Code generated for ${phoneNumber}`);

    return res.json({
      success: true,
      phoneNumber,
      code,
      message: 'Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead.'
    });

  } catch (error) {
    console.error(
      `[PAIRING ERROR] ${phoneNumber}:`,
      error.stack || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.message || 'Could not generate pairing code.'
    });

  } finally {
    pairingLocks.delete(userId);
  }
}

app.post('/api/pair', handlePairRequest);
app.post('/pair', handlePairRequest);

// ======================================================
// RESTORE SESSIONS AFTER REDEPLOY
// ======================================================

async function restoreSessions() {
  console.log('[RESTORE] Checking MongoDB for saved sessions...');

  const sessions = await UserSession.find({}).lean();

  let restored = 0;

  for (const session of sessions) {
    const { userId, phoneNumber } = session;

    if (!userId || !phoneNumber || activeBots.has(userId)) {
      continue;
    }

    const savedCredentials = await AuthData.findOne({
      userId,
      key: '__creds__'
    }).lean();

    if (!savedCredentials) {
      await updateSessionStatus(userId, false);
      continue;
    }

    let creds;

    try {
      creds = JSON.parse(
        savedCredentials.value,
        BufferJSON.reviver
      );
    } catch (error) {
      console.error(
        `[RESTORE] Invalid credentials for ${phoneNumber}:`,
        error.message
      );
      continue;
    }

    if (!creds.registered) {
      console.log(`[RESTORE] ${phoneNumber} has not completed pairing.`);
      continue;
    }

    try {
      await connectBot(phoneNumber);

      restored++;

      console.log(`[RESTORE] Reconnection started for ${phoneNumber}.`);

      await sleep(1200);

    } catch (error) {
      console.error(
        `[RESTORE] Could not restore ${phoneNumber}:`,
        error.message
      );

      scheduleReconnect(userId, phoneNumber);
    }
  }

  console.log(`[RESTORE] Started ${restored} saved session(s).`);
}

// ======================================================
// SERVER STARTUP
// ======================================================

async function startServer() {
  await mongoose.connect(MONGO_URI, {
    autoIndex: true,
    serverSelectionTimeoutMS: 30000
  });

  console.log('[DATABASE] MongoDB Atlas connected.');

  await UserSession.createIndexes();
  await AuthData.createIndexes();

  httpServer = await new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] LABAN-XMD running on port ${PORT}`);
      resolve(server);
    });

    server.on('error', reject);
  });

  await restoreSessions();

  return httpServer;
}

// ======================================================
// SAFE SHUTDOWN
// ======================================================

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`[SERVER] ${signal}: saving sessions...`);

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }

  reconnectTimers.clear();

  const saveOperations = [];

  for (const [userId, sock] of activeBots.entries()) {
    try {
      if (sock.__authState?.creds) {
        saveOperations.push(
          AuthData.updateOne(
            {
              userId,
              key: '__creds__'
            },
            {
              $set: {
                value: JSON.stringify(
                  sock.__authState.creds,
                  BufferJSON.replacer
                )
              }
            },
            { upsert: true }
          )
        );
      }
    } catch (error) {
      console.error('[SHUTDOWN] Credential preparation failed:', error.message);
    }
  }

  await Promise.allSettled(saveOperations);

  for (const [userId, sock] of activeBots.entries()) {
    try {
      await updateSessionStatus(userId, false);

      if (typeof sock.end === 'function') {
        sock.end(new Error('Server shutting down'));
      }
    } catch (error) {
      console.error('[SHUTDOWN] Socket close failed:', error.message);
    }
  }

  activeBots.clear();

  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve));
  }

  try {
    await mongoose.disconnect();
  } catch (error) {
    console.error('[SHUTDOWN] MongoDB disconnect failed:', error.message);
  }

  console.log('[SERVER] Shutdown complete.');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ======================================================
// START APPLICATION
// ======================================================

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
