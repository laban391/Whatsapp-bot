'use strict';

// ==========================================
// LABAN-XMD MAIN COMPATIBILITY BRIDGE
// ==========================================

const engineModule = require('./zenitsu-main');

const engine = engineModule.default || engineModule;

const statusBoundSockets = new WeakSet();

// Check that the command engine loaded correctly
const handleMessages =
    engine.handleMessages ||
    engine.handleMessage;

const handleGroupUpdate =
    engine.handleGroupParticipantUpdate ||
    engine.handleGroupUpdate;

if (typeof handleMessages !== 'function') {
    throw new Error(
        '[LABAN-XMD] handleMessages is missing from zenitsu-main.js. Check the deployed file.'
    );
}

if (typeof handleGroupUpdate !== 'function') {
    console.warn(
        '[LABAN-XMD] Group participant handler is unavailable.'
    );
}

// ==========================================
// MESSAGE HANDLER
// ==========================================

async function handleMessage(sock, message) {
    if (!message || !message.message) return;

    // Register status listeners once per socket
    if (sock && sock.ev && !statusBoundSockets.has(sock)) {
        statusBoundSockets.add(sock);

        sock.ev.on('status.update', async status => {
            try {
                if (typeof engine.handleStatus === 'function') {
                    await engine.handleStatus(sock, status);
                }
            } catch (error) {
                console.error(
                    '[STATUS ERROR]',
                    error.message
                );
            }
        });

        sock.ev.on('messages.reaction', async status => {
            try {
                if (typeof engine.handleStatus === 'function') {
                    await engine.handleStatus(sock, status);
                }
            } catch (error) {
                console.error(
                    '[REACTION ERROR]',
                    error.message
                );
            }
        });
    }

    const update = {
        messages: [message],
        type: 'notify'
    };

    // Handle WhatsApp status messages
    if (
        message.key &&
        message.key.remoteJid === 'status@broadcast'
    ) {
        if (typeof engine.handleStatus === 'function') {
            return await engine.handleStatus(sock, update);
        }

        return;
    }

    // Send message to the main command engine
    return await handleMessages(sock, update, true);
}

// ==========================================
// GROUP PARTICIPANT HANDLER
// ==========================================

async function handleGroupUpdate(sock, update) {
    if (typeof handleGroupUpdate !== 'function') {
        console.warn(
            '[LABAN-XMD] Group update handler unavailable.'
        );
        return;
    }

    return await handleGroupUpdate(sock, update);
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    handleMessage,
    handleGroupUpdate,
    handleStatus: engine.handleStatus
};

console.log('[LABAN-XMD] Main bridge loaded successfully.');
