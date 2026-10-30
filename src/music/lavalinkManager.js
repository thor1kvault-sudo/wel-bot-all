const { Shoukaku, Connectors, Constants } = require('shoukaku');
const { redactSecrets } = require('../utils/helpers');

let shoukakuInstance = null;
let discordClient = null;
let isInitialized = false;
let mockNode = null;

/**
 * Reads Lavalink connection configuration from environment variables.
 * Robustly parses URLs, protocols, ports, and credentials for Render and local deployments.
 */
function getLavalinkConfig() {
  let rawHost = process.env.LAVALINK_HOST || null;
  let secure = process.env.LAVALINK_SECURE === 'true' || process.env.LAVALINK_SECURE === '1';
  let port = process.env.LAVALINK_PORT ? parseInt(process.env.LAVALINK_PORT, 10) : null;
  const password = process.env.LAVALINK_PASSWORD || process.env.LAVALINK_SERVER_PASSWORD || 'youshallnotpass';

  let cleanHost = null;
  if (rawHost) {
    let h = rawHost.trim();
    if (h.startsWith('https://')) {
      secure = true;
      h = h.slice(8);
    } else if (h.startsWith('http://')) {
      h = h.slice(7);
    } else if (h.startsWith('wss://')) {
      secure = true;
      h = h.slice(6);
    } else if (h.startsWith('ws://')) {
      h = h.slice(5);
    }

    if (h.endsWith('/')) {
      h = h.slice(0, -1);
    }

    // Check if host contains an explicit port (e.g. "thor-apex-lavalink:2333" or "domain.com:443")
    if (h.includes(':')) {
      const parts = h.split(':');
      cleanHost = parts[0];
      if (!port && parts[1]) {
        port = parseInt(parts[1], 10);
      }
    } else {
      cleanHost = h;
    }
  }

  // Default port based on SSL/protocol if still unset
  if (!port || isNaN(port)) {
    port = secure ? 443 : 2333;
  }

  return {
    host: cleanHost,
    port,
    password,
    secure,
    name: 'thor-apex-main',
    url: cleanHost ? `${cleanHost}:${port}` : null,
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

const CONNECTED_STATE = Constants?.State?.CONNECTED ?? 1;

/**
 * Validates whether a Lavalink node is strictly in the CONNECTED state.
 * In Shoukaku 4.3.0:
 *   0 = CONNECTING
 *   1 = CONNECTED
 *   2 = DISCONNECTING
 *   3 = DISCONNECTED
 * @param {object} node
 * @returns {boolean}
 */
function isNodeConnected(node) {
  if (!node) return false;
  return node.state === CONNECTED_STATE;
}

/**
 * Returns whether a Lavalink node is ready to accept connections.
 * Accepts ONLY the actual CONNECTED state (Constants.State.CONNECTED).
 * Rejects CONNECTING (0), DISCONNECTING (2), and DISCONNECTED (3).
 */
function isLavalinkReady() {
  if (mockNode) {
    if (typeof mockNode.state !== 'undefined') {
      return isNodeConnected(mockNode);
    }
    return true;
  }
  if (!shoukakuInstance) return false;
  try {
    const node = getIdealNode();
    return isNodeConnected(node);
  } catch (_) {
    return false;
  }
}

/**
 * Returns the ideal Lavalink node strictly in the CONNECTED state.
 */
function getIdealNode() {
  if (mockNode) {
    if (typeof mockNode.state !== 'undefined') {
      return isNodeConnected(mockNode) ? mockNode : null;
    }
    return mockNode;
  }
  if (!shoukakuInstance) return null;
  try {
    const ideal = shoukakuInstance.getIdealNode();
    if (ideal && isNodeConnected(ideal)) return ideal;
    if (shoukakuInstance.nodes && shoukakuInstance.nodes.size > 0) {
      for (const node of shoukakuInstance.nodes.values()) {
        if (isNodeConnected(node)) {
          return node;
        }
      }
    }
    return null;
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

  // 1. If player & connection already exist on the target channel, reuse them
  const existingPlayer = shoukakuInstance.players?.get?.(options.guildId);
  const existingConn = shoukakuInstance.connections?.get?.(options.guildId);
  if (existingPlayer && existingConn && existingConn.channelId === options.channelId) {
    console.log(`[THOR-LAVALINK] Reusing existing player in guild ${options.guildId} (channel: ${options.channelId})`);
    return existingPlayer;
  }

  // 2. Cleanly leave existing/stale connection before creating a new one to prevent 'already have an existing connection' error
  if (existingConn || existingPlayer) {
    console.log(`[THOR-LAVALINK] Cleaning up prior voice connection in guild ${options.guildId} before joining ${options.channelId}`);
    try {
      await shoukakuInstance.leaveVoiceChannel(options.guildId);
    } catch (_) {}
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

/**
 * Testing hook to supply a mock shoukaku instance
 */
function _setShoukakuInstance(mock) {
  shoukakuInstance = mock;
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
  getShoukakuInstance: () => shoukakuInstance,
  _setMockNode,
  _setShoukakuInstance,
  isNodeConnected,
  CONNECTED_STATE,
};
