'use strict';

// Compatibility bridge for the existing LABAN-XMD multi-user server.js.
// The imported command engine expects Baileys' full messages.upsert object,
// while server.js passes one message at a time.
const engine = require('./zenitsu-main');
const statusBoundSockets = new WeakSet();

async function handleMessage(sock, message) {
  if (!message || !message.message) return;

  // Attach status listeners once per WhatsApp socket.
  if (sock && sock.ev && !statusBoundSockets.has(sock)) {
    statusBoundSockets.add(sock);
    sock.ev.on('status.update', async status => {
      try { await engine.handleStatus(sock, status); }
      catch (error) { console.error('[STATUS] update error:', error.message); }
    });
    sock.ev.on('messages.reaction', async status => {
      try { await engine.handleStatus(sock, status); }
      catch (error) { console.error('[STATUS] reaction error:', error.message); }
    });
  }

  const update = { messages: [message], type: 'notify' };
  if (message.key && message.key.remoteJid === 'status@broadcast') {
    return engine.handleStatus(sock, update);
  }
  return engine.handleMessages(sock, update, true);
}

async function handleGroupUpdate(sock, update) {
  return engine.handleGroupParticipantUpdate(sock, update);
}

module.exports = {
  handleMessage,
  handleGroupUpdate,
  handleStatus: engine.handleStatus
};
