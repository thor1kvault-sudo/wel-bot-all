const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const GUILDS_DIR = path.join(DATA_DIR, 'guilds');
const LEGACY_CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Ensure storage directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GUILDS_DIR)) fs.mkdirSync(GUILDS_DIR, { recursive: true });

// In-memory cache for ultra-fast, zero-latency retrieval during security events
const configCache = new Map();

/**
 * Returns default schema for a server
 */
function getDefaultGuildConfig(guildId, guildName = 'Server') {
  return {
    guildId: guildId || '',
    guildName: guildName,
    welcome: {
      enabled: true,
      channelId: '',
      rulesChannelId: '',
      funChannelId: '',
      editingChannelId: '',
      gamingChannelId: '',
      generalChannelId: '',
      rolesChannelId: '',
      embedColor: '#FF0000',
      title: 'THOR APEX !',
      greetingPrefix: 'HEY BUDDY!',
      welcomeSubtitle: 'Welcome To THOR APEX !',
      outroText: 'Thanks For Joining. Hope You Have A\nGreat Time Here!',
      bannerUrl: '',
      logoUrl: '',
      thumbnailMode: 'icon',
      useEmbed: true,
      autoRoleId: '',
    },
    goodbye: {
      enabled: true,
      channelId: '',
      embedColor: '#ED4245',
      message: 'Goodbye **{username}**! We now have **{membercount}** members.',
      useEmbed: true,
    },
    security: {
      antiNuke: true,
      action: 'strip_and_ban', // 'alert' | 'quarantine' | 'kick' | 'ban' | 'strip_and_ban'
      thresholds: {
        channelDelete: { limit: 2, windowMs: 15000 },
        channelCreate: { limit: 4, windowMs: 15000 },
        channelUpdate: { limit: 4, windowMs: 15000 },
        roleDelete: { limit: 2, windowMs: 15000 },
        roleCreate: { limit: 4, windowMs: 15000 },
        roleUpdate: { limit: 3, windowMs: 15000 },
        memberBan: { limit: 3, windowMs: 15000 },
        memberKick: { limit: 3, windowMs: 15000 },
        webhookCreate: { limit: 2, windowMs: 15000 },
        webhookDelete: { limit: 2, windowMs: 15000 },
        webhookUpdate: { limit: 3, windowMs: 15000 },
        botAdd: { limit: 1, windowMs: 15000 },
        guildUpdate: { limit: 2, windowMs: 20000 },
        dangerousPermGrant: { limit: 1, windowMs: 10000 },
      },
      trustedUsers: [],
      trustedRoles: [],
      protectedRoles: [],
      lockdown: false,
      emergencyQuarantine: false,
    },
    automod: {
      enabled: true,
      antiSpam: { enabled: true, maxMessages: 5, windowMs: 5000, action: 'timeout', timeoutSec: 60 },
      antiDuplicate: { enabled: true, maxDuplicates: 3, windowMs: 10000, action: 'delete' },
      antiMentionSpam: { enabled: true, maxMentions: 5, action: 'timeout', timeoutSec: 300 },
      antiEveryone: { enabled: true, action: 'delete' },
      antiCaps: { enabled: true, minLength: 10, maxPercentage: 70, action: 'delete' },
      antiInvites: { enabled: true, action: 'delete' },
      antiLinks: {
        enabled: true,
        allowedDomains: ['discord.com', 'tenor.com', 'giphy.com', 'youtube.com', 'youtu.be', 'spotify.com'],
        action: 'delete'
      },
      antiNsfwLinks: { enabled: true, action: 'delete' },
      antiEmojiSpam: { enabled: true, maxEmojis: 6, action: 'delete' },
      wordFilter: {
        enabled: true,
        words: ['nigga', 'nigger', 'fuck', 'shit', 'bitch', 'asshole', 'retard', 'cunt', 'whore', 'faggot'],
        action: 'delete'
      },
      altDetection: { enabled: true, minDays: 7, action: 'kick' },
      antiRaid: { enabled: true, joinThreshold: 8, joinWindowMs: 10000, action: 'lockdown' },
      whitelistUsers: [],
      whitelistRoles: [],
      ignoredChannels: [],
    },
    logging: {
      categoryChannelId: '',
      channels: {
        member: '',
        message: '',
        moderation: '',
        security: '',
        antiNuke: '',
        automod: '',
        role: '',
        channel: '',
        voice: '',
        serverSettings: '',
        invite: '',
        webhook: '',
        bot: '',
        welcome: '',
      },
    },
    warnings: {},
    incidents: [],
  };
}

/**
 * Deep merge utility to populate missing default fields in existing configs
 */
function deepMerge(target, source) {
  const output = { ...target };
  if (!source || typeof source !== 'object') return output;

  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && !Array.isArray(source[key])) {
      if (!(key in target) || !(target[key] instanceof Object) || Array.isArray(target[key])) {
        output[key] = { ...source[key] };
      } else {
        output[key] = deepMerge(target[key], source[key]);
      }
    } else {
      if (!(key in target) || target[key] === undefined) {
        output[key] = source[key];
      }
    }
  }
  return output;
}

/**
 * Atomically writes JSON to disk using a temporary file to prevent corruption
 */
function writeAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    throw err;
  }
}

/**
 * Migrate legacy global config if needed
 */
function loadLegacyConfigFallback() {
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8'));
    } catch (_) {}
  }
  return null;
}

/**
 * Retrieves configuration for a guild. Cached in memory for sub-millisecond access.
 */
function getGuildConfig(guildId, guildName = '') {
  if (!guildId) return getDefaultGuildConfig('global', guildName);

  if (configCache.has(guildId)) {
    return configCache.get(guildId);
  }

  const filePath = path.join(GUILDS_DIR, `${guildId}.json`);
  let config = null;

  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`Failed to read guild config for ${guildId}:`, err.message);
    }
  }

  if (!config) {
    config = getDefaultGuildConfig(guildId, guildName);
    // If legacy config exists, migrate its values as starting point
    const legacy = loadLegacyConfigFallback();
    if (legacy) {
      if (legacy.welcomeChannelId) config.welcome.channelId = legacy.welcomeChannelId;
      if (legacy.leaveChannelId) config.goodbye.channelId = legacy.leaveChannelId;
      if (legacy.rulesChannelId) config.welcome.rulesChannelId = legacy.rulesChannelId;
      if (legacy.rolesChannelId) config.welcome.rolesChannelId = legacy.rolesChannelId;
      if (legacy.generalChannelId) config.welcome.chillChannelId = legacy.generalChannelId;
      if (legacy.embedColor) config.welcome.embedColor = legacy.embedColor;
      if (legacy.autoRoleId) config.welcome.autoRoleId = legacy.autoRoleId;
      if (legacy.logChannelId) config.logging.channels.moderation = legacy.logChannelId;
      if (legacy.voiceLogChannelId) config.logging.channels.voice = legacy.voiceLogChannelId;
      if (legacy.roleLogChannelId) config.logging.channels.role = legacy.roleLogChannelId;
      if (legacy.memberLogChannelId) config.logging.channels.member = legacy.memberLogChannelId;
      if (legacy.security) {
        if (legacy.security.antiNuke !== undefined) config.security.antiNuke = legacy.security.antiNuke;
        if (legacy.security.whitelistedUsers) config.security.trustedUsers = legacy.security.whitelistedUsers;
        if (legacy.security.whitelistedRoles) config.security.trustedRoles = legacy.security.whitelistedRoles;
        if (legacy.security.lockdown !== undefined) config.security.lockdown = legacy.security.lockdown;
      }
    }
    saveGuildConfig(guildId, config);
  } else {
    // Fill in any new fields added in newer versions
    const defaults = getDefaultGuildConfig(guildId, guildName || config.guildName);
    config = deepMerge(config, defaults);
  }

  if (guildName && config.guildName !== guildName) {
    config.guildName = guildName;
  }

  configCache.set(guildId, config);
  return config;
}

/**
 * Saves guild configuration to disk and updates cache.
 */
function saveGuildConfig(guildId, config) {
  if (!guildId) return;
  const filePath = path.join(GUILDS_DIR, `${guildId}.json`);
  configCache.set(guildId, config);
  try {
    writeAtomic(filePath, config);
  } catch (err) {
    console.error(`Failed to save config for guild ${guildId}:`, err.message);
  }
}

/**
 * Updates a guild configuration with a callback function.
 */
function updateGuildConfig(guildId, mutatorFn, guildName = '') {
  const current = getGuildConfig(guildId, guildName);
  mutatorFn(current);
  saveGuildConfig(guildId, current);
  return current;
}

/**
 * Invalidate cache if needed
 */
function invalidateCache(guildId) {
  if (guildId) configCache.delete(guildId);
  else configCache.clear();
}

module.exports = {
  getDefaultGuildConfig,
  getGuildConfig,
  saveGuildConfig,
  updateGuildConfig,
  invalidateCache,
};
