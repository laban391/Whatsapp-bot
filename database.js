
'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const tenantContext = new AsyncLocalStorage();

const ROOT = path.join(__dirname, 'database', 'tenants');

const FILES = {
  groups: 'groups.json',
  users: 'users.json',
  warnings: 'warnings.json',
  mods: 'mods.json',
  muted: 'muted.json',
  botmode: 'botmode.json',
  settings: 'bot-settings.json',
  antiforward: 'antiforward.json',
  antiforwardWarnings: 'antiforward-warnings.json',
  session: 'session.json',
  settingsFile: 'settings.json'
};

const VALID_BOT_MODES = ['public', 'private', 'group', 'self'];

const BOT_SETTINGS_DEFAULTS = {
  prefix: '.',
  botName: 'LABAN-XMD',
  ownerName: 'Owner',
  autoRead: false,
  autoTyping: false,
  autoRecording: false,
  alwaysOnline: false,
  autoReact: false
};

const DEFAULT_GROUP_SETTINGS = {
  antilink: false,
  antispam: false,
  welcome: false,
  goodbye: false,
  chatbot: false,
  nsfw: false,
  antibadword: false,
  antiforward: false
};

function getTenantId() {
  const id = tenantContext.getStore();

  if (!id) {
    throw new Error(
      'No tenant context. Call database.runWithTenant() first.'
    );
  }

  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function runWithTenant(tenantId, callback) {
  if (!tenantId) {
    throw new Error('Tenant ID is required');
  }

  return tenantContext.run(String(tenantId), callback);
}

function tenantDirectory() {
  const directory = path.join(ROOT, getTenantId());

  fs.mkdirSync(directory, { recursive: true });

  return directory;
}

function filePath(name) {
  return path.join(tenantDirectory(), FILES[name]);
}

function readJSON(name, fallback = {}) {
  const file = filePath(name);

  try {
    if (!fs.existsSync(file)) {
      writeJSON(name, fallback);
      return structuredClone(fallback);
    }

    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Database read error (${name}):`, error.message);
    return structuredClone(fallback);
  }
}

function writeJSON(name, data) {
  const file = filePath(name);
  const temporary = `${file}.tmp`;

  fs.writeFileSync(
    temporary,
    JSON.stringify(data, null, 2)
  );

  fs.renameSync(temporary, file);

  return data;
}

function getGroupSettings(groupId) {
  const groups = readJSON('groups', {});
  return {
    ...DEFAULT_GROUP_SETTINGS,
    ...(groups[groupId] || {})
  };
}

function updateGroupSettings(groupId, updates) {
  const groups = readJSON('groups', {});

  groups[groupId] = {
    ...DEFAULT_GROUP_SETTINGS,
    ...(groups[groupId] || {}),
    ...updates
  };

  writeJSON('groups', groups);
  return groups[groupId];
}

function getUser(userId) {
  const users = readJSON('users', {});
  return users[userId] || {};
}

function updateUser(userId, updates) {
  const users = readJSON('users', {});

  users[userId] = {
    ...(users[userId] || {}),
    ...updates
  };

  writeJSON('users', users);
  return users[userId];
}

function getWarnings(groupId, userId) {
  const warnings = readJSON('warnings', {});
  const group = warnings[groupId] || {};

  if (userId) return group[userId] || 0;

  return group;
}

function addWarning(groupId, userId) {
  const warnings = readJSON('warnings', {});

  if (!warnings[groupId]) warnings[groupId] = {};

  warnings[groupId][userId] =
    (warnings[groupId][userId] || 0) + 1;

  writeJSON('warnings', warnings);
  return warnings[groupId][userId];
}

function removeWarning(groupId, userId) {
  const warnings = readJSON('warnings', {});

  if (warnings[groupId] && warnings[groupId][userId]) {
    warnings[groupId][userId]--;

    if (warnings[groupId][userId] <= 0) {
      delete warnings[groupId][userId];
    }
  }

  writeJSON('warnings', warnings);
  return warnings[groupId]?.[userId] || 0;
}

function clearWarnings(groupId, userId) {
  const warnings = readJSON('warnings', {});

  if (userId) {
    if (warnings[groupId]) {
      delete warnings[groupId][userId];
    }
  } else {
    delete warnings[groupId];
  }

  writeJSON('warnings', warnings);
}

function getModerators() {
  return readJSON('mods', []);
}

function addModerator(userId) {
  const moderators = getModerators();

  if (!moderators.includes(userId)) {
    moderators.push(userId);
  }

  writeJSON('mods', moderators);
  return moderators;
}

function removeModerator(userId) {
  const moderators = getModerators()
    .filter(id => id !== userId);

  writeJSON('mods', moderators);
  return moderators;
}

function isModerator(userId) {
  return getModerators().includes(userId);
}

function getBadWords() {
  const settings = readJSON('settings', {});
  return settings.badWords || [];
}

function addBadWord(word) {
  const settings = readJSON('settings', {});
  const words = settings.badWords || [];

  if (!words.includes(word)) words.push(word);

  settings.badWords = words;
  writeJSON('settings', settings);

  return words;
}

function removeBadWord(word) {
  const settings = readJSON('settings', {});

  settings.badWords = (settings.badWords || [])
    .filter(item => item !== word);

  writeJSON('settings', settings);
  return settings.badWords;
}

function muteUser(groupId, userId) {
  const muted = readJSON('muted', {});

  if (!muted[groupId]) muted[groupId] = [];

  if (!muted[groupId].includes(userId)) {
    muted[groupId].push(userId);
  }

  writeJSON('muted', muted);
  return true;
}

function unmuteUser(groupId, userId) {
  const muted = readJSON('muted', {});

  muted[groupId] = (muted[groupId] || [])
    .filter(id => id !== userId);

  writeJSON('muted', muted);
  return true;
}

function isUserMuted(groupId, userId) {
  const muted = readJSON('muted', {});
  return (muted[groupId] || []).includes(userId);
}

function getMutedUsers(groupId) {
  const muted = readJSON('muted', {});
  return groupId ? (muted[groupId] || []) : muted;
}

function getBotMode() {
  const data = readJSON('botmode', {
    mode: 'public'
  });

  return data.mode || 'public';
}

function setBotMode(mode) {
  if (!VALID_BOT_MODES.includes(mode)) {
    throw new Error('Invalid bot mode');
  }

  writeJSON('botmode', { mode });
  return mode;
}

function getBotSetting(key) {
  const settings = {
    ...BOT_SETTINGS_DEFAULTS,
    ...readJSON('settings', {})
  };

  return settings[key];
}

function setBotSetting(key, value) {
  const settings = readJSON('settings', {});

  settings[key] = value;
  writeJSON('settings', settings);

  return value;
}

function getAllBotSettings() {
  return {
    ...BOT_SETTINGS_DEFAULTS,
    ...readJSON('settings', {})
  };
}

function updateBotSettings(updates) {
  const settings = {
    ...readJSON('settings', {}),
    ...updates
  };

  writeJSON('settings', settings);
  return getAllBotSettings();
}

function getAntiforwardSettings(groupId) {
  const data = readJSON('antiforward', {});
  return data[groupId] || {
    enabled: false,
    action: 'delete'
  };
}

function updateAntiforwardSettings(groupId, updates) {
  const data = readJSON('antiforward', {});

  data[groupId] = {
    ...(data[groupId] || {}),
    ...updates
  };

  writeJSON('antiforward', data);
  return data[groupId];
}

function addAntiforwardWarning(groupId, userId) {
  const data = readJSON('antiforwardWarnings', {});

  if (!data[groupId]) data[groupId] = {};

  data[groupId][userId] =
    (data[groupId][userId] || 0) + 1;

  writeJSON('antiforwardWarnings', data);
  return data[groupId][userId];
}

function getAntiforwardWarningCount(groupId, userId) {
  const data = readJSON('antiforwardWarnings', {});
  return data[groupId]?.[userId] || 0;
}

function clearAntiforwardWarning(groupId, userId) {
  const data = readJSON('antiforwardWarnings', {});

  if (data[groupId]) {
    delete data[groupId][userId];
  }

  writeJSON('antiforwardWarnings', data);
}

function clearAllAntiforwardWarnings(groupId) {
  const data = readJSON('antiforwardWarnings', {});

  delete data[groupId];

  writeJSON('antiforwardWarnings', data);
}

function saveSession(userId, session) {
  const data = readJSON('session', {});

  data[userId] = session;

  writeJSON('session', data);
  return session;
}

function getSession(userId) {
  const data = readJSON('session', {});
  return userId ? data[userId] : data;
}

function clearSession(userId) {
  const data = readJSON('session', {});

  if (userId) {
    delete data[userId];
  } else {
    for (const key of Object.keys(data)) {
      delete data[key];
    }
  }

  writeJSON('session', data);
}

function loadSettings() {
  return readJSON('settingsFile', {});
}

function saveSettings(settings) {
  return writeJSON('settingsFile', settings);
}

function cleanEmoji(text) {
  return String(text || '').replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,
    ''
  );
}

function pickEmoji(items) {
  if (!Array.isArray(items) || items.length === 0) return '';

  return items[Math.floor(Math.random() * items.length)];
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
