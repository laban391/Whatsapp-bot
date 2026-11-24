// Queen Riam-style status controls, adapted for the MOON multi-user engine.
'use strict';
const fs = require('fs');
const path = require('path');
const isOwnerOrSudo = require('../lib/isOwner');

const readLocks = new WeakMap();
const lastReadAt = new WeakMap();
const READ_GAP_MS = 4000;

function sessionKey(sock) {
  return String(sock?.__phoneNumber || sock?.__tenantId || sock?.user?.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function configPath(sock) { return path.join(__dirname, '../data', `queenStatus_${sessionKey(sock)}.json`); }
function loadConfig(sock) {
  const file = configPath(sock);
  try {
    if (!fs.existsSync(file)) return { AUTO_STATUS_VIEW: 'false', AUTO_STATUS_REACT: 'false' };
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { AUTO_STATUS_VIEW: 'false', AUTO_STATUS_REACT: 'false', ...cfg };
  } catch { return { AUTO_STATUS_VIEW: 'false', AUTO_STATUS_REACT: 'false' }; }
}
function saveConfig(sock, cfg) {
  const file = configPath(sock);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
async function ownerOnly(sock, chatId, message) {
  if (message?.key?.fromMe) return true;
  const sender = message?.key?.participant || message?.key?.remoteJid;
  try { return await isOwnerOrSudo(sender, sock, chatId); } catch { return false; }
}
async function statusCommand(sock, chatId, message, args, which) {
  if (!(await ownerOnly(sock, chatId, message))) {
    await sock.sendMessage(chatId, { text: '❌ This command is only for the owner and sudo users.' }, { quoted: message });
    return;
  }
  const cfg = loadConfig(sock);
  const action = String(args?.[0] || '').toLowerCase();
  const key = which === 'view' ? 'AUTO_STATUS_VIEW' : 'AUTO_STATUS_REACT';
  const label = which === 'view' ? 'Auto View Status' : 'Auto React Status';
  if (!['on', 'off'].includes(action)) {
    const current = cfg[key] === 'true';
    await sock.sendMessage(chatId, { text: `👑 *Queen Riam — ${label}*\n\nStatus: *${current ? 'ON' : 'OFF'}*\n\nUsage: .${which === 'view' ? 'autoviewstatus' : 'autoreactstatus'} on|off` }, { quoted: message });
    return;
  }
  cfg[key] = action === 'on' ? 'true' : 'false';
  saveConfig(sock, cfg);
  await sock.sendMessage(chatId, { text: `✅ ${label} is now *${action.toUpperCase()}*.` }, { quoted: message });
}
async function autoViewCommand(sock, chatId, message, args) { return statusCommand(sock, chatId, message, args, 'view'); }
async function autoReactCommand(sock, chatId, message, args) { return statusCommand(sock, chatId, message, args, 'react'); }
async function safeRead(sock, key) {
  const now = Date.now();
  const last = lastReadAt.get(sock) || 0;
  if (readLocks.get(sock)) return false;
  const wait = READ_GAP_MS - (now - last);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  readLocks.set(sock, true);
  try {
    const participant = key.participant || key.participantAlt;
    const botJid = sock.user?.id ? (typeof sock.decodeJid === 'function' ? sock.decodeJid(sock.user.id) : sock.user.id) : null;
    const statusJidList = [participant, botJid].filter(Boolean);
    await sock.readMessages([key], statusJidList.length ? { statusJidList } : {});
    lastReadAt.set(sock, Date.now());
    return true;
  } catch (err) {
    if (err?.message?.includes('rate-overlimit')) console.warn('[QueenRiam status] WhatsApp rate limit; will retry on a later status.');
    else console.error('[QueenRiam status] read failed:', err?.message || err);
    return false;
  } finally { readLocks.delete(sock); }
}
async function reactToStatus(sock, key) {
  try {
    if (!key?.id || key.fromMe) return;
    const participant = key.participant || key.participantAlt;
    if (!participant) return;
    await sock.relayMessage('status@broadcast', {
      reactionMessage: {
        key: { remoteJid: 'status@broadcast', id: key.id, participant, fromMe: false },
        text: '💚'
      }
    }, { messageId: key.id, statusJidList: [participant] });
  } catch (err) { console.error('[QueenRiam status] reaction failed:', err?.message || err); }
}
async function handleStatusUpdate(sock, update) {
  try {
    const cfg = loadConfig(sock);
    const messages = Array.isArray(update?.messages) ? update.messages : [];
    const candidates = messages.map(m => m?.key ? m : null).filter(Boolean);
    if (update?.key) candidates.push(update);
    if (update?.reaction?.key) candidates.push({ key: update.reaction.key });
    const seen = new Set();
    for (const item of candidates) {
      const key = item.key;
      if (!key || key.remoteJid !== 'status@broadcast' || !key.id || key.fromMe || seen.has(key.id)) continue;
      seen.add(key.id);
      if (cfg.AUTO_STATUS_VIEW === 'true') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await safeRead(sock, key);
      }
      if (cfg.AUTO_STATUS_REACT === 'true') await reactToStatus(sock, key);
    }
  } catch (err) { console.error('[QueenRiam status] update error:', err?.stack || err?.message || err); }
}
module.exports = { autoStatusCommand: autoViewCommand, autoViewCommand, autoReactCommand, handleStatusUpdate, loadConfig };
