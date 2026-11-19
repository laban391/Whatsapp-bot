
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const pino = require('pino');

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  BufferJSON,
  initAuthCreds,
  proto
} = require('@whiskeysockets/baileys');

const {
  handleMessage,
  handleGroupUpdate
} = require('./main');

// ======================================================
// 1. CONFIGURATION
// ======================================================

const PORT = process.env.PORT || 3000;

// Replace YOUR_USERNAME and YOUR_NEW_PASSWORD.
// URL-encode special characters in the password.
const MONGO_URI =
  'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';

const logger = pino({ level: 'silent' });

mongoose.set('strictQuery', true);

// ======================================================
// 2. DATABASE MODELS
// ======================================================

const SessionSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const UserSession =
  mongoose.models.UserSession ||
  mongoose.model('UserSession', SessionSchema);

const AuthDataSchema = new mongoose.Schema({
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
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
});

AuthDataSchema.index(
  { userId: 1, key: 1 },
  { unique: true }
);

const AuthData =
  mongoose.models.AuthData ||
  mongoose.model('AuthData', AuthDataSchema);

// ======================================================
// 3. MONGODB AUTHENTICATION STORAGE
// ======================================================

async function useMongoAuthState(userId) {
  let credsDocument = await AuthData.findOne({
    userId,
    key: '__creds__'
  }).lean();

  let creds = credsDocument
    ? credsDocument.value
    : initAuthCreds();

  async function saveKey(key, value) {
    const id = {
      userId,
      key
    };

    if (value === null || value === undefined) {
      await AuthData.deleteOne(id);
      return;
    }

    await AuthData.updateOne(
      id,
      {
        $set: { value }
      },
      { upsert: true }
    );
  }

  const keyStore = {
    get: async (type, ids) => {
      const result = {};

      await Promise.all(
        ids.map(async id => {
          const key = `${type}-${id}`;

          const document = await AuthData.findOne({
            userId,
            key
          }).lean();

          if (document) {
            let value = document.value;

            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value
              );
            }

            result[id] = value;
          }
        })
      );

      return result;
    },

    set: async data => {
      const operations = [];

      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const value = data[category][id];
          const key = `${category}-${id}`;

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
                update: { $set: { value } },
                upsert: true
              }
            });
          }
        }
      }

      if (operations.length) {
        await AuthData.bulkWrite(operations);
      }
    }
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(
        keyStore,
        logger
      )
    },

    saveCreds: async () => {
      await saveKey('__creds__', creds);
    }
  };
}

// ======================================================
// 4. ACTIVE BOT MANAGEMENT
// ======================================================

const activeBots = new Map();
const activeNumbers = new Map();
const pairingRequests = new Set();
const reconnectTimers = new Map();

const MAX_PAIRING_REQUESTS_PER_IP = 5;
const pairingAttempts = new Map();

function normalizePhoneNumber(number) {
  return String(number || '').replace(/\D/g, '');
}

function isValidPhoneNumber(number) {
  return /^[1-9]\d{7,14}$/.test(number);
}

function getUserId(phoneNumber) {
  return `user_${phoneNumber}`;
}

function getPairingCode(sock, phoneNumber) {
  return new Promise(async (resolve, reject) => {
    let completed = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        reject(new Error('Pairing code request timed out'));
      }
    }, 45000);

    try {
      const code = await sock.requestPairingCode(phoneNumber);

      if (!completed) {
        completed = true;
        clearTimeout(timeout);
        resolve(code);
      }
    } catch (error) {
      clearTimeout(timeout);

      if (!completed) {
        completed = true;
        reject(error);
      }
    }
  });
}

// ======================================================
// 5. CONNECT A CUSTOMER BOT
// ======================================================

async function connectBot(phoneNumber, userId, onCode) {
  if (activeBots.has(userId)) {
    throw new Error('This bot is already running');
  }

  const auth = await useMongoAuthState(userId);

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Safari'),
    auth: auth.state,
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // IMPORTANT: Used by main.js to isolate each customer's data.
  sock.__tenantId = userId;

  const bot = {
    sock,
    phoneNumber,
    userId,
    connected: false,
    intentionalDisconnect: false,
    pairingCodeSent: false
  };

  activeBots.set(userId, bot);
  activeNumbers.set(phoneNumber, userId);

  sock.ev.on('creds.update', async () => {
    try {
      await auth.saveCreds();
    } catch (error) {
      console.error('[AUTH] Save error:', error.message);
    }
  });

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      bot.connected = true;
      bot.pairingCodeSent = false;

      await UserSession.updateOne(
        { userId },
        {
          $set: {
            phoneNumber,
            isConnected: true,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      console.log(`[BOT] Connected: ${phoneNumber}`);
    }

    if (connection === 'close') {
      bot.connected = false;

      await UserSession.updateOne(
        { userId },
        {
          $set: {
            isConnected: false,
            updatedAt: new Date()
          }
        }
      );

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        statusCode === DisconnectReason.loggedOut;

      console.log(
        `[BOT] Disconnected: ${phoneNumber}`,
        statusCode || ''
      );

      if (loggedOut || bot.intentionalDisconnect) {
        await deleteUserSession(userId);
        return;
      }

      // Reconnect with a delay, without creating duplicate sockets.
      if (activeBots.get(userId) === bot) {
        const timer = setTimeout(async () => {
          reconnectTimers.delete(userId);

          if (activeBots.get(userId) !== bot) return;

          activeBots.delete(userId);

          try {
            await connectBot(phoneNumber, userId, null);
          } catch (error) {
            console.error(
              `[BOT] Reconnect failed for ${phoneNumber}:`,
              error.message
            );
          }
        }, 5000);

        reconnectTimers.set(userId, timer);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages || []) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error('[MESSAGE] Handler error:', error);
      }
    }
  });

  sock.ev.on('group-participants.update', async update => {
    try {
      await handleGroupUpdate(sock, update);
    } catch (error) {
      console.error('[GROUP] Handler error:', error);
    }
  });

  // Request a pairing code only for a new, unregistered session.
  if (
    onCode &&
    !auth.state.creds.registered
  ) {
    try {
      const code = await getPairingCode(sock, phoneNumber);

      bot.pairingCodeSent = true;
      onCode(code);
    } catch (error) {
      console.error('[PAIRING] Code error:', error.message);
      throw error;
    }
  }

  return bot;
}

// ======================================================
// 6. DELETE CUSTOMER SESSION
// ======================================================

async function deleteUserSession(userId) {
  const bot = activeBots.get(userId);

  if (bot) {
    bot.intentionalDisconnect = true;

    try {
      bot.sock.ev.removeAllListeners();
      bot.sock.end(undefined);
    } catch (_) {}

    activeBots.delete(userId);
    activeNumbers.delete(bot.phoneNumber);
  }

  const timer = reconnectTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(userId);
  }

  await UserSession.deleteOne({ userId });
  await AuthData.deleteMany({ userId });

  console.log(`[SESSION] Removed ${userId}`);
}

// ======================================================
// 7. EXPRESS APPLICATION
// ======================================================

const app = express();

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LABAN-XMD Pairing</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  background:#080d16;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px
}
.card{
  width:100%;
  max-width:420px;
  padding:30px;
  background:#111c2c;
  border:1px solid #26374e;
  border-radius:18px;
  text-align:center
}
h1{color:#38e6b0}
p{color:#b6c6d8;line-height:1.5}
input{
  width:100%;
  padding:15px;
  margin:15px 0;
  border:1px solid #354a60;
  border-radius:9px;
  background:#081321;
  color:white;
  font-size:16px
}
button{
  width:100%;
  padding:15px;
  border:0;
  border-radius:9px;
  background:#13c99a;
  color:#06130f;
  font-size:16px;
  font-weight:bold;
  cursor:pointer
}
button:disabled{opacity:.5}
#result{
  margin-top:20px;
  overflow-wrap:anywhere;
  font-size:21px;
  color:#38e6b0
}
.small{font-size:12px;color:#8294a9}
</style>
</head>
<body>
<div class="card">
<h1>LABAN-XMD</h1>
<p>Connect your WhatsApp account using a pairing code.</p>
<form id="pairForm">
<input
 id="number"
 type="tel"
 placeholder="Country code + phone number"
 required
 autocomplete="tel"
>
<button id="submitButton" type="submit">Get Pairing Code</button>
</form>
<div id="result"></div>
<p class="small">
Enter your own WhatsApp number, including the country code.
Never share your pairing code with anyone.
</p>
</div>

<script>
const form = document.getElementById('pairForm');
const result = document.getElementById('result');
const button = document.getElementById('submitButton');

form.addEventListener('submit', async event => {
  event.preventDefault();

  button.disabled = true;
  result.textContent = 'Generating pairing code...';

  try {
    const response = await fetch('/pair', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        number: document.getElementById('number').value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Pairing failed');
    }

    result.textContent = 'Your pairing code: ' + data.code;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>
  `);
});

// ======================================================
// 8. HEALTH CHECK
// ======================================================

app.get('/ping', (req, res) => {
  res.json({
    status: 'online',
    service: 'LABAN-XMD',
    activeBots: activeBots.size,
    uptime: process.uptime()
  });
});

// ======================================================
// 9. PAIRING ENDPOINT
// ======================================================

app.post('/pair', async (req, res) => {
  const phoneNumber = normalizePhoneNumber(req.body.number);

  if (!isValidPhoneNumber(phoneNumber)) {
    return res.status(400).json({
      error: 'Enter a valid phone number with country code.'
    });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const previous = pairingAttempts.get(ip);

  if (previous && now - previous.time < 60000) {
    if (previous.count >= MAX_PAIRING_REQUESTS_PER_IP) {
      return res.status(429).json({
        error: 'Too many requests. Try again in one minute.'
      });
    }

    previous.count++;
  } else {
    pairingAttempts.set(ip, {
      count: 1,
      time: now
    });
  }

  const userId = getUserId(phoneNumber);

  if (pairingRequests.has(userId)) {
    return res.status(409).json({
      error: 'A pairing request is already in progress.'
    });
  }

  if (activeBots.has(userId)) {
    return res.status(409).json({
      error: 'This WhatsApp number already has an active bot.'
    });
  }

  try {
    const existingSession = await UserSession.findOne({
      userId
    }).lean();

    if (existingSession) {
      return res.status(409).json({
        error: 'This number already has a registered session.'
      });
    }

    pairingRequests.add(userId);

    let responseSent = false;

    const bot = await connectBot(
      phoneNumber,
      userId,
      code => {
        if (!responseSent && !res.headersSent) {
          responseSent = true;

          res.json({
            success: true,
            code,
            instructions:
              'Open WhatsApp > Linked Devices > Link with phone number.'
          });
        }
      }
    );

    await UserSession.updateOne(
      { userId },
      {
        $setOnInsert: {
          userId,
          phoneNumber,
          isConnected: false,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    // Keep the socket running while the user links the device.
    setTimeout(async () => {
      if (
        !bot.connected &&
        !bot.sock.user
      ) {
        console.log(`[PAIRING] Still waiting for ${phoneNumber}`);
      }
    }, 60000);

  } catch (error) {
    console.error('[PAIRING] Error:', error.message);

    await deleteUserSession(userId).catch(() => {});

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Could not generate a pairing code. Please try again.'
      });
    }
  } finally {
    pairingRequests.delete(userId);
  }
});

// ======================================================
// 10. RESTORE SAVED SESSIONS
// ======================================================

async function restoreSessions() {
  console.log('[RESTORE] Checking saved WhatsApp sessions...');

  const sessions = await UserSession.find({}).lean();

  for (const session of sessions) {
    try {
      const credentials = await AuthData.findOne({
        userId: session.userId,
        key: '__creds__'
      }).lean();

      if (!credentials || !credentials.value?.registered) {
        console.log(
          `[RESTORE] Skipping unregistered session: ${session.phoneNumber}`
        );

        continue;
      }

      if (activeBots.has(session.userId)) {
        continue;
      }

      console.log(`[RESTORE] Starting ${session.phoneNumber}`);

      await connectBot(
        session.phoneNumber,
        session.userId,
        null
      );

    } catch (error) {
      console.error(
        `[RESTORE] Failed for ${session.phoneNumber}:`,
        error.message
      );
    }
  }

  console.log('[RESTORE] Session restoration completed.');
}

// ======================================================
// 11. START SERVER
// ======================================================

async function startServer() {
  try {
    await mongoose.connect(MONGO_URI);

    console.log('[MONGO] Connected successfully.');

    await restoreSessions();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[SERVER] LABAN-XMD running on port ${PORT}`);
    });

  } catch (error) {
    console.error('[STARTUP] Failed:', error.message);
    process.exit(1);
  }
}

// ======================================================
// 12. GRACEFUL SHUTDOWN
// ======================================================

async function shutdown() {
  console.log('[SERVER] Shutting down...');

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }

  for (const bot of activeBots.values()) {
    bot.intentionalDisconnect = true;

    try {
      bot.sock.ev.removeAllListeners();
      bot.sock.end(undefined);
    } catch (_) {}
  }

  activeBots.clear();
  activeNumbers.clear();
  reconnectTimers.clear();

  try {
    await mongoose.disconnect();
  } catch (_) {}

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', error => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', error => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  shutdown();
});

startServer();
