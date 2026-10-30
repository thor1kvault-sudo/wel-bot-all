const { Shoukaku, Connectors } = require('shoukaku');
const { redactSecrets } = require('../utils/helpers');

let shoukakuInstance = null;
let discordClient = null;
let isInitialized = false;
let mockNode = null;

/**
 * Reads Lavalink connection configuration from environment variables
 */
function getLavalinkConfig() {
  const host = process.env.LAVALINK_HOST || null;
  const port = parseInt(process.env.LAVALINK_PORT || '2333', 10);
  const password = process.env.LAVALINK_PASSWORD || process.env.LAVALINK_SERVER_PASSWORD || 'youshallnotpass';
  const secure = process.env.LAVALINK_SECURE === 'true' || process.env.LAVALINK_SECURE === '1';

  return {
    host,
    port,
    password,
    secure,
    name: 'thor-apex-main',
    url: host ? `${host}:${port}` : null,
    auth: password,
  };
}

/**
 * Initializes the Lavalink (Shoukaku) manager
 * @param {import('discord.js').Client} client
 */
function initLavalink(client) {
  if (isInitialized && shoukakuInstance) return shoukakuInstance;

  discordClient = client;
  const cfg = getLavalinkConfig();

  if (!cfg.host) {
    console.log('[THOR-LAVALINK] No LAVALINK_HOST configured in environment. Running in direct audio mode.');
    isInitialized = true;
    return null;
  }

  const nodes = [{
    name: cfg.name,
    url: cfg.url,
    auth: cfg.auth,
    secure: cfg.secure,
  }];

  const options = {
    moveOnDisconnect: false,
    resume: true,
    resumeTimeout: 60,
    reconnectTries: 10,
    reconnectInterval: 5000,
    restTimeout: 10000,
  };

  try {
    const connector = new Connectors.DiscordJS(client);
    shoukakuInstance = new Shoukaku(connector, nodes, options);

    // If client is already ready, connect nodes immediately
    if (client.isReady && client.isReady()) {
      connector.ready(nodes);
    }

    shoukakuInstance.on('ready', (name) => {
      console.log(`[THOR-LAVALINK] Node "${name}" connected and ready (Lavalink 4.2.2).`);
    });

    shoukakuInstance.on('error', (name, error) => {
      console.error(redactSecrets(`[THOR-LAVALINK] Node "${name}" error: ${error?.message || error}`));
    });

    shoukakuInstance.on('close', (name, code, reason) => {
      console.warn(`[THOR-LAVALINK] Node "${name}" closed connection (Code: ${code}, Reason: ${reason || 'None'}).`);
    });

    shoukakuInstance.on('disconnect', (name, count) => {
      console.warn(`[THOR-LAVALINK] Node "${name}" disconnected. Reconnection attempt #${count}.`);
    });

    shoukakuInstance.on('reconnecting', (name, left, interval) => {
      console.log(`[THOR-LAVALINK] Node "${name}" reconnecting in ${interval}ms (${left} attempts remaining).`);
    });

    isInitialized = true;
    return shoukakuInstance;
  } catch (err) {
    console.error(redactSecrets(`[THOR-LAVALINK] Failed to initialize Shoukaku: ${err.message}`));
    isInitialized = true;
    return null;
  }
}

/**
 * Returns whether Lavalink is configured in the environment
 */
function isLavalinkConfigured() {
  const cfg = getLavalinkConfig();
  return Boolean(cfg.host);
}

/**
 * Returns whether a Lavalink node is ready to accept connections
 */
function isLavalinkReady() {
  if (mockNode) return true;
  if (!shoukakuInstance) return false;
  try {
    const node = shoukakuInstance.getIdealNode();
    return Boolean(node && node.state === 2 /* CONNECTED / READY */);
  } catch (_) {
    return false;
  }
}

/**
 * Returns the ideal Lavalink node
 */
function getIdealNode() {
  if (mockNode) return mockNode;
  if (!shoukakuInstance) return null;
  try {
    return shoukakuInstance.getIdealNode() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolves tracks from Lavalink
 * @param {string} identifier - Direct URL or search string (e.g. "ytsearch:...", "scsearch:...")
 */
async function resolveTrack(identifier) {
  const node = getIdealNode();
  if (!node) {
    throw new Error('No ready Lavalink node available');
  }

  const res = await node.rest.resolve(identifier);
  if (!res) return null;

  // Normalize Lavalink v4 response
  // loadType: "track" | "playlist" | "search" | "empty" | "error"
  const { loadType, data } = res;

  if (loadType === 'empty') {
    return { loadType: 'empty', tracks: [] };
  }

  if (loadType === 'error') {
    return {
      loadType: 'error',
      exception: data,
      tracks: [],
    };
  }

  if (loadType === 'track') {
    return {
      loadType: 'track',
      tracks: [data],
    };
  }

  if (loadType === 'playlist') {
    return {
      loadType: 'playlist',
      playlistInfo: data.info,
      tracks: data.tracks || [],
    };
  }

  if (loadType === 'search') {
    return {
      loadType: 'search',
      tracks: Array.isArray(data) ? data : [],
    };
  }

  return { loadType, tracks: Array.isArray(data) ? data : [] };
}

/**
 * Joins a voice channel using Lavalink
 * @param {object} options - { guildId, channelId, shardId, deaf }
 */
async function joinVoice(options) {
  if (mockNode && mockNode.joinVoiceChannel) {
    return mockNode.joinVoiceChannel(options);
  }
  if (!shoukakuInstance) {
    throw new Error('Lavalink client is not initialized');
  }
  return shoukakuInstance.joinVoiceChannel({
    guildId: options.guildId,
    channelId: options.channelId,
    shardId: options.shardId || 0,
    deaf: options.deaf !== false,
  });
}

/**
 * Leaves a voice channel and destroys the Lavalink player
 * @param {string} guildId
 */
async function leaveVoice(guildId) {
  if (mockNode && mockNode.leaveVoiceChannel) {
    return mockNode.leaveVoiceChannel(guildId);
  }
  if (!shoukakuInstance) return;
  try {
    await shoukakuInstance.leaveVoiceChannel(guildId);
  } catch (_) {}
}

/**
 * Retrieves the active player for a guild
 * @param {string} guildId
 */
function getPlayer(guildId) {
  if (mockNode && mockNode.players) {
    return mockNode.players.get(guildId) || null;
  }
  if (!shoukakuInstance) return null;
  return shoukakuInstance.players.get(guildId) || null;
}

/**
 * Provides comprehensive telemetry and diagnostic information for Lavalink
 */
function getDiagnostics() {
  const cfg = getLavalinkConfig();
  const configured = Boolean(cfg.host);
  const ready = isLavalinkReady();

  const nodeStats = [];
  if (shoukakuInstance && shoukakuInstance.nodes) {
    for (const [name, node] of shoukakuInstance.nodes) {
      nodeStats.push({
        name,
        state: node.state,
        penalties: node.penalties || 0,
        players: node.stats?.players || 0,
        playingPlayers: node.stats?.playingPlayers || 0,
        uptimeSeconds: Math.floor((node.stats?.uptime || 0) / 1000),
        memoryMB: Math.round((node.stats?.memory?.used || 0) / (1024 * 1024)),
      });
    }
  }

  return {
    targetVersion: '4.2.2',
    configured,
    ready,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    nodesCount: shoukakuInstance?.nodes?.size || 0,
    activePlayers: shoukakuInstance?.players?.size || 0,
    nodes: nodeStats,
  };
}

/**
 * Testing hook to supply a mock node
 */
function _setMockNode(mock) {
  mockNode = mock;
}

module.exports = {
  initLavalink,
  isLavalinkConfigured,
  isLavalinkReady,
  getIdealNode,
  resolveTrack,
  joinVoice,
  leaveVoice,
  getPlayer,
  getDiagnostics,
  getLavalinkConfig,
  _setMockNode,
};
