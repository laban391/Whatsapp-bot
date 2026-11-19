
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
// CONFIGURATION
// ======================================================

const PORT = Number(process.env.PORT) || 3000;

const MONGO_URI = process.env.MONGODB_URI;

const logger = pino({
  level: process.env.LOG_LEVEL || 'silent'
});

if (!MONGO_URI) {
  console.error('[LABAN-XMD] MONGODB_URI is missing from environment variables.');
  process.exit(1);
}

// ======================================================
// EXPRESS
// ======================================================

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const publicFolder = path.join(__dirname, 'public');

app.use(express.static(publicFolder));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicFolder, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    name: 'LABAN-XMD',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    activeBots: activeBots.size
  });
});

// ======================================================
// MONGODB MODELS
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
}, {
  versionKey: false
});

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
}, {
  versionKey: false
});

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
// ACTIVE BOT STORAGE
// ======================================================

const activeBots = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();

let httpServer = null;
let shuttingDown = false;

// ======================================================
// HELPERS
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
  return sock && sock.user && sock.user.id;
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
      },
      { upsert: false }
    );
  } catch (error) {
    console.error('[DATABASE] Session status update failed:', error.message);
  }
}

// ======================================================
// MONGODB BAILEYS AUTHENTICATION
// ======================================================

async function useMongoAuthState(userId) {
  let credentialsDocument = await AuthData.findOne({
    userId,
    key: '__creds__'
  }).lean();

  let creds;

  if (credentialsDocument && credentialsDocument.value) {
    try {
      creds = JSON.parse(
        credentialsDocument.value,
        BufferJSON.reviver
      );
    } catch (error) {
      console.error(
        `[AUTH] Could not read saved credentials for ${userId}:`,
        error.message
      );
      throw new Error('Saved WhatsApp credentials could not be read.');
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    const serialized = JSON.stringify(creds, BufferJSON.replacer);

    await AuthData.updateOne(
      {
        userId,
        key: '__creds__'
      },
      {
        $set: {
          value: serialized
        }
      },
      { upsert: true }
    );
  };

  const keys = {
    get: async (type, ids) => {
      const result = {};

      if (!ids || ids.length === 0) {
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
          console.error(
            `[AUTH] Could not read key ${document.key}:`,
            error.message
          );
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
      keys: keys
    },
    saveCreds
  };
}

// ======================================================
// RECONNECT MANAGEMENT
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
    `[RECONNECT] ${phoneNumber} will reconnect in ${Math.round(delay / 1000)} seconds.`
  );

  const timer = setTimeout(async () => {
    reconnectTimers.delete(userId);

    if (shuttingDown || activeBots.has(userId)) {
      return;
    }

    try {
      await connectBot(phoneNumber, {
        reconnect: true
      });
    } catch (error) {
      console.error(
        `[RECONNECT] Failed for ${phoneNumber}:`,
        error.message
      );

      scheduleReconnect(userId, phoneNumber);
    }
  }, delay);

  reconnectTimers.set(userId, timer);
}

// ======================================================
// CONNECT WHATSAPP BOT
// ======================================================

async function connectBot(phoneNumber, options = {}) {
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

  activeBots.set(userId, sock);

  // Save authentication changes to MongoDB.
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      console.error(
        `[AUTH] Could not save credentials for ${phoneNumber}:`,
        error.message
      );
    }
  });

  // Connection status.
  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;

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
        `[DISCONNECTED] ${phoneNumber} | Status: ${statusCode || 'unknown'}`
      );

      // Only clear saved authentication when WhatsApp
      // explicitly reports that the account was logged out.
      if (loggedOut) {
        console.log(
          `[LOGOUT] ${phoneNumber} logged out. Removing saved authentication.`
        );

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

  // Incoming WhatsApp messages.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!Array.isArray(messages)) {
      return;
    }

    for (const message of messages) {
      if (!message || !message.message) {
        continue;
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

  // Group participant updates.
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
// PAIRING ENDPOINT
// ======================================================

async function handlePairRequest(req, res) {
  const phoneNumber = normalizePhoneNumber(
    req.body?.phoneNumber || req.body?.number
  );

  if (!phoneNumber || phoneNumber.length < 8 || phoneNumber.length > 15) {
    return res.status(400).json({
      success: false,
      error: 'Enter a valid phone number with country code.'
    });
  }

  const userId = getUserId(phoneNumber);

  if (pairingLocks.has(userId)) {
    return res.status(429).json({
      success: false,
      error: 'A pairing request is already running for this number. Please wait.'
    });
  }

  pairingLocks.add(userId);

  try {
    // Do not create another connection if this number is
    // already connected in this running server.
    const existingBot = activeBots.get(userId);

    if (existingBot && isSocketActive(existingBot)) {
      return res.status(409).json({
        success: false,
        error: 'This WhatsApp number is already connected to LABAN-XMD.'
      });
    }

    // Check whether this number already has saved credentials.
    const savedCredentials = await AuthData.findOne({
      userId,
      key: '__creds__'
    }).lean();

    if (savedCredentials) {
      let savedCreds;

      try {
        savedCreds = JSON.parse(
          savedCredentials.value,
          BufferJSON.reviver
        );
      } catch (error) {
        return res.status(500).json({
          success: false,
          error: 'Saved authentication data is damaged. Contact the administrator.'
        });
      }

      if (savedCreds.registered) {
        return res.status(409).json({
          success: false,
          error: 'This number already has a saved WhatsApp session. It should reconnect automatically after deployment. Do not pair it again unless you have logged out.'
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

    // Give Baileys time to initialize the connection.
    await sleep(1500);

    if (sock.authState?.creds?.registered) {
      return res.status(409).json({
        success: false,
        error: 'This WhatsApp number is already registered. Its saved session will be restored automatically.'
      });
    }

    if (typeof sock.requestPairingCode !== 'function') {
      throw new Error('Pairing code is not available in the installed Baileys version.');
    }

    const pairingCode = await sock.requestPairingCode(phoneNumber);

    return res.json({
      success: true,
      phoneNumber,
      code: pairingCode,
      message: 'Enter this code in WhatsApp under Linked Devices.'
    });

  } catch (error) {
    console.error(
      `[PAIRING ERROR] ${phoneNumber}:`,
      error.stack || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.message || 'Could not generate pairing code. Please try again.'
    });

  } finally {
    pairingLocks.delete(userId);
  }
}

app.post('/api/pair', handlePairRequest);

// Backwards compatibility with pages that use /pair.
app.post('/pair', handlePairRequest);

// ======================================================
// RESTORE SAVED WHATSAPP SESSIONS
// ======================================================

async function restoreSessions() {
  console.log('[RESTORE] Checking MongoDB for saved WhatsApp sessions...');

  const sessions = await UserSession.find({}).lean();

  let restored = 0;

  for (const session of sessions) {
    const userId = session.userId;
    const phoneNumber = session.phoneNumber;

    if (!userId || !phoneNumber) {
      continue;
    }

    if (activeBots.has(userId)) {
      continue;
    }

    const savedCredentials = await AuthData.findOne({
      userId,
      key: '__creds__'
    }).lean();

    if (!savedCredentials) {
      console.log(
        `[RESTORE] No saved authentication for ${phoneNumber}. Skipping.`
      );

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
        `[RESTORE] Invalid saved credentials for ${phoneNumber}:`,
        error.message
      );

      continue;
    }

    if (!creds.registered) {
      console.log(
        `[RESTORE] ${phoneNumber} has not completed pairing. Skipping.`
      );
      continue;
    }

    try {
      await connectBot(phoneNumber, {
        reconnect: true
      });

      restored++;

      console.log(
        `[RESTORE] Reconnection started for ${phoneNumber}.`
      );

      // Avoid starting too many connections simultaneously.
      await sleep(1200);

    } catch (error) {
      console.error(
        `[RESTORE] Could not restore ${phoneNumber}:`,
        error.message
      );

      scheduleReconnect(userId, phoneNumber);
    }
  }

  console.log(
    `[RESTORE] Finished. Started ${restored} saved session connection(s).`
  );
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
// GRACEFUL SHUTDOWN
// ======================================================

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`[SERVER] Received ${signal}. Saving and closing connections...`);

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }

  reconnectTimers.clear();

  // Save all current credentials before closing sockets.
  const saveOperations = [];

  for (const [userId, sock] of activeBots.entries()) {
    try {
      if (sock.authState?.creds) {
        saveOperations.push(
          AuthData.updateOne(
            {
              userId,
              key: '__creds__'
            },
            {
              $set: {
                value: JSON.stringify(
                  sock.authState.creds,
                  BufferJSON.replacer
                )
              }
            },
            { upsert: true }
          )
        );
      }
    } catch (error) {
      console.error(
        `[SHUTDOWN] Could not prepare credentials for ${userId}:`,
        error.message
      );
    }
  }

  await Promise.allSettled(saveOperations);

  // Close sockets without deleting their MongoDB authentication.
  for (const [userId, sock] of activeBots.entries()) {
    try {
      await updateSessionStatus(userId, false);

      if (typeof sock.end === 'function') {
        sock.end(new Error('Server shutting down'));
      }
    } catch (error) {
      console.error(
        `[SHUTDOWN] Socket close error for ${userId}:`,
        error.message
      );
    }
  }

  activeBots.clear();

  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close(() => resolve());
    });
  }

  try {
    await mongoose.disconnect();
  } catch (error) {
    console.error('[SHUTDOWN] MongoDB disconnect error:', error.message);
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
    console.error('[FATAL] LABAN-XMD failed to start:', error.stack || error.message);
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
