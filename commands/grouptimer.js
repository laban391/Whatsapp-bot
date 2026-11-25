'use strict';

const isAdmin = require('../lib/isAdmin');
const TIME_ZONE = 'Africa/Nairobi';
const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) return null;
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

// Nairobi is UTC+3 year-round. Store absolute UTC dates in MongoDB.
function nextOccurrence(time, from = new Date()) {
  const nairobiNow = new Date(from.getTime() + 3 * 60 * 60 * 1000);
  const year = nairobiNow.getUTCFullYear();
  const month = nairobiNow.getUTCMonth();
  const day = nairobiNow.getUTCDate();
  let result = new Date(Date.UTC(year, month, day, time.hour - 3, time.minute, 0, 0));
  if (result <= from) result = new Date(result.getTime() + DAY_MS);
  return result;
}

async function grouptimerCommand(sock, chatId, senderId, args, message) {
  if (!chatId.endsWith('@g.us')) {
    return sock.sendMessage(chatId, { text: 'This command can only be used inside a group.' }, { quoted: message });
  }
  if (!sock.groupTimersCollection || !sock.__tenantId) {
    return sock.sendMessage(chatId, { text: 'Group timer storage is not ready. Please try again shortly.' }, { quoted: message });
  }

  let permissions;
  try { permissions = await isAdmin(sock, chatId, senderId); }
  catch (_) { permissions = { isSenderAdmin: false, isBotAdmin: false }; }
  if (!permissions.isSenderAdmin) {
    return sock.sendMessage(chatId, { text: 'Only a group admin can configure the group timer.' }, { quoted: message });
  }
  if (!permissions.isBotAdmin) {
    return sock.sendMessage(chatId, { text: 'Please make the bot an admin first. It needs admin rights to open and close the group automatically.' }, { quoted: message });
  }

  const collection = sock.groupTimersCollection;
  const filter = { userId: sock.__tenantId, groupId: chatId };

  if (!args.length) {
    const existing = await collection.findOne(filter);
    if (!existing) {
      return sock.sendMessage(chatId, {
        text: 'No group timer is set.\n\nSet daily hours:\n.grouptimer 08:00 20:00\nCancel:\n.grouptimer off\n\nTimes use Kenya time (Africa/Nairobi).'
      }, { quoted: message });
    }
    return sock.sendMessage(chatId, {
      text: `⏰ *Group timer is active*\nOpens: *${existing.openTime}*\nCloses: *${existing.closeTime}*\nTimezone: *Kenya time (EAT)*\n\nCancel with .grouptimer off`
    }, { quoted: message });
  }

  if (args[0].toLowerCase() === 'off' || args[0].toLowerCase() === 'cancel') {
    await collection.deleteOne(filter);
    return sock.sendMessage(chatId, { text: '⏰ Group timer cancelled for this group.' }, { quoted: message });
  }

  if (args.length !== 2) {
    return sock.sendMessage(chatId, { text: 'Usage: .grouptimer 08:00 20:00\nThe first time is when the group opens; the second is when it closes. Use .grouptimer off to cancel.' }, { quoted: message });
  }

  const open = parseTime(args[0]);
  const close = parseTime(args[1]);
  if (!open || !close || args[0] === args[1]) {
    return sock.sendMessage(chatId, { text: 'Please use two different valid 24-hour times, for example: .grouptimer 08:00 20:00' }, { quoted: message });
  }

  const now = new Date();
  await collection.updateOne(filter, {
    $set: {
      ...filter,
      openTime: args[0],
      closeTime: args[1],
      timezone: TIME_ZONE,
      active: true,
      nextOpenAt: nextOccurrence(open, now),
      nextCloseAt: nextOccurrence(close, now),
      updatedAt: now
    },
    $setOnInsert: { createdAt: now }
  }, { upsert: true });

  return sock.sendMessage(chatId, {
    text: `✅ *Daily group timer saved*\n\n🔓 Opens: *${args[0]}*\n🔒 Closes: *${args[1]}*\n🕒 Timezone: *Kenya time (EAT)*\n\nThe bot will open the group by allowing all members to send messages, then close it by allowing admins only. The schedule is saved and survives bot restarts.\n\nCancel anytime with .grouptimer off.`
  }, { quoted: message });
}

module.exports = { grouptimerCommand, parseTime, nextOccurrence };
