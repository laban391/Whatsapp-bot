
'use strict';

// Connect the original GAAJU-MD handlers.
const {
  handleMessage: originalHandleMessage,
  handleGroupUpdate: originalHandleGroupUpdate
} = require('./handler');

/**
 * Process incoming WhatsApp messages for a bot session.
 *
 * @param {object} sock - The Baileys socket for this session.
 * @param {object} msg - The incoming WhatsApp message.
 */
async function handleMessage(sock, msg) {
  if (!sock || !msg) {
    throw new Error('Socket and message are required.');
  }

  return originalHandleMessage(sock, msg);
}

/**
 * Process WhatsApp group participant updates.
 *
 * @param {object} sock - The Baileys socket for this session.
 * @param {object} update - The group participant update.
 */
async function handleGroupUpdate(sock, update) {
  if (!sock || !update) {
    throw new Error('Socket and group update are required.');
  }

  return originalHandleGroupUpdate(sock, update);
}

module.exports = {
  handleMessage,
  handleGroupUpdate
};
