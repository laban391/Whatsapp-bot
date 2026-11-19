
'use strict';

const handler = require('./handler');
const database = require('./database');

async function handleMessage(sock, msg) {
  if (!sock || !msg) {
    throw new Error('Socket and message are required');
  }

  const tenantId = sock.__tenantId;

  if (!tenantId) {
    throw new Error('This WhatsApp socket has no tenant ID');
  }

  return database.runWithTenant(tenantId, async () => {
    return handler.handleMessage(sock, msg);
  });
}

async function handleGroupUpdate(sock, update) {
  if (!sock || !update) {
    throw new Error('Socket and group update are required');
  }

  const tenantId = sock.__tenantId;

  if (!tenantId) {
    throw new Error('This WhatsApp socket has no tenant ID');
  }

  return database.runWithTenant(tenantId, async () => {
    return handler.handleGroupUpdate(sock, update);
  });
}

module.exports = {
  handleMessage,
  handleGroupUpdate
};
