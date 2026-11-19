
'use strict';

const handler = require('./handler');
const database = require('./database');

async function handleMessage(sock, message) {
  if (!sock || !message) return;

  const tenantId = sock.__tenantId;

  if (!tenantId) {
    throw new Error('WhatsApp socket has no tenant ID');
  }

  if (typeof handler.handleMessage !== 'function') {
    throw new Error(
      'handler.js must export handleMessage(sock, message)'
    );
  }

  return database.runWithTenant(
    tenantId,
    () => handler.handleMessage(sock, message)
  );
}

async function handleGroupUpdate(sock, update) {
  if (!sock || !update) return;

  const tenantId = sock.__tenantId;

  if (!tenantId) {
    throw new Error('WhatsApp socket has no tenant ID');
  }

  if (typeof handler.handleGroupUpdate !== 'function') {
    throw new Error(
      'handler.js must export handleGroupUpdate(sock, update)'
    );
  }

  return database.runWithTenant(
    tenantId,
    () => handler.handleGroupUpdate(sock, update)
  );
}

module.exports = {
  handleMessage,
  handleGroupUpdate
};
