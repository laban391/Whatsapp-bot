// Best-effort anti-delete for WhatsApp statuses. Availability depends on WhatsApp
// emitting a status deletion event to the linked device.
'use strict';
const fs = require('fs');
const path = require('path');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');
const cacheBySocket = new WeakMap();

function sid(sock) { return String(sock?.__phoneNumber || sock?.__tenantId || sock?.user?.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function cfgPath(sock) { return path.join(__dirname, '../data', `antideletestatus_${sid(sock)}.json`); }
function load(sock) { try { return JSON.parse(fs.readFileSync(cfgPath(sock), 'utf8')); } catch { return { enabled: false }; } }
function save(sock, cfg) { fs.mkdirSync(path.dirname(cfgPath(sock)), { recursive: true }); fs.writeFileSync(cfgPath(sock), JSON.stringify(cfg, null, 2)); }
function ownerJid(sock) {
  const raw = sock?.__phoneNumber || sock?.user?.id || settings.ownerNumber || '';
  const n = String(raw).split(':')[0].split('@')[0].replace(/\D/g, '');
  return n ? `${n}@s.whatsapp.net` : null;
}
async function command(sock, chatId, message, args) {
  const sender = message?.key?.participant || message?.key?.remoteJid;
  let allowed = !!message?.key?.fromMe;
  if (!allowed) { try { allowed = await isOwnerOrSudo(sender, sock, chatId); } catch {} }
  if (!allowed) return sock.sendMessage(chatId, { text: '❌ Owner only.' }, { quoted: message });
  const cfg = load(sock);
  const action = String(args?.[0] || '').toLowerCase();
  if (!['on', 'off'].includes(action)) {
    return sock.sendMessage(chatId, { text: `👑 *Anti-Delete Status*\nCurrent: *${cfg.enabled ? 'ON' : 'OFF'}*\n\n.antideletestatus on\n.antideletestatus off` }, { quoted: message });
  }
  cfg.enabled = action === 'on'; save(sock, cfg);
  return sock.sendMessage(chatId, { text: `✅ Anti-Delete Status is now *${action.toUpperCase()}*.` }, { quoted: message });
}
function cacheFor(sock) { let c = cacheBySocket.get(sock); if (!c) { c = new Map(); cacheBySocket.set(sock, c); } return c; }
async function capture(sock, msg) {
  if (!load(sock).enabled || !msg?.key?.id || msg.key.remoteJid !== 'status@broadcast' || msg.key.fromMe || !msg.message) return;
  const cache = cacheFor(sock);
  if (cache.has(msg.key.id)) return;
  const raw = msg.message.ephemeralMessage?.message || msg.message;
  const mediaType = raw.imageMessage ? 'image' : raw.videoMessage ? 'video' : raw.audioMessage ? 'audio' : raw.documentMessage ? 'document' : null;
  const item = { key: msg.key, sender: msg.key.participant || msg.key.participantAlt || 'unknown', text: raw.conversation || raw.extendedTextMessage?.text || '', mediaType, buffer: null, caption: '' };
  const mediaNode = mediaType ? raw[`${mediaType}Message`] : null;
  if (mediaNode) {
    item.caption = mediaNode.caption || mediaNode.fileName || '';
    try {
      const buf = await downloadMediaMessage({ key: msg.key, message: raw }, 'buffer', {}, { logger: undefined, reuploadRequest: sock.updateMediaMessage });
      if (buf && buf.length <= 20 * 1024 * 1024) item.buffer = Buffer.from(buf);
    } catch (err) { console.warn('[antideletestatus] capture media failed:', err.message); }
  }
  cache.set(msg.key.id, item);
  while (cache.size > 40) cache.delete(cache.keys().next().value);
}
async function handleDelete(sock, update) {
  if (!load(sock).enabled) return;
  const keys = Array.isArray(update?.keys) ? update.keys : update?.key ? [update.key] : [];
  const cache = cacheFor(sock);
  const dest = ownerJid(sock);
  if (!dest) return;
  for (const key of keys) {
    if (!key?.id || (key.remoteJid && key.remoteJid !== 'status@broadcast')) continue;
    const item = cache.get(key.id);
    if (!item) continue;
    cache.delete(key.id);
    const from = String(item.sender).split('@')[0];
    await sock.sendMessage(dest, { text: `🛡️ *DELETED STATUS CAPTURED*\nFrom: @${from}\n${item.text || item.caption || '(media status)'}`, mentions: [item.sender] });
    if (item.buffer && item.mediaType) {
      const payload = item.mediaType === 'image' ? { image: item.buffer } : item.mediaType === 'video' ? { video: item.buffer } : item.mediaType === 'audio' ? { audio: item.buffer, mimetype: 'audio/mpeg', ptt: false } : { document: item.buffer, mimetype: 'application/octet-stream', fileName: item.caption || 'status-file' };
      await sock.sendMessage(dest, { ...payload, caption: item.caption ? `Deleted status from @${from}\n${item.caption}` : `Deleted status from @${from}`, mentions: [item.sender] });
    }
  }
}
module.exports = { command, capture, handleDelete };
