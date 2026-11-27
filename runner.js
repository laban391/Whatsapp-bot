
const { spawn } = require('child_process');
const path = require('path');

let restarting = false;
let child = null;

function startBot() {
    if (restarting) return;

    console.log('[SUPERVISOR] Starting WhatsApp bot...');

    child = spawn(
        process.execPath,
        [path.join(__dirname, 'server.js')],
        {
            cwd: __dirname,
            stdio: 'inherit'
        }
    );

    child.on('error', (err) => {
        console.error('[SUPERVISOR] Startup error:', err);
    });

    child.on('exit', (code, signal) => {
        if (restarting) return;

        console.log(
            `[SUPERVISOR] Bot exited (code: ${code}, signal: ${signal}).`
        );

        console.log('[SUPERVISOR] Restarting in 3 seconds...');
        setTimeout(startBot, 3000);
    });
}

function stopBot(signal) {
    if (restarting) return;
    restarting = true;

    console.log(`[SUPERVISOR] Received ${signal}. Stopping bot...`);

    if (child && !child.killed) {
        child.kill(signal);
    } else {
        process.exit(0);
    }

    setTimeout(() => process.exit(0), 15000);
}

process.on('SIGINT', () => stopBot('SIGINT'));
process.on('SIGTERM', () => stopBot('SIGTERM'));

startBot();
