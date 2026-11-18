'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// PASTE YOUR NEW MONGODB ATLAS URL HERE
const MONGO_URL = 'mongodb+srv://labanlaby34_db_user:labanlabanlaban@whatsapp.xv0gpkv.mongodb.net/?retryWrites=true&w=majority';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = path.resolve(
    process.env.DATA_DIR || path.join(__dirname, 'user_sessions')
);
const MAX_ACCOUNTS = Number(process.env.MAX_BOT_ACCOUNTS || 10);

if (!ADMIN_TOKEN) {
    console.error('ERROR: Set ADMIN_TOKEN in your hosting environment.');
    process.exit(1);
}

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const BotSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true, index: true },
    sessionDir: { type: String, required: true },
    status: { type: String, default: 'stopped' },
    pairingCode: { type: String, default: '' },
    lastError: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

const Bot = mongoose.models.GaajuBot ||
    mongoose.model('GaajuBot', BotSchema);

const children = new Map();
const states = new Map();

function cleanPhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function accountPaths(phone) {
    const sessionDir = path.join(DATA_DIR, phone);

    return {
        sessionDir,
        backupDir: path.join(DATA_DIR, phone + '_backup')
    };
}

function updateState(phone, patch) {
    const old = states.get(phone) || {
        phone,
        status: 'starting',
        pairingCode: '',
        lastError: ''
    };

    const next = {
        ...old,
        ...patch,
        updatedAt: new Date().toISOString()
    };

    states.set(phone, next);

    Bot.updateOne(
        { phone },
        { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true }
    ).catch(err => {
        console.error('Mongo update failed:', err.message);
    });

    return next;
}

function startBot(phone) {
    if (children.has(phone)) {
        return children.get(phone);
    }

    const { sessionDir, backupDir } = accountPaths(phone);

    fs.mkdirSync(sessionDir, { recursive: true });

    const child = spawn(
        process.execPath,
        ['--expose-gc', path.join(__dirname, 'index.js')],
        {
            cwd: __dirname,
            env: {
                ...process.env,
                BOT_PHONE_NUMBER: phone,
                BOT_SESSION_DIR: sessionDir,
                BOT_SESSION_BACKUP_DIR: backupDir
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    children.set(phone, child);

    updateState(phone, {
        status: 'starting',
        pairingCode: '',
        lastError: ''
    });

    const consume = chunk => {
        const output = chunk.toString();

        for (const line of output.split(/\r?\n/)) {
            if (!line) continue;

            console.log(`[${phone}] ${line}`);

            const match = line.match(/PAIRING_CODE:([A-Z0-9-]+)/i);

            if (match) {
                updateState(phone, {
                    status: 'pairing',
                    pairingCode: match[1],
                    lastError: ''
                });
            }

            if (/Connected =>|Bot Connected!/i.test(line)) {
                updateState(phone, {
                    status: 'connected',
                    pairingCode: ''
                });
            }

            if (/Invalid number|Fatal error/i.test(line)) {
                updateState(phone, {
                    status: 'error',
                    lastError: line.slice(0, 500)
                });
            }
        }
    };

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);

    child.on('error', err => {
        updateState(phone, {
            status: 'error',
            lastError: err.message
        });

        children.delete(phone);
    });

    child.on('exit', (code, signal) => {
        children.delete(phone);

        const current = states.get(phone) || {};

        if (current.status !== 'logged_out') {
            updateState(phone, {
                status: code === 0 ? 'stopped' : 'error',
                lastError: code === 0
                    ? ''
                    : `Bot process ended (code ${code}, signal ${signal || 'none'}).`
            });
        }
    });

    return child;
}

function requireAdmin(req, res, next) {
    const supplied = String(
        req.get('x-admin-token') ||
        req.body?.token ||
        req.query?.token ||
        ''
    );

    const a = Buffer.from(supplied);
    const b = Buffer.from(ADMIN_TOKEN);

    if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
    ) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized. Check your admin token.'
        });
    }

    next();
}

// PAIRING WEBSITE
app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GAAJU-XMD Pairing</title>
<style>
body {
    font-family: Arial,sans-serif;
    max-width: 520px;
    margin: 40px auto;
    padding: 18px;
    background: #f4f6f8;
    color: #17202a;
}
main {
    background: white;
    padding: 22px;
    border-radius: 14px;
    box-shadow: 0 3px 18px #0001;
}
input,button {
    box-sizing: border-box;
    width: 100%;
    padding: 13px;
    margin: 8px 0;
    border: 1px solid #ccd3da;
    border-radius: 8px;
    font-size: 16px;
}
button {
    background: #125bd2;
    color: white;
    border: 0;
    font-weight: bold;
}
pre {
    white-space: pre-wrap;
    background: #eef2f7;
    padding: 12px;
    border-radius: 8px;
    min-height: 55px;
}
</style>
</head>
<body>
<main>
<h2>🤖 GAAJU-XMD Pairing</h2>
<p>Enter your admin token and WhatsApp number with country code.</p>

<input id="token" type="password" placeholder="Admin token">
<input id="phone" inputmode="numeric" placeholder="Example: 2547XXXXXXXX">

<button onclick="pair()">Get pairing code</button>

<pre id="result">Waiting...</pre>
</main>

<script>
async function pair() {
    const result = document.getElementById('result');
    const token = document.getElementById('token').value;
    const phone = document.getElementById('phone').value;

    result.textContent = 'Starting bot...';

    try {
        const r = await fetch('/api/pair', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-token': token
            },
            body: JSON.stringify({ phone })
        });

        const d = await r.json();

        if (!r.ok) {
            throw Error(d.error || 'Request failed');
        }

        result.textContent = 'Bot started. Waiting for pairing code...';

        let tries = 0;

        const timer = setInterval(async () => {
            try {
                const s = await fetch(
                    '/api/status/' + encodeURIComponent(d.phone),
                    {
                        headers: { 'x-admin-token': token }
                    }
                );

                const v = await s.json();

                result.textContent = v.pairingCode
                    ? 'PAIRING CODE: ' + v.pairingCode
                    : 'Status: ' + v.status +
                      (v.lastError ? '\\n' + v.lastError : '');

                if (
                    v.pairingCode ||
                    v.status === 'connected' ||
                    v.status === 'error' ||
                    ++tries > 30
                ) {
                    clearInterval(timer);
                }
            } catch (e) {
                clearInterval(timer);
                result.textContent = e.message;
            }
        }, 2000);

    } catch (e) {
        result.textContent = e.message;
    }
}
</script>
</body>
</html>`);
});

// HEALTH CHECK
app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        bot: 'GAAJU-XMD',
        uptime: process.uptime()
    });
});

// START PAIRING
app.post('/api/pair', requireAdmin, async (req, res) => {
    const phone = cleanPhone(req.body.phone);

    if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({
            success: false,
            error: 'Enter a valid phone number with country code.'
        });
    }

    try {
        const count = await Bot.countDocuments();

        if (!children.has(phone) && count >= MAX_ACCOUNTS) {
            return res.status(429).json({
                success: false,
                error: `Account limit reached (${MAX_ACCOUNTS}).`
            });
        }

        const existing = children.get(phone);

        if (existing) {
            return res.json({
                success: true,
                phone,
                message: 'This number already has a running bot.'
            });
        }

        await Bot.updateOne(
            { phone },
            {
                $set: {
                    phone,
                    sessionDir: accountPaths(phone).sessionDir,
                    status: 'starting',
                    pairingCode: '',
                    lastError: '',
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        startBot(phone);

        res.json({
            success: true,
            phone,
            message: 'Bot started. Poll /api/status for the pairing code.'
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            success: false,
            error: 'Could not start bot.'
        });
    }
});

// CHECK STATUS
app.get('/api/status/:phone', requireAdmin, async (req, res) => {
    const phone = cleanPhone(req.params.phone);
    const live = states.get(phone);

    if (live) {
        return res.json(live);
    }

    const saved = await Bot.findOne({ phone }).lean().catch(() => null);

    if (!saved) {
        return res.status(404).json({
            success: false,
            error: 'Account not found.'
        });
    }

    res.json({
        phone,
        status: saved.status,
        pairingCode: saved.pairingCode,
        lastError: saved.lastError
    });
});

// STOP BOT
app.post('/api/stop/:phone', requireAdmin, async (req, res) => {
    const phone = cleanPhone(req.params.phone);
    const child = children.get(phone);

    if (!child) {
        return res.status(404).json({
            success: false,
            error: 'Bot is not running.'
        });
    }

    updateState(phone, {
        status: 'stopping',
        pairingCode: ''
    });

    child.kill('SIGTERM');

    res.json({
        success: true,
        phone,
        status: 'stopping'
    });
});

// START SERVER
async function main() {
    if (!MONGO_URI || MONGO_URI.includes('PASTE_YOUR_NEW')) {
        throw new Error('Add your new MongoDB Atlas URL to MONGO_URI in server.js.');
    }

    await mongoose.connect(MONGO_URI);

    console.log('MongoDB connected.');

    app.listen(PORT, () => {
        console.log(`GAAJU-XMD pairing server listening on port ${PORT}`);
    });
}

main().catch(err => {
    console.error('Server startup failed:', err.message);
    process.exit(1);
});
