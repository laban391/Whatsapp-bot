'use strict';

const engineModule = require('./zenitsu-main');
const engine = engineModule.default || engineModule;

const statusBoundSockets = new WeakSet();

const engineHandleMessages = engine.handleMessages;
const engineGroupUpdate = engine.handleGroupParticipantUpdate;

if (typeof engineHandleMessages !== 'function') {
    throw new Error(
        '[LABAN-XMD] handleMessages missing from zenitsu-main.js'
    );
}

// ==================================================
// MESSAGE HANDLER
// ==================================================

async function handleMessage(sock, message, context = {}) {
    if (!message || !message.message) return;

    if (sock?.ev && !statusBoundSockets.has(sock)) {
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

    // ==================================================
    // STATUS MESSAGE HANDLING
    // ==================================================

    if (message.key?.remoteJid === 'status@broadcast') {
        if (typeof engine.handleStatus === 'function') {
            return engine.handleStatus(sock, update);
        }

        return;
    }

    // ==================================================
    // FORWARD MESSAGE + MONGODB CONTEXT
    // ==================================================

    return engineHandleMessages(
        sock,
        update,
        true,
        context
    );
}

// ==================================================
// GROUP PARTICIPANT UPDATE
// ==================================================

async function handleGroupUpdate(sock, update) {
    if (typeof engineGroupUpdate !== 'function') {
        console.warn(
            '[LABAN-XMD] Group handler unavailable.'
        );

        return;
    }

    return engineGroupUpdate(sock, update);
}

// ==================================================
// EXPORTS
// ==================================================

module.exports = {
    handleMessage,
    handleGroupUpdate,
    handleStatus: engine.handleStatus
};

console.log(
    '[LABAN-XMD] Main bridge loaded successfully.'
);
