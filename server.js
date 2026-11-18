const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestWaWebVersion, 
    makeCacheableSignalKeyStore, 
    Browsers, 
    delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// --- 1. CONNECT TO DATABASE ---
// Make sure your password doesn't contain special characters that need URL encoding
const MONGO_URI = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.log('❌ MongoDB Connection Error:', err.message));

// --- 2. DATABASE MODEL ---
const SessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    phoneNumber: String,
    isConnected: { type: Boolean, default: false }
});
const UserSession = mongoose.model('UserSession', SessionSchema);

const activeBots = new Map();

// --- 3. FRONTEND HTML ---
const htmlPage = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Pairing</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .container { background: #1e1e1e; padding: 40px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); text-align: center; max-width: 400px; width: 100%; }
        h1 { margin-top: 0; color: #25D366; }
        p { color: #aaa; margin-bottom: 20px; }
        input { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #333; background: #2a2a2a; color: #fff; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
        button { width: 100%; padding: 12px; background-color: #25D366; color: #000; border: none; border-radius: 6px; font-weight: bold; font-size: 16px; cursor: pointer; transition: 0.3s; }
        button:hover { background-color: #1ebe5d; }
        .code-box { margin-top: 20px; padding: 15px; background: #2a2a2a; border: 1px dashed #25D366; border-radius: 6px; display: none; }
        .code-box h2 { color: #25D366; font-size: 28px; letter-spacing: 2px; margin: 10px 0; }
        .loader { display: none; border: 4px solid #333; border-top: 4px solid #25D366; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h1>Link Your WhatsApp</h1>
        <p>Enter your number with country code (no + sign).</p>
        <input type="text" id="number" placeholder="e.g. 254712345678">
        <button onclick="pair()">Get Pairing Code</button>
        <div class="loader" id="loader"></div>
        <div class="code-box" id="result">
            <p style="margin:0; color:#aaa;">Your Pairing Code:</p>
            <h2 id="code"></h2>
            <p style="font-size:12px; margin-top:10px;">Go to WhatsApp > Linked Devices > Link with phone number</p>
        </div>
    </div>

    <script>
        async function pair() {
            const number = document.getElementById('number').value.trim();
            if (!number) return alert('Please enter a number!');
            
            document.getElementById('loader').style.display = 'block';
            document.getElementById('result').style.display = 'none';
            document.querySelector('button').style.display = 'none';

            try {
                const res = await fetch('/pair?number=' + number);
                const data = await res.json();

                document.getElementById('loader').style.display = 'none';
                document.querySelector('button').style.display = 'block';

                if (data.error) {
                    alert(data.error);
                } else {
                    document.getElementById('code').innerText = data.code;
                    document.getElementById('result').style.display = 'block';
                }
            } catch (err) {
                document.getElementById('loader').style.display = 'none';
                document.querySelector('button').style.display = 'block';
                alert('Connection failed. Check server logs.');
            }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(htmlPage);
});

// --- 4. THE PAIRING ENDPOINT ---
app.get('/pair', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) return res.status(400).json({ error: 'Please provide a number.' });

    const userId = 'user_' + phoneNumber;

    let dbUser = await UserSession.findOne({ userId });
    if (dbUser && dbUser.isConnected && activeBots.has(userId)) {
        return res.json({ error: '❌ This number is already connected and running!' });
    }

    const sessionPath = `./sessions/${userId}`;
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // --- FIX 1: Use the direct WA Web version fetcher ---
    const { version } = await fetchLatestWaWebVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        // --- FIX 2: Spoof MacOS Safari (Bypasses WA server blocks) ---
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    activeBots.set(userId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr && !sock.authState.creds.registered) {
            try {
                // --- FIX 3: Wait 3 seconds for socket to stabilize ---
                await delay(3000); 
                const code = await sock.requestPairingCode(phoneNumber);
                res.json({ code: code });
            } catch (e) {
                res.status(500).json({ error: 'Error generating code: ' + e.message });
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

    // --- 5. MESSAGE HANDLER ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const text = m.message.conversation || m.message.extendedMessage?.text || '';
        const from = m.key.remoteJid;

        if (text === '.menu') {
            let menu = `🤖 *Bot Menu*\n\n`;
            menu += `▢ .menu\n▢ .ping\n\n`;
            menu += `Connected as: ${phoneNumber}`;
            await sock.sendMessage(from, { text: menu }, { quoted: m });
        }
        
        if (text === '.ping') {
            await sock.sendMessage(from, { text: '🏓 Pong! Your bot is active.' }, { quoted: m });
        }
    });
});

// Start the website
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
});
