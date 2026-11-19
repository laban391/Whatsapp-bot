
'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');

const tenantContext = new AsyncLocalStorage();

const databaseRoot = path.join(__dirname, 'database');
const tenantsRoot = path.join(databaseRoot, 'tenants');

fs.mkdirSync(databaseRoot, { recursive: true });
fs.mkdirSync(tenantsRoot, { recursive: true });

const DEFAULT_FILES = {
  groups: {},
  users: {},
  warnings: {},
  mods: { moderators: [] },
  muted: {},
  botmode: { mode: 'public' },
  'bot-settings': {},
  session: {}
};

const BOT_SETTINGS_DEFAULTS = {
  prefix: '.',
  botName: 'GAAJU-MD',
  timezone: 'Africa/Lagos',
  menuStyle: '1',
  fontStyle: 'normal',
  presenceMode: 'off',
  autoReadMode: 'off',
  autoReact: false,
  autoReactMode: 'bot',
  alwaysOnline: false,
  autoStatusView: false,
  autoStatusReact: false,
  autoStatusEmoji: '💙',
  autoStatusEmojiPool: [],
  autoStatusRandomEmoji: false,
  readReceipts: 'off',
  menuImageCustom: false,
  selfMode: false,
  autoSticker: false,
  autoDownload: false,
  autoBio: false
};

const VALID_BOT_MODES = ['public', 'private', 'group', 'pm'];

const cache = new Map();

function getTenantId() {
  return tenantContext.getStore() || null;
}

function safeTenantId(value) {
  const id = String(value || '').trim();

  if (!id || id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('Invalid or missing tenant ID');
  }

  return id;
}

/**
 * Run a bot operation inside its own database context.
 * All database functions called during this operation
 * automatically use that bot's files.
 */
function runWithTenant(tenantId, callback) {
  const id = safeTenantId(tenantId);

  if (typeof callback !== 'function') {
    throw new Error('A callback function is required');
  }

  return tenantContext.run(id, callback);
}

function getDatabaseDirectory() {
  const tenantId = getTenantId();

  if (!tenantId) {
    return databaseRoot;
  }

  const directory = path.join(tenantsRoot, tenantId);
  fs.mkdirSync(directory, { recursive: true });

  return directory;
}

function getFile(name) {
  return path.join(getDatabaseDirectory(), `${name}.json`);
}

function initialValue(name) {
  return JSON.parse(JSON.stringify(DEFAULT_FILES[name] || {}));
}

function readDatabase(name) {
  const file = getFile(name);

  if (cache.has(file)) {
    return cache.get(file);
  }

  let data;

  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');

      if (content.trim()) {
        data = JSON.parse(content);
      }
    }
  } catch (error) {
    console.error(`[DB] Read failed for ${name}:`, error.message);

    try {
      const backup = `${file}.bak`;

      if (fs.existsSync(backup)) {
        data = JSON.parse(fs.readFileSync(backup, 'utf8'));
        console.log(`[DB] Recovered ${name} from backup`);
      }
    } catch (backupError) {
      console.error(`[DB] Backup recovery failed:`, backupError.message);
    }
  }

  if (data === undefined || data === null) {
    data = initialValue(name);
  }

  cache.set(file, data);

  return data;
}

function writeDatabase(name, data) {
  const file = getFile(name);
  const temp = `${file}.tmp`;
  const backup = `${file}.bak`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const content = JSON.stringify(data, null, 2);

    fs.writeFileSync(temp, content, 'utf8');

    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, backup);
      } catch (error) {
        console.error('[DB] Backup creation failed:', error.message);
      }
    }

    fs.renameSync(temp, file);
    cache.set(file, data);

    return true;
  } catch (error) {
    console.error(`[DB] Write failed for ${name}:`, error.message);

    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch (_) {}

    return false;
  }
}

function getGroupSettings(groupId) {
  const groups = readDatabase('groups');

  if (!groups[groupId]) {
    groups[groupId] = {
      ...config.defaultGroupSettings
    };

    writeDatabase('groups', groups);
  }

  return groups[groupId];
}

function updateGroupSettings(groupId, settings) {
  const groups = readDatabase('groups');

  groups[groupId] = {
    ...(groups[groupId] || {}),
    ...settings
  };

  return writeDatabase('groups', groups);
}

function getUser(userId) {
  const users = readDatabase('users');

  if (!users[userId]) {
    users[userId] = {
      registered: Date.now(),
      premium: false,
      banned: false
    };

    writeDatabase('users', users);
  }

  return users[userId];
}

function updateUser(userId, updates) {
  const users = readDatabase('users');

  users[userId] = {
    ...(users[userId] || {}),
    ...updates
  };

  return writeDatabase('users', users);
}

function warningKey(groupId, userId) {
  return `${groupId}_${userId}`;
}

function getWarnings(groupId, userId) {
  const warnings = readDatabase('warnings');

  return warnings[warningKey(groupId, userId)] || {
    count: 0,
    warnings: []
  };
}

function addWarning(groupId, userId, reason) {
  const warnings = readDatabase('warnings');
  const key = warningKey(groupId, userId);

  if (!warnings[key]) {
    warnings[key] = {
      count: 0,
      warnings: []
    };
  }

  warnings[key].count++;

  warnings[key].warnings.push({
    reason,
    date: Date.now()
  });

  writeDatabase('warnings', warnings);

  return warnings[key];
}

function removeWarning(groupId, userId) {
  const warnings = readDatabase('warnings');
  const key = warningKey(groupId, userId);

  if (warnings[key] && warnings[key].count > 0) {
    warnings[key].count--;
    warnings[key].warnings.pop();

    writeDatabase('warnings', warnings);
    return true;
  }

  return false;
}

function clearWarnings(groupId, userId) {
  const warnings = readDatabase('warnings');

  delete warnings[warningKey(groupId, userId)];

  return writeDatabase('warnings', warnings);
}

function getModerators() {
  const mods = readDatabase('mods');
  return mods.moderators || [];
}

function addModerator(userId) {
  const mods = readDatabase('mods');

  if (!Array.isArray(mods.moderators)) {
    mods.moderators = [];
  }

  if (mods.moderators.includes(userId)) {
    return false;
  }

  mods.moderators.push(userId);

  return writeDatabase('mods', mods);
}

function removeModerator(userId) {
  const mods = readDatabase('mods');

  if (!Array.isArray(mods.moderators)) {
    return false;
  }

  mods.moderators = mods.moderators.filter(id => id !== userId);

  return writeDatabase('mods', mods);
}

function isModerator(userId) {
  const moderators = getModerators();

  if (moderators.includes(userId)) {
    return true;
  }

  // Preserve the original reverse LID mapping check.
  const tenantId = getTenantId();

  const sessionDirectory = tenantId
    ? path.join(tenantsRoot, tenantId, 'session')
    : path.join(__dirname, config.sessionName || 'session');

  const mappingFile = path.join(
    sessionDirectory,
    `lid-mapping-${userId}_reverse.json`
  );

  try {
    if (fs.existsSync(mappingFile)) {
      const mapped = JSON.parse(
        fs.readFileSync(mappingFile, 'utf8').trim()
      );

      if (mapped && moderators.includes(String(mapped))) {
        return true;
      }
    }
  } catch (error) {
    console.error('[DB] LID mapping read failed:', error.message);
  }

  return false;
}

function getBadWords(groupId) {
  const settings = getGroupSettings(groupId);

  return Array.isArray(settings.badwords)
    ? settings.badwords
    : [];
}

function addBadWord(groupId, word) {
  const groups = readDatabase('groups');

  if (!groups[groupId]) {
    groups[groupId] = {
      ...config.defaultGroupSettings
    };
  }

  if (!Array.isArray(groups[groupId].badwords)) {
    groups[groupId].badwords = [];
  }

  const normalized = String(word).toLowerCase().trim();

  if (!normalized || groups[groupId].badwords.includes(normalized)) {
    return false;
  }

  groups[groupId].badwords.push(normalized);

  return writeDatabase('groups', groups);
}

function removeBadWord(groupId, word) {
  const groups = readDatabase('groups');

  if (!groups[groupId] || !Array.isArray(groups[groupId].badwords)) {
    return false;
  }

  const normalized = String(word).toLowerCase().trim();
  const previousLength = groups[groupId].badwords.length;

  groups[groupId].badwords =
    groups[groupId].badwords.filter(item => item !== normalized);

  if (groups[groupId].badwords.length === previousLength) {
    return false;
  }

  return writeDatabase('groups', groups);
}

function normalizeWhatsAppId(userId) {
  return `${String(userId).split('@')[0]}@s.whatsapp.net`;
}

function muteUser(groupId, userId) {
  const muted = readDatabase('muted');

  if (!Array.isArray(muted[groupId])) {
    muted[groupId] = [];
  }

  const normalized = normalizeWhatsAppId(userId);

  if (!muted[groupId].includes(normalized)) {
    muted[groupId].push(normalized);
    writeDatabase('muted', muted);
  }

  return true;
}

function unmuteUser(groupId, userId) {
  const muted = readDatabase('muted');

  if (!Array.isArray(muted[groupId])) {
    return false;
  }

  const normalized = normalizeWhatsAppId(userId);
  const previousLength = muted[groupId].length;

  muted[groupId] = muted[groupId].filter(id => id !== normalized);

  if (muted[groupId].length === previousLength) {
    return false;
  }

  return writeDatabase('muted', muted);
}

function isUserMuted(groupId, userId) {
  const muted = readDatabase('muted');

  if (!Array.isArray(muted[groupId])) {
    return false;
  }

  return muted[groupId].includes(normalizeWhatsAppId(userId));
}

function getMutedUsers(groupId) {
  const muted = readDatabase('muted');

  return muted[groupId] || [];
}

function getBotMode() {
  const data = readDatabase('botmode');
  return data.mode || 'public';
}

function setBotMode(mode) {
  if (!VALID_BOT_MODES.includes(mode)) {
    throw new Error(`Invalid mode: ${mode}`);
  }

  return writeDatabase('botmode', { mode });
}

function getBotSetting(key) {
  const settings = readDatabase('bot-settings');

  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    return settings[key];
  }

  return BOT_SETTINGS_DEFAULTS[key];
}

function setBotSetting(key, value) {
  const settings = readDatabase('bot-settings');

  settings[key] = value;

  return writeDatabase('bot-settings', settings);
}

function getAllBotSettings() {
  return {
    ...BOT_SETTINGS_DEFAULTS,
    ...readDatabase('bot-settings')
  };
}

function updateBotSettings(updates) {
  const settings = readDatabase('bot-settings');

  Object.assign(settings, updates);

  return writeDatabase('bot-settings', settings);
}

function getAntiforwardSettings(groupId) {
  const settings = getGroupSettings(groupId);

  return {
    antiforward: settings.antiforward === true,
    antiforwardAction: settings.antiforwardAction || 'delete',
    antiforwardWarnings: settings.antiforwardWarnings || {},
    antiforwardMaxWarnings: settings.antiforwardMaxWarnings || 3
  };
}

function updateAntiforwardSettings(
  groupId,
  enabled,
  action = 'delete',
  maxWarnings = 3
) {
  const groups = readDatabase('groups');

  if (!groups[groupId]) {
    groups[groupId] = {
      ...config.defaultGroupSettings
    };
  }

  groups[groupId].antiforward = enabled;
  groups[groupId].antiforwardAction = action;
  groups[groupId].antiforwardMaxWarnings = maxWarnings;

  return writeDatabase('groups', groups);
}

function addAntiforwardWarning(groupId, userId) {
  const groups = readDatabase('groups');

  if (!groups[groupId]) {
    groups[groupId] = {
      ...config.defaultGroupSettings
    };
  }

  if (!groups[groupId].antiforwardWarnings) {
    groups[groupId].antiforwardWarnings = {};
  }

  const warnings = groups[groupId].antiforwardWarnings;

  warnings[userId] = (warnings[userId] || 0) + 1;

  writeDatabase('groups', groups);

  return warnings[userId];
}

function getAntiforwardWarningCount(groupId, userId) {
  const groups = readDatabase('groups');

  return groups[groupId]?.antiforwardWarnings?.[userId] || 0;
}

function clearAntiforwardWarning(groupId, userId) {
  const groups = readDatabase('groups');

  if (!groups[groupId]?.antiforwardWarnings) {
    return false;
  }

  delete groups[groupId].antiforwardWarnings[userId];

  return writeDatabase('groups', groups);
}

function clearAllAntiforwardWarnings(groupId, userId) {
  const groups = readDatabase('groups');

  if (!groups[groupId]?.antiforwardWarnings) {
    return false;
  }

  groups[groupId].antiforwardWarnings[userId] = 0;

  return writeDatabase('groups', groups);
}

function saveSession(sessionFile) {
  try {
    if (!fs.existsSync(sessionFile)) {
      return false;
    }

    const content = fs.readFileSync(sessionFile);
    const session = readDatabase('session');

    session.creds = content.toString('base64');
    session.savedAt = Date.now();

    return writeDatabase('session', session);
  } catch (error) {
    console.error('[SESSION-DB] saveSession error:', error.message);
    return false;
  }
}

function getSession() {
  try {
    const session = readDatabase('session');
    return session.creds || null;
  } catch (error) {
    console.error('[SESSION-DB] getSession error:', error.message);
    return null;
  }
}

function clearSession() {
  return writeDatabase('session', {});
}

function loadSettings() {
  return {
    enabled: getBotSetting('autoStatusView') || false,
    react: getBotSetting('autoStatusReact') || false,
    emoji: getBotSetting('autoStatusEmoji') || '💚',
    emojiPool: getBotSetting('autoStatusEmojiPool') || [],
    randomEmoji: getBotSetting('autoStatusRandomEmoji') || false
  };
}

function saveSettings(settings) {
  return updateBotSettings({
    autoStatusView: !!settings.enabled,
    autoStatusReact: !!settings.react,
    autoStatusEmoji: settings.emoji || '',
    autoStatusEmojiPool: settings.emojiPool || [],
    autoStatusRandomEmoji: !!settings.randomEmoji
  });
}

function cleanEmoji(value) {
  return String(value).replace(
    /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u200D\u200B\uFEFF]/gu,
    ''
  ).trim();
}

function pickEmoji(settings) {
  if (
    settings.randomEmoji &&
    Array.isArray(settings.emojiPool) &&
    settings.emojiPool.length
  ) {
    return settings.emojiPool[
      Math.floor(Math.random() * settings.emojiPool.length)
    ];
  }

  return settings.emoji;
}

module.exports = {
  runWithTenant,

  getGroupSettings,
  updateGroupSettings,
  getUser,
  updateUser,

  getWarnings,
  addWarning,
  removeWarning,
  clearWarnings,

  getModerators,
  addModerator,
  removeModerator,
  isModerator,

  getBadWords,
  addBadWord,
  removeBadWord,

  muteUser,
  unmuteUser,
  isUserMuted,
  getMutedUsers,

  getBotMode,
  setBotMode,
  VALID_BOT_MODES,

  getBotSetting,
  setBotSetting,
  getAllBotSettings,
  updateBotSettings,
  BOT_SETTINGS_DEFAULTS,

  getAntiforwardSettings,
  updateAntiforwardSettings,
  addAntiforwardWarning,
  getAntiforwardWarningCount,
  clearAntiforwardWarning,
  clearAllAntiforwardWarnings,

  saveSession,
  getSession,
  clearSession,

  loadSettings,
  saveSettings,
  cleanEmoji,
  pickEmoji
};
