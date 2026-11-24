const fs = require('fs');
const path = require('path');

// Keep each connected WhatsApp account's setting separate on multi-user hosting.
function getSettingsPath(sock) {
    const raw = String(sock && (sock.__phoneNumber || (sock.user && sock.user.id)) || 'unknown');
    const account = raw.split('@')[0].split(':')[0].replace(/\D/g, '') || 'unknown';
    return path.join(__dirname, '..', 'data', 'anticall', `${account}.json`);
}

function readState(sock) {
    try {
        const file = getSettingsPath(sock);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const mode = String(data.mode || 'off').toLowerCase();
        return { mode: ['off', 'decline', 'block'].includes(mode) ? mode : 'off', enabled: mode !== 'off' };
    } catch (_) {
        return { mode: 'off', enabled: false };
    }
}

function writeState(sock, mode) {
    const file = getSettingsPath(sock);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mode }, null, 2));
}

async function anticallCommand(sock, chatId, message, args) {
    const current = readState(sock);
    const mode = String(args || '').trim().toLowerCase();
    if (!mode || !['off', 'decline', 'block', 'status'].includes(mode)) {
        await sock.sendMessage(chatId, { text: '*ANTI-CALL*\n\n.anticall off - Disable anti-call\n.anticall decline - Reject incoming calls\n.anticall block - Reject calls and block callers\n.anticall status - Show current mode' }, { quoted: message });
        return;
    }
    if (mode === 'status') {
        await sock.sendMessage(chatId, { text: `Anti-call mode: *${current.mode.toUpperCase()}*` }, { quoted: message });
        return;
    }
    writeState(sock, mode);
    await sock.sendMessage(chatId, { text: `Anti-call mode set to *${mode.toUpperCase()}* for this WhatsApp account.` }, { quoted: message });
}

module.exports = { anticallCommand, readState };
