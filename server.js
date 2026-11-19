
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');

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
// CONFIGURATION
// ==================================================

const app = express();
const PORT = process.env.PORT || 3000;

// Enter your MongoDB Atlas URI privately.
// Replace the placeholders with your actual credentials.
const MONGO_URI =
  'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/';

const logger = pino({ level: 'silent' });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

  lastConnected: {
    type: Date
  }
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
// ACTIVE CONNECTIONS
// ==================================================

const activeBots = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const pairingLocks = new Set();

const MAX_RECONNECT_DELAY = 30000;

// ==================================================
// MONGODB AUTHENTICATION STORAGE
// Each customer has separate WhatsApp credentials.
// ==================================================

async function useMongoAuthState(userId) {
  const CREDS_KEY = '__creds__';

  async function readValue(key) {
    const doc = await AuthData.findOne({
      userId,
      key
    }).lean();

    if (!doc || !doc.value) {
      return null;
    }

    return JSON.parse(
      doc.value,
      BufferJSON.reviver
    );
  }

  async function writeValue(key, value) {
    if (value === null || value === undefined) {
      await AuthData.deleteOne({
        userId,
        key
      });

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

      await Promise.all(
        ids.map(async (id) => {
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

      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
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
// CONNECTION STATUS
// ==================================================

async function updateConnectionStatus(userId, connected) {
  await UserSession.updateOne(
    { userId },
    {
      $set: {
        isConnected: connected,
        ...(connected
          ? { lastConnected: new Date() }
          : {})
      }
    }
  );
}

function clearReconnectTimer(userId) {
  const timer = reconnectTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(userId);
  }
}

// ==================================================
// RECONNECT SYSTEM
// ==================================================

function scheduleReconnect(userId, phoneNumber) {
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
    `Reconnect scheduled for ${phoneNumber} in ${delay}ms`
  );

  const timer = setTimeout(async () => {
    reconnectTimers.delete(userId);

    try {
      const session = await UserSession.findOne({
        userId
      });

      if (!session) return;

      const credentials = await AuthData.exists({
        userId,
        key: '__creds__'
      });

      if (!credentials) return;

      await connectBot(userId, phoneNumber);
    } catch (error) {
      console.error(
        'Reconnect error:',
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
  const existing = activeBots.get(userId);

  if (existing) {
    return existing;
  }

  const auth = await useMongoAuthState(userId);

  const { version } =
    await fetchLatestBaileysVersion();

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

    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // Used by main.js for tenant isolation.
  sock.__tenantId = userId;

  const entry = {
    user: sock,
    phoneNumber
  };

  activeBots.set(userId, entry);

  // Save authentication changes.
  sock.ev.on('creds.update', async () => {
    try {
      await auth.saveCreds();
    } catch (error) {
      console.error(
        'Credential save error:',
        error.message
      );
    }
  });

  // Handle connection updates.
  sock.ev.on('connection.update', async (update) => {
    const {
      connection,
      lastDisconnect
    } = update;

    if (connection === 'open') {
      clearReconnectTimer(userId);
      reconnectAttempts.delete(userId);

      try {
        await updateConnectionStatus(userId, true);
      } catch (error) {
        console.error(
          'Status update error:',
          error.message
        );
      }

      console.log(
        `WhatsApp connected: ${phoneNumber}`
      );
    }

    if (connection === 'close') {
      try {
        await updateConnectionStatus(userId, false);
      } catch (error) {
        console.error(error.message);
      }

      // Remove only this socket, not a newer replacement.
      if (activeBots.get(userId)?.user === sock) {
        activeBots.delete(userId);
      }

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      const loggedOut =
        statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log(
          `WhatsApp logged out: ${phoneNumber}`
        );

        reconnectAttempts.delete(userId);
        clearReconnectTimer(userId);
      } else {
        console.log(
          `WhatsApp disconnected: ${phoneNumber}`
        );

        scheduleReconnect(userId, phoneNumber);
      }
    }
  });

  // Handle incoming messages.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await handleMessage(sock, message);
      } catch (error) {
        console.error(
          'Message handler error:',
          error
        );
      }
    }
  });

  // Handle group participant changes.
  sock.ev.on(
    'group-participants.update',
    async (update) => {
      try {
        await handleGroupUpdate(sock, update);
      } catch (error) {
        console.error(
          'Group handler error:',
          error
        );
      }
    }
  );

  return entry;
}

// ==================================================
// PHONE NUMBER NORMALIZATION
// ==================================================

function normalizeNumber(number) {
  return String(number || '').replace(/\D/g, '');
}

// ==================================================
// PAIRING WEBSITE
// ==================================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LABAN-XMD Pairing</title>

<style>
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #101827;
  color: white;
  font-family: Arial, sans-serif;
}

.container {
  width: min(90%, 390px);
  padding: 28px;
  background: #1c293b;
  border-radius: 18px;
  text-align: center;
  box-sizing: border-box;
}

h1 {
  color: #38d9a9;
}

input, button {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  margin-top: 14px;
  border: 0;
  border-radius: 9px;
  font-size: 16px;
}

button {
  background: #38d9a9;
  color: #10251f;
  font-weight: bold;
  cursor: pointer;
}

#result {
  margin-top: 20px;
  overflow-wrap: anywhere;
}

.code {
  font-size: 25px;
  letter-spacing: 4px;
  color: #38d9a9;
  font-weight: bold;
}
</style>
</head>

<body>
<div class="container">

<h1>LABAN-XMD</h1>

<p>Connect your WhatsApp account</p>

<input
  id="number"
  placeholder="Country code + phone number"
/>

<button onclick="getCode()">
  Get Pairing Code
</button>

<div id="result"></div>

</div>

<script>
async function getCode() {
  const number =
    document.getElementById('number').value;

  const result =
    document.getElementById('result');

  if (!number.trim()) {
    result.textContent =
      'Enter your WhatsApp number.';
    return;
  }

  result.textContent =
    'Generating pairing code...';

  try {
    const response = await fetch('/pair', {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({ number })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || 'Pairing failed'
      );
    }

    result.innerHTML =
      '<p>Your pairing code:</p>' +
      '<div class="code">' +
      data.code +
      '</div>' +
      '<p>Open WhatsApp → Linked Devices → ' +
      'Link a Device → Link with phone number instead.</p>';

  } catch (error) {
    result.textContent = error.message;
  }
}
</script>

</body>
</html>
  `);
});

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
// PAIRING API
// ==================================================

app.post('/pair', async (req, res) => {
  const phoneNumber =
    normalizeNumber(req.body.number);

  if (
    phoneNumber.length < 8 ||
    phoneNumber.length > 15
  ) {
    return res.status(400).json({
      error: 'Enter a valid phone number with country code.'
    });
  }

  const userId = `user_${phoneNumber}`;

  if (pairingLocks.has(userId)) {
    return res.status(409).json({
      error: 'A pairing request is already running.'
    });
  }

  if (activeBots.has(userId)) {
    return res.status(409).json({
      error: 'This WhatsApp number already has an active connection.'
    });
  }

  pairingLocks.add(userId);

  let entry;

  try {
    const existingSession =
      await UserSession.findOne({ userId });

    const credentials =
      await AuthData.exists({
        userId,
        key: '__creds__'
      });

    if (existingSession && credentials) {
      return res.status(409).json({
        error: 'This number already has a saved session. Its existing session will be restored automatically.'
      });
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

    entry = await connectBot(
      userId,
      phoneNumber
    );

    const code =
      await entry.user.requestPairingCode(
        phoneNumber
      );

    return res.json({
      success: true,
      number: phoneNumber,
      code
    });

  } catch (error) {
    console.error(
      'Pairing error:',
      error
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
      error: 'Could not generate pairing code. Please try again.'
    });

  } finally {
    pairingLocks.delete(userId);
  }
});

// ==================================================
// RESTORE SAVED SESSIONS
// IMPORTANT: FIND ALL SESSIONS, NOT JUST CONNECTED.
// ==================================================

async function restoreSessions() {
  const sessions = await UserSession.find({});

  console.log(
    `Found ${sessions.length} saved session records.`
  );

  for (const session of sessions) {
    try {
      const credentials =
        await AuthData.exists({
          userId: session.userId,
          key: '__creds__'
        });

      if (!credentials) {
        console.log(
          `No saved credentials for ${session.phoneNumber}; skipping.`
        );
        continue;
      }

      if (activeBots.has(session.userId)) {
        continue;
      }

      console.log(
        `Restoring WhatsApp session: ${session.phoneNumber}`
      );

      await connectBot(
        session.userId,
        session.phoneNumber
      );

    } catch (error) {
      console.error(
        `Could not restore ${session.phoneNumber}:`,
        error.message
      );
    }
  }
}

// ==================================================
// START SERVER
// ==================================================

async function startServer() {
  await mongoose.connect(MONGO_URI);

  await Promise.all([
    UserSession.init(),
    AuthData.init()
  ]);

  console.log('MongoDB connected successfully.');

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(
      `LABAN-XMD running on port ${PORT}`
    );

    try {
      await restoreSessions();
    } catch (error) {
      console.error(
        'Session restoration failed:',
        error
      );
    }
  });
}

// ==================================================
// GRACEFUL SHUTDOWN
// ==================================================

async function shutdown() {
  console.log('Shutting down LABAN-XMD...');

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }

  reconnectTimers.clear();

  for (const entry of activeBots.values()) {
    try {
      entry.user.end(undefined);
    } catch {}
  }

  activeBots.clear();

  try {
    await mongoose.disconnect();
  } catch (error) {
    console.error(error.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==================================================
// RUN
// ==================================================

startServer().catch((error) => {
  console.error(
    'Server startup failed:',
    error
  );

  process.exit(1);
});
