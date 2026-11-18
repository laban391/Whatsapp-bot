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

// --- 1. DATABASE CONNECTION ---
const MONGO_URI = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.log('❌ MongoDB Error:', err.message));

const SessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    phoneNumber: String,
    isConnected: { type: Boolean, default: false }
});
const UserSession = mongoose.model('UserSession', SessionSchema);

const activeBots = new Map();

// --- 2. FRONTEND WEBSITE ---
const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Pairing</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background-color: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; max-width: 400px; width: 100%; }
        h1 { color: #25D366; }
        input { width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #333; background: #2a2a2a; color: #fff; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #25D366; color: #000; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        .code-box { margin-top: 20px; padding: 15px; background: #2a2a2a; border: 1px dashed #25D366; border-radius: 6px; display: none; }
        .code-box h2 { color: #25D366; font-size: 28px; letter-spacing: 2px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Link Your WhatsApp</h1>
        <input type="text" id="number" placeholder="e.g. 254712345678">
        <button onclick="pair()">Get Pairing Code</button>
        <div class="code-box" id="result">
            <p>Your Pairing Code:</p>
            <h2 id="code"></h2>
        </div>
    </div>
    <script>
        async function pair() {
            const num = document.getElementById('number').value.trim();
            if(!num) return alert('Enter a number!');
            document.getElementById('result').style.display = 'none';
            document.getElementById('code').innerText = "Loading... (Please wait 50s if server was asleep)";
            document.getElementById('result').style.display = 'block';
            try {
                const res = await fetch('/pair?number=' + num);
                const data = await res.json();
                if(data.error) alert(data.error);
                else document.getElementById('code').innerText = data.code;
            } catch(e) { alert('Failed to connect'); }
        }
    </script>
</body>
</html>
`;
app.get('/', (req, res) => res.send(htmlPage));

// --- 3. THE PAIRING ENDPOINT ---
app.get('/pair', async (req, res) => {
    let phoneNumber = req.query.number;
    if (!phoneNumber) return res.status(400).json({ error: 'Please provide a number.' });
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

    const userId = 'user_' + phoneNumber;

    let dbUser = await UserSession.findOne({ userId });
    if (dbUser && dbUser.isConnected && activeBots.has(userId)) {
        return res.json({ error: '❌ This number is already connected!' });
    }

    const sessionPath = `./sessions/${userId}`;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestWaWebVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: Browsers.macOS("Safari"), 
        syncFullHistory: false
    });

    activeBots.set(userId, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr && !sock.authState.creds.registered) {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                if (!res.headersSent) res.json({ code: code });
            } catch (e) {
                if (!res.headersSent) res.status(500).json({ error: 'Error: ' + e.message });
            }
        }

        if (connection === 'open') {
            console.log(`✅ User ${phoneNumber} connected!`);
            await UserSession.findOneAndUpdate(
                { userId },
                { phoneNumber, isConnected: true },
                { upsert: true }
            );
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`🔄 Reconnecting user ${phoneNumber}...`);
                activeBots.delete(userId);
            } else {
                console.log(`❌ User ${phoneNumber} logged out.`);
                await UserSession.findOneAndUpdate({ userId }, { isConnected: false });
                activeBots.delete(userId);
            }
        }
    });

    // --- 4. MESSAGE HANDLER (Safe Commands Only) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
            if (!m.message) continue;
            try {
                const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
                if (!text) continue;
                
                const prefix = '.';
                const isCmd = text.startsWith(prefix);
                const command = isCmd ? text.slice(prefix.length).trim().split(" ")[0].toLowerCase() : '';
                const from = m.key.remoteJid;

                const reply = async (teks) => {
                    await sock.sendMessage(from, { text: teks }, { quoted: m });
                };

                if (command === "menu") {
                    let menuText = `\n. ▢ Botname : *Koirii Official*\n. ▢ Connected as : ${phoneNumber}\n\n ╭▢ *Command Menu*\n │.menu\n │.ping\n │.owner\n ╰▢\n\n`;
                    await reply(menuText);
                }

                if (command === "ping") {
                    await reply("🏓 Pong! Your bot is active.");
                }

                if (command === "owner") {
                    await reply("👤 Owner: +254708700675");
                }

            } catch (e) {
                console.log('❌ Handler Error:', e.message);
            }
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
