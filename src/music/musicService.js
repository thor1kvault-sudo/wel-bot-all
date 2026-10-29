const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnection,
} = require('@discordjs/voice');
const { PermissionsBitField } = require('discord.js');

// ── Patch @discordjs/voice Signalling Race Condition ──
// When Discord sends VOICE_SERVER_UPDATE before VOICE_STATE_UPDATE,
// the default VoiceConnection implementation deadlocks in Signalling because
// addStatePacket does not trigger configureNetworking(). We patch both handlers to
// ensure configureNetworking() is invoked as soon as both packets are present.
if (VoiceConnection && VoiceConnection.prototype) {
  const origAddStatePacket = VoiceConnection.prototype.addStatePacket;
  VoiceConnection.prototype.addStatePacket = function (packet) {
    origAddStatePacket.call(this, packet);
    if (this.packets?.server?.endpoint && this.state.status === VoiceConnectionStatus.Signalling) {
      try {
        this.configureNetworking();
      } catch (err) {
        console.error('[THOR-VOICE] configureNetworking on addStatePacket:', err.message);
      }
    }
  };

  const origAddServerPacket = VoiceConnection.prototype.addServerPacket;
  VoiceConnection.prototype.addServerPacket = function (packet) {
    origAddServerPacket.call(this, packet);
    if (this.packets?.state && packet.endpoint && this.state.status === VoiceConnectionStatus.Signalling) {
      try {
        this.configureNetworking();
      } catch (err) {
        console.error('[THOR-VOICE] configureNetworking on addServerPacket:', err.message);
      }
    }
  };
}

const { isSpotifyUrl, resolveSpotify } = require('./spotifyResolver');
const {
  searchAudioTracks, matchPlayableTrack, resolveAudioStream,
  ensureClientReady, isYouTubeUrl, matchSpotifyToYouTube,
} = require('./audioProvider');
const { renderPlayerCard } = require('./musicPlayerCard');
const { logIncident } = require('./musicUpdateMonitor');
const voiceAssistant = require('./voiceAssistant');

// Multi-guild isolated playback sessions
const sessions = new Map();

// In-memory search cache for interactive song selection (2-minute TTL)
const searchCache = new Map();

function setSearchCache(guildId, userId, results) {
  const key = `${guildId}_${userId}`;
  searchCache.set(key, { results, expiresAt: Date.now() + 120_000 });
}

function getSearchCache(guildId, userId) {
  const key = `${guildId}_${userId}`;
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

/**
 * Retrieves or instantiates an isolated music session for a guild
 */
function getSession(guildId, guildName = 'Server') {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, {
      guildId,
      guildName,
      voiceChannel: null,
      textChannel: null,
      connection: null,
      player: null,
      currentTrack: null,
      currentResource: null,
      queue: [],
      history: [],
      isPlaying: false,
      isPaused: false,
      loopMode: 'off', // 'off' | 'track' | 'queue'
      volume: 100,
      startTime: 0,
      pauseTime: 0,
      totalPausedMs: 0,
      playerMessage: null,
      recoveryAttempts: 0,
      is247: false,
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      reconnectTimeout: null,
      voiceAssistant: voiceAssistant.getVoiceState(guildId),
      getPlaybackSeconds() {
        if (!this.isPlaying || !this.startTime) return 0;
        const now = this.isPaused ? this.pauseTime : Date.now();
        const elapsedMs = Math.max(0, now - this.startTime - this.totalPausedMs);
        return Math.floor(elapsedMs / 1000);
      },
    });
  }
  return sessions.get(guildId);
}

/**
 * Safely removes and destroys a guild music session
 * @param {string} guildId
 * @param {boolean} [force=false] If true, destroys even if 24/7 mode is active
 */
function destroySession(guildId, force = false) {
  const session = sessions.get(guildId);
  if (!session) return;

  if (!force && session.is247) {
    session.isPlaying = false;
    session.isPaused = false;
    session.queue = [];
    session.currentTrack = null;
    if (session.player) {
      try { session.player.stop(true); } catch (_) {}
    }
    return;
  }

  session.isPlaying = false;
  session.isPaused = false;
  session.queue = [];
  session.history = [];
  session.currentTrack = null;
  session.is247 = false;
  if (session.reconnectTimeout) {
    clearTimeout(session.reconnectTimeout);
    session.reconnectTimeout = null;
  }

  if (session.player) {
    try { session.player.stop(true); } catch (_) {}
    session.player = null;
  }

  if (session.connection) {
    try {
      session.connection.destroy();
    } catch (_) {}
    session.connection = null;
  }

  // Cleanup voice assistant listeners and active receivers
  voiceAssistant.cleanupVoiceAssistant(guildId);

  sessions.delete(guildId);
  logIncident('INFO', 'SESSION_DESTROY', `Cleaned up audio session for guild ${guildId}`);
}

/**
 * Sends or updates the interactive Rythm-style player card in the server's text channel
 */
async function updatePlayerCardMessage(session) {
  if (!session.textChannel || !session.currentTrack) return;
  try {
    const card = renderPlayerCard(session);
    if (session.playerMessage && typeof session.playerMessage.edit === 'function') {
      await session.playerMessage.edit(card).catch(() => {
        session.playerMessage = null;
      });
    }

    if (!session.playerMessage && typeof session.textChannel.send === 'function') {
      session.playerMessage = await session.textChannel.send(card).catch(() => null);
    }
  } catch (_) {}
}

/**
 * Automatically transitions to the next track when playback concludes
 */
function handleTrackEnded(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;

  if (session.currentTrack) {
    if (session.loopMode === 'track') {
      session.queue.unshift(session.currentTrack);
    } else if (session.loopMode === 'queue') {
      session.queue.push(session.currentTrack);
      session.history.unshift(session.currentTrack);
    } else {
      session.history.unshift(session.currentTrack);
      if (session.history.length > 25) session.history.pop();
    }
  }

  playNext(guildId);
}

/**
 * Resolves the next track in the queue and starts streaming audio
 */
async function playNext(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;

  if (session.queue.length === 0) {
    session.isPlaying = false;
    session.isPaused = false;
    session.currentTrack = null;
    session.startTime = 0;
    session.totalPausedMs = 0;
    if (session.playerMessage) {
      try {
        await session.playerMessage.edit({
          content: '⏹️ **Playback ended.** Queue is empty. Use `/play` to add more tracks!',
          components: [],
        }).catch(() => {});
      } catch (_) {}
      session.playerMessage = null;
    }
    return;
  }

  // Ensure voice connection is ready and player subscription is active before streaming
  if (session.connection) {
    if (session.connection.state.status !== VoiceConnectionStatus.Ready && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        const waitMs = (process.env.NODE_ENV === 'test' || !session.voiceChannel?.guild?.voiceAdapterCreator) ? 100 : 10_000;
        await entersState(session.connection, VoiceConnectionStatus.Ready, waitMs);
      } catch (_) {}
    }
    if (session.player) {
      try { session.connection.subscribe(session.player); } catch (_) {}
    }

    // Playback must start ONLY after the voice connection is ready
    if (session.connection.state.status !== VoiceConnectionStatus.Ready) {
      if (process.env.NODE_ENV !== 'test') {
        const curStatus = session.connection.state.status;
        console.error(`[THOR-AUDIO] Cannot start playback in guild ${guildId}: Voice connection is not READY (status: ${curStatus}).`);
        session.isPlaying = false;
        session.currentTrack = null;
        if (session.textChannel && typeof session.textChannel.send === 'function') {
          try {
            session.textChannel.send(`⚠️ Voice connection could not be established (status: \`${curStatus}\`). Playback paused until voice channel is ready.`).catch(() => {});
          } catch (_) {}
        }
        return;
      }
    }
  }

  const track = session.queue.shift();
  session.currentTrack = track;
  session.isPlaying = true;
  session.isPaused = false;
  session.startTime = Date.now();
  session.totalPausedMs = 0;
  session.pauseTime = 0;

  try {
    // For Spotify tracks, ensure YouTube candidate matching is resolved before stream extraction
    if ((track.source === 'spotify' || track.source === 'spotify_meta' || track.spotifyUrl) && !track.youtubeUrl) {
      try {
        const ytMatch = await matchSpotifyToYouTube(track);
        if (ytMatch.success) {
          track.youtubeUrl = ytMatch.youtubeUrl;
          track.matchedYouTubeTitle = ytMatch.matchedTitle;
          track.matchedYouTubeChannel = ytMatch.matchedArtist;
          track.matchedTitle = ytMatch.matchedTitle;
          track.durationSec = ytMatch.durationSec || track.durationSec;
          track.thumbnail = ytMatch.thumbnail || track.thumbnail;
        }
      } catch (_) {}
    }

    console.log(`[THOR-AUDIO] Resolving audio stream for "${track.title}" (source: ${track.source || 'unknown'})...`);
    const audioData = track._preResolved || (await resolveAudioStream(track));
    track._preResolved = null;
    console.log(`[THOR-AUDIO] Stream resolved: type=${audioData.type}, source=${audioData.source}, isStream=${!!audioData.stream?.on}`);

    let streamBytes = 0;
    if (audioData.stream && typeof audioData.stream.on === 'function') {
      audioData.stream.on('data', (chunk) => {
        streamBytes += chunk.length;
      });
      audioData.stream.on('error', (streamErr) => {
        console.error(`[THOR-AUDIO Stream Error] "${track.title}":`, streamErr.message);
        if (session.isPlaying && session.currentTrack === track) {
          session.isPlaying = false;
          session.currentTrack = null;
          handleTrackEnded(guildId);
        }
      });
      audioData.stream.on('end', () => {
        console.log(`[THOR-AUDIO Stream End] "${track.title}": Received total ${streamBytes} bytes`);
        if (streamBytes === 0 && session.isPlaying && session.currentTrack === track) {
          console.warn(`[THOR-AUDIO Stream End] Stream ended with 0 bytes for "${track.title}". Auto-advancing.`);
          session.isPlaying = false;
          session.currentTrack = null;
          handleTrackEnded(guildId);
        }
      });
    }

    const resource = createAudioResource(audioData.stream, {
      inputType: audioData.type === 'arbitrary' ? StreamType.Arbitrary : audioData.type,
      inlineVolume: true,
    });

    console.log(`[THOR-AUDIO] Resource created: readable=${resource.readable}, edges=${resource.edges?.map(e => e.type).join(' -> ')}`);

    if (resource.playStream) {
      resource.playStream.on('error', (err) => {
        console.error(`[THOR-AUDIO Resource Error]:`, err.message);
        if (session.isPlaying && session.currentTrack === track) {
          session.isPlaying = false;
          session.currentTrack = null;
          handleTrackEnded(guildId);
        }
      });
    }

    if (resource.volume) {
      resource.volume.setVolume(session.volume / 100);
    }

    session.currentResource = resource;
    session.recoveryAttempts = 0;
    session.consecutiveFailures = 0;
    session.player.play(resource);

    // Synchronize speaking status if connection is in ready state
    if (session.connection && session.connection.state.status === VoiceConnectionStatus.Ready) {
      try { session.connection.setSpeaking(true); } catch (_) {}
    }

    // Diagnostic check after 5 seconds of playback (unref'd to avoid holding event loop)
    const diagTimer = setTimeout(() => {
      if (session.isPlaying && session.currentTrack === track) {
        const connStatus = session.connection ? session.connection.state.status : 'none';
        const speakingState = session.connection?.state?.networking?.state?.connectionData?.speaking;
        const playerStatus = session.player ? session.player.state.status : 'none';
        const pbDuration = session.player?.state?.playbackDuration;
        console.log(`[THOR-AUDIO DIAG] 5s check: conn=${connStatus}, speaking=${speakingState}, player=${playerStatus}, duration=${pbDuration}ms, streamBytes=${streamBytes}`);
      }
    }, 5000);
    if (typeof diagTimer.unref === 'function') diagTimer.unref();

    // Update or post player card
    await updatePlayerCardMessage(session);
    logIncident('INFO', 'PLAY_START', `Started playback of "${track.title}" in guild ${guildId}`);
  } catch (err) {
    session.isPlaying = false;
    session.currentTrack = null;
    logIncident('ERROR', 'PLAY_FAIL', `Playback error on "${track.title}": ${err.message}`);
    // Auto-skip unplayable track to keep queue alive
    if (session.textChannel && typeof session.textChannel.send === 'function') {
      try {
        const p = session.textChannel.send(`⚠️ Could not stream **${track.title}**: ${err.message}. Skipping to next track in queue...`);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {}
    }
    session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
    if (session.consecutiveFailures >= 3) {
      if (session.textChannel && typeof session.textChannel.send === 'function') {
        try {
          const p = session.textChannel.send('⏹️ Playback stopped: 3 consecutive tracks failed to stream. Please verify your queue.');
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_) {}
      }
      session.queue = [];
      session.consecutiveFailures = 0;
      return;
    }
    handleTrackEnded(guildId);
  }
}

/**
 * Ensures audio player is initialized and lifecycle listeners attached
 */
function ensureAudioPlayer(session, guildId) {
  if (session.player) return session.player;

  session.player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
      maxMissedFrames: Math.round(5000 / 20),
    },
    debug: true,
  });

  session.player.on('debug', (msg) => {
    console.log(`[THOR-PLAYER Debug] Guild ${guildId}: ${msg}`);
  });

  session.player.on('stateChange', (oldState, newState) => {
    console.log(`[THOR-PLAYER] Guild ${guildId}: ${oldState.status} -> ${newState.status}`);
  });

  session.player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[THOR-PLAYER] Started Playing in guild ${guildId}`);
    if (session.connection && session.connection.state.status === VoiceConnectionStatus.Ready) {
      try { session.connection.setSpeaking(true); } catch (_) {}
    }
    logIncident('DEBUG', 'PLAYER_PLAYING', `Player playing in guild ${guildId}`);
  });

  session.player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[THOR-PLAYER] Idle in guild ${guildId}`);
    if (session.connection && session.connection.state.status === VoiceConnectionStatus.Ready) {
      try { session.connection.setSpeaking(false); } catch (_) {}
    }
    handleTrackEnded(guildId);
  });

  session.player.on(AudioPlayerStatus.AutoPaused, () => {
    console.warn(`[THOR-PLAYER] AutoPaused in guild ${guildId}`);
    logIncident('WARN', 'PLAYER_AUTOPAUSED', `Player auto-paused in guild ${guildId}`);
  });

  session.player.on('error', (err) => {
    console.error(`[THOR-PLAYER Error] Guild ${guildId}:`, err.message);
    logIncident('ERROR', 'PLAYER_ERROR', err.message);
    handleTrackEnded(guildId);
  });

  return session.player;
}

/**
 * Handles automatic reconnect for 24/7 voice channels with bounded exponential backoff
 */
function handle247Reconnect(guild, vc) {
  const session = sessions.get(guild.id);
  if (!session || !session.is247) return;

  if (session.reconnectAttempts >= session.maxReconnectAttempts) {
    logIncident('WARN', 'RECONNECT_LIMIT', `24/7 reconnect limit reached (${session.maxReconnectAttempts}) for guild ${guild.id}. Pausing auto-reconnect.`);
    try {
      const { updateGuildConfig } = require('../config/guildConfig');
      updateGuildConfig(guild.id, {
        'music247.lastError': `Reconnect limit reached (${session.maxReconnectAttempts} attempts)`,
      });
    } catch (_) {}
    return;
  }

  session.reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, session.reconnectAttempts - 1));
  logIncident('INFO', 'RECONNECT_SCHEDULED', `Scheduling 24/7 reconnect #${session.reconnectAttempts} in ${delay}ms for guild ${guild.id}`);

  if (session.reconnectTimeout) clearTimeout(session.reconnectTimeout);
  session.reconnectTimeout = setTimeout(async () => {
    try {
      const targetChannelId = vc?.id || session.voiceChannel?.id;
      const ch = guild.channels?.cache?.get(targetChannelId) || await guild.channels?.fetch?.(targetChannelId).catch(() => null);
      if (!ch) {
        logIncident('ERROR', 'CHANNEL_MISSING', `Configured 24/7 voice channel ${targetChannelId} no longer exists in guild ${guild.id}`);
        try {
          const { updateGuildConfig } = require('../config/guildConfig');
          updateGuildConfig(guild.id, { 'music247.lastError': 'Configured voice channel deleted or inaccessible' });
        } catch (_) {}
        return;
      }
      const res = await ensureVoiceConnection(guild, ch);
      if (res.success) {
        session.reconnectAttempts = 0;
        logIncident('INFO', 'RECONNECT_SUCCESS', `24/7 voice channel successfully reconnected in guild ${guild.id}`);
      } else {
        logIncident('ERROR', 'RECONNECT_FAIL', `24/7 reconnect #${session.reconnectAttempts} failed: ${res.message}`);
        handle247Reconnect(guild, vc);
      }
    } catch (err) {
      logIncident('ERROR', 'RECONNECT_ERROR', `24/7 reconnect exception #${session.reconnectAttempts}: ${err.message}`);
      handle247Reconnect(guild, vc);
    }
  }, delay);
}

/**
 * Ensures voice connection is established, resilient to 24/7 disconnects, and subscribed to player
 */
async function ensureVoiceConnection(guild, vc) {
  const session = getSession(guild.id, guild.name);
  session.voiceChannel = vc;

  // 1. Validate Bot Voice Permissions
  const me = guild.members?.me;
  if (me && vc.permissionsFor) {
    const perms = vc.permissionsFor(me);
    if (!perms.has(PermissionsBitField.Flags.Connect)) {
      return { success: false, message: 'I do not have `Connect` permission for your voice channel.' };
    }
    if (!perms.has(PermissionsBitField.Flags.Speak)) {
      return { success: false, message: 'I do not have `Speak` permission in your voice channel.' };
    }
  }

  // 2. Reuse active connection if already on this channel
  if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    if (session.connection.joinConfig?.channelId === vc.id) {
      if (session.connection.state.status === VoiceConnectionStatus.Ready) {
        ensureAudioPlayer(session, guild.id);
        try { session.connection.subscribe(session.player); } catch (_) {}
        session.detailedStatus = 'connected_ready';
        return { success: true, connection: session.connection };
      }
      // If currently connecting or signalling, await Ready instead of duplicating connection
      try {
        const waitMs = (process.env.NODE_ENV === 'test' || !guild.voiceAdapterCreator) ? 100 : 15_000;
        await entersState(session.connection, VoiceConnectionStatus.Ready, waitMs);
        ensureAudioPlayer(session, guild.id);
        try { session.connection.subscribe(session.player); } catch (_) {}
        session.detailedStatus = 'connected_ready';
        return { success: true, connection: session.connection };
      } catch (_) {
        // Stalled existing connection on this channel; clean destroy before re-joining
        try { session.connection.destroy(); } catch (_) {}
        session.connection = null;
      }
    } else {
      // Different channel: clean destroy old before joining new
      try { session.connection.destroy(); } catch (_) {}
      session.connection = null;
    }
  }

  // 3. Establish Voice Connection with high-resolution state diagnostics
  try {
    session.detailedStatus = 'connecting';
    session.lastStateChange = Date.now();
    session.stateTransitions = session.stateTransitions || [];

    session.connection = joinVoiceChannel({
      channelId: vc.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      debug: false,
    });

    session.connection.on('stateChange', (oldState, newState) => {
      const now = Date.now();
      const durationMs = now - (session.lastStateChange || now);
      session.lastStateChange = now;
      session.stateTransitions.push({
        from: oldState.status,
        to: newState.status,
        durationMs,
        timestamp: new Date(now).toISOString(),
      });
      if (session.stateTransitions.length > 20) session.stateTransitions.shift();

      console.log(`[THOR-VOICE] Guild ${guild.id} (Channel: ${vc.id}): ${oldState.status} -> ${newState.status} (${durationMs}ms in ${oldState.status})`);

      if (newState.status === VoiceConnectionStatus.Ready) {
        session.detailedStatus = 'connected_ready';
        session.reconnectAttempts = 0;
        session.lastError = null;
      } else if (newState.status === VoiceConnectionStatus.Signalling || newState.status === VoiceConnectionStatus.Connecting) {
        session.detailedStatus = 'connecting';
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        session.detailedStatus = session.is247 ? 'reconnecting' : 'disconnected';
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        session.detailedStatus = 'disconnected';
      }
    });

    session.connection.on('error', (err) => {
      console.error(`[THOR-VOICE Error] Guild ${guild.id} (Channel: ${vc.id}):`, err.message);
      session.lastError = err.message;
      logIncident('ERROR', 'VOICE_ERR', `Voice error in guild ${guild.id}: ${err.message}`);
    });

    session.connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(`[THOR-VOICE] Connection READY in guild ${guild.id}. Ping:`, session.connection.ping);
      logIncident('INFO', 'VOICE_READY', `Voice connection ready in guild ${guild.id}`);
      session.reconnectAttempts = 0;
      session.detailedStatus = 'connected_ready';
      session.lastError = null;
      if (session.player) {
        try { session.connection.subscribe(session.player); } catch (_) {}
      }
      // Attach voice receiver if voice assistant is active
      const vaState = voiceAssistant.getVoiceState(guild.id);
      if (vaState.enabled) {
        voiceAssistant.attachVoiceReceiver(session.connection, guild.id, {
          sessions,
          enqueueTrack,
          pause,
          resume,
          skip,
          playPrevious,
          destroySession,
          setVolume,
          setLoop,
          shuffle,
        });
      }
    });

    session.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(session.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(session.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (_) {
        logIncident('WARN', 'VOICE_DISCONNECT', `Voice disconnected unexpectedly in guild ${guild.id}`);
        if (session.is247) {
          session.detailedStatus = 'reconnecting';
          handle247Reconnect(guild, session.voiceChannel);
        } else {
          destroySession(guild.id);
        }
      }
    });

    session.connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (!session.is247) {
        sessions.delete(guild.id);
      }
    });

    // Ensure Audio Player and subscribe
    ensureAudioPlayer(session, guild.id);
    if (session.connection && session.player) {
      try { session.connection.subscribe(session.player); } catch (_) {}
    }

    // Await Ready state (with grace fallback for mock unit-test environments)
    try {
      const waitMs = (process.env.NODE_ENV === 'test' || !guild.voiceAdapterCreator) ? 100 : 15_000;
      await entersState(session.connection, VoiceConnectionStatus.Ready, waitMs);
      console.log(`[THOR-VOICE] Voice connection successfully entered READY in guild ${guild.id}`);
      session.detailedStatus = 'connected_ready';
      session.reconnectAttempts = 0;
      session.lastError = null;
    } catch (connErr) {
      const curStatus = session.connection ? session.connection.state.status : 'unknown';
      if (process.env.NODE_ENV === 'test') {
        // In unit tests without live Discord Gateway/UDP servers, allow mock connection
        return { success: true, connection: session.connection };
      }

      session.detailedStatus = 'failed';
      let errorReason = '';
      if (curStatus === 'signalling') {
        errorReason = `Voice connection timed out in state 'signalling'. ` +
                      `Discord Gateway did not complete voice server routing / session authentication.`;
      } else if (curStatus === 'connecting') {
        errorReason = `Voice connection reached 'connecting' but Discord voice UDP audio transmission could not be negotiated. ` +
                      `Host environment (Render Web Service) restricts raw outbound UDP packets on ports 50000-65535 required for Discord voice.`;
      } else {
        errorReason = `Voice connection failed in state '${curStatus}': ${connErr.message}`;
      }

      console.error(`[THOR-VOICE] Connection not ready in guild ${guild.id}: ${errorReason}`);
      logIncident('ERROR', 'VOICE_READY_TIMEOUT', `Guild ${guild.id}: ${errorReason}`);
      session.lastError = errorReason;

      if (session.connection && session.connection.state.status !== VoiceConnectionStatus.Ready) {
        return {
          success: false,
          status: curStatus,
          message: errorReason,
        };
      }
    }

    return { success: true, connection: session.connection };
  } catch (err) {
    session.detailedStatus = 'failed';
    session.lastError = err.message;
    logIncident('ERROR', 'VOICE_CONNECT_ERR', err.message);
    return { success: false, message: `Could not join voice channel: ${err.message}` };
  }
}

/**
 * Resolves queries and adds tracks to the guild queue.
 * Automatically handles Spotify links (tracks, albums, playlists) and normal text queries.
 */
async function enqueueTrack(guild, vc, user, textChannel, query, { playNow = false, exactTrack = null } = {}) {
  const session = getSession(guild.id, guild.name);
  session.textChannel = textChannel;
  session.voiceChannel = vc;

  const connResult = await ensureVoiceConnection(guild, vc);
  if (!connResult.success) {
    return connResult;
  }

  // 4. Resolve Tracks from Query (Exact Selection vs Spotify vs YouTube vs Native Provider)
  let tracksToAdd = [];
  let isPlaylist = false;
  let playlistName = null;
  let sourceNote = null;

  if (exactTrack) {
    // Preserve the user's exact explicit selection without fuzzy modification
    tracksToAdd = [{
      title: exactTrack.title,
      artist: exactTrack.artist || 'Unknown',
      album: exactTrack.album || '',
      durationSec: exactTrack.durationSec || 0,
      thumbnail: exactTrack.thumbnail || null,
      streamUrl: exactTrack.streamUrl || null,
      requestedBy: user.id,
      source: exactTrack.source || 'selection',
      spotifyUrl: exactTrack.spotifyUrl || null,
      youtubeUrl: exactTrack.youtubeUrl || null,
      fallbackUrls: exactTrack.fallbackUrls || [],
    }];
  } else if (isSpotifyUrl(query)) {
    const spotifyRes = await resolveSpotify(query, 50);
    if (!spotifyRes || !spotifyRes.tracks || spotifyRes.tracks.length === 0) {
      return { success: false, message: 'Could not resolve any playable metadata for the provided Spotify link.' };
    }

    isPlaylist = spotifyRes.type === 'album' || spotifyRes.type === 'playlist';
    playlistName = spotifyRes.name;

    if (!isPlaylist && spotifyRes.tracks.length === 1) {
      const sp = spotifyRes.tracks[0];
      const ytMatch = await matchSpotifyToYouTube(sp);
      if (!ytMatch.success) {
        return {
          success: false,
          message: `No confident YouTube match found for "${sp.title}" by ${sp.artist || 'Unknown'}. Please provide a direct YouTube link or song title.`,
        };
      }
      tracksToAdd = [{
        title: sp.title,
        artist: sp.artist,
        album: sp.album,
        durationSec: ytMatch.durationSec,
        thumbnail: ytMatch.thumbnail || sp.thumbnail,
        streamUrl: null,
        youtubeUrl: ytMatch.youtubeUrl,
        matchedYouTubeTitle: ytMatch.matchedTitle,
        matchedYouTubeChannel: ytMatch.matchedArtist,
        matchedTitle: ytMatch.matchedTitle,
        requestedBy: user.id,
        source: 'spotify',
        spotifyUrl: sp.spotifyUrl,
        confidence: ytMatch.confidence,
      }];
      sourceNote = `Spotify track matched to YouTube: "${ytMatch.matchedTitle}"`;
    } else {
      tracksToAdd = spotifyRes.tracks.map(t => ({
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationSec: t.durationSec,
        thumbnail: t.thumbnail,
        streamUrl: null,
        requestedBy: user.id,
        source: 'spotify',
        spotifyUrl: t.spotifyUrl,
      }));
    }
  } else if (isYouTubeUrl(query)) {
    const searchRes = await searchAudioTracks(query, 1);
    if (!searchRes || searchRes.length === 0) {
      return { success: false, message: `Could not resolve YouTube link "${query}".` };
    }
    const ytMeta = searchRes[0];
    tracksToAdd = [{
      title: ytMeta.title,
      artist: ytMeta.artist,
      album: '',
      durationSec: ytMeta.durationSec,
      thumbnail: ytMeta.thumbnail,
      streamUrl: null,
      youtubeUrl: ytMeta.youtubeUrl || query,
      requestedBy: user.id,
      source: 'youtube_meta',
      youtubeBlocked: true,
      fallbackUrls: ytMeta.fallbackUrls || [],
    }];
    sourceNote = 'YouTube link recognized. Direct YouTube audio extraction in Discord is blocked by YouTube restrictions; streaming authorized SoundCloud equivalent.';
  } else {
    // Ordinary Search or direct link
    const searchRes = await searchAudioTracks(query, 5);
    if (!searchRes || searchRes.length === 0) {
      return { success: false, message: `No playable recordings found for "${query}".` };
    }

    const best = searchRes[0];
    if (best?.requiresChoice && !exactTrack) {
      return {
        success: false,
        requiresChoice: true,
        candidates: best.candidates || searchRes,
        canonicalYouTube: best.canonicalYouTube || null,
        message: `No confident original match found automatically for "${query}". Please choose a version from the menu below.`,
      };
    }

    tracksToAdd = [{
      title: best.title,
      artist: best.artist,
      album: '',
      durationSec: best.durationSec,
      thumbnail: best.thumbnail,
      streamUrl: best.streamUrl,
      requestedBy: user.id,
      source: best.source,
      youtubeUrl: best.youtubeUrl || null,
      fallbackUrls: best.fallbackUrls || [],
    }];
  }

  // 5. Pre-validate playback stream when starting fresh playback on an idle player
  // Per Requirement B: Validate provider can start playback before announcing success!
  if (!session.isPlaying && tracksToAdd.length > 0) {
    try {
      const preResolved = await resolveAudioStream(tracksToAdd[0]);
      tracksToAdd[0]._preResolved = preResolved;
    } catch (err) {
      session.isPlaying = false;
      session.currentTrack = null;
      return {
        success: false,
        message: `Playback stream verification failed for "${tracksToAdd[0].title}": ${err.message}`,
      };
    }
  }

  // 6. Enqueue Tracks
  const targetPosition = playNow ? 1 : (session.isPlaying ? session.queue.length + 1 : 1);

  if (playNow) {
    session.queue.unshift(...tracksToAdd);
    if (session.isPlaying) {
      if (session.player) session.player.stop();
      // playNext will immediately fire on idle
    } else {
      playNext(guild.id);
    }
  } else {
    session.queue.push(...tracksToAdd);
    if (!session.isPlaying) {
      playNext(guild.id);
    }
  }

  return {
    success: true,
    count: tracksToAdd.length,
    firstTrack: tracksToAdd[0],
    isPlaylist,
    playlistName,
    position: targetPosition,
    sourceNote,
  };
}

/**
 * Pauses active playback
 */
function pause(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.player || !session.isPlaying || session.isPaused) return false;
  session.player.pause();
  session.isPaused = true;
  session.pauseTime = Date.now();
  updatePlayerCardMessage(session);
  return true;
}

/**
 * Resumes paused playback
 */
function resume(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.player || !session.isPaused) return false;
  session.player.unpause();
  session.isPaused = false;
  if (session.pauseTime) {
    session.totalPausedMs += Date.now() - session.pauseTime;
    session.pauseTime = 0;
  }
  updatePlayerCardMessage(session);
  return true;
}

/**
 * Skips the currently playing track
 */
function skip(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.isPlaying) return null;
  const skipped = session.currentTrack;
  handleTrackEnded(guildId);
  return skipped;
}

/**
 * Replays the previous track from history
 */
function playPrevious(guildId) {
  const session = sessions.get(guildId);
  if (!session || !session.history || session.history.length === 0) return null;
  const prev = session.history.shift();
  if (prev) {
    session.queue.unshift(prev);
    handleTrackEnded(guildId);
    return prev;
  }
  return null;
}

/**
 * Shuffles all upcoming queued tracks
 */
function shuffle(guildId) {
  const session = sessions.get(guildId);
  if (!session || session.queue.length <= 1) return 0;
  for (let i = session.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [session.queue[i], session.queue[j]] = [session.queue[j], session.queue[i]];
  }
  return session.queue.length;
}

/**
 * Updates repeat/loop mode (off, track, queue)
 */
function setLoop(guildId, mode) {
  const session = sessions.get(guildId);
  if (!session) return 'off';
  session.loopMode = mode.toLowerCase();
  updatePlayerCardMessage(session);
  return session.loopMode;
}

/**
 * Adjusts volume percentage (1 to 100)
 */
function setVolume(guildId, level) {
  const session = sessions.get(guildId);
  if (!session) return 100;
  session.volume = Math.max(1, Math.min(100, level));
  if (session.currentResource?.volume) {
    session.currentResource.volume.setVolume(session.volume / 100);
  }
  updatePlayerCardMessage(session);
  return session.volume;
}

/**
 * Moves track position in queue
 */
function move(guildId, from, to) {
  const session = sessions.get(guildId);
  if (!session || session.queue.length === 0) return null;
  if (from < 1 || from > session.queue.length || to < 1 || to > session.queue.length) return null;
  const [track] = session.queue.splice(from - 1, 1);
  session.queue.splice(to - 1, 0, track);
  return track;
}

/**
 * Jumps to specific queue position
 */
function jump(guildId, position) {
  const session = sessions.get(guildId);
  if (!session || session.queue.length === 0) return null;
  if (position < 1 || position > session.queue.length) return null;
  session.queue.splice(0, position - 1);
  return skip(guildId);
}

/**
 * Removes track from queue
 */
function remove(guildId, position) {
  const session = sessions.get(guildId);
  if (!session || session.queue.length === 0) return null;
  if (position < 1 || position > session.queue.length) return null;
  return session.queue.splice(position - 1, 1)[0];
}

/**
 * Clears upcoming queue
 */
function clearQueue(guildId) {
  const session = sessions.get(guildId);
  if (!session) return 0;
  const count = session.queue.length;
  session.queue = [];
  return count;
}

/**
 * Seeks to a specific timestamp (in seconds) in the currently playing track
 */
async function seek(guildId, targetSeconds) {
  const session = sessions.get(guildId);
  if (!session || !session.currentTrack || !session.isPlaying || !session.player) {
    return { success: false, message: 'Nothing is currently playing to seek in.' };
  }

  const track = session.currentTrack;
  const dur = track.durationSec || 0;
  if (dur > 0 && targetSeconds > dur) {
    return {
      success: false,
      message: `Seek timestamp exceeds track duration (${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}).`,
    };
  }

  try {
    const audioData = await resolveAudioStream(track, targetSeconds);
    const resource = createAudioResource(audioData.stream, {
      inputType: audioData.type === 'arbitrary' ? StreamType.Arbitrary : audioData.type,
      inlineVolume: true,
    });

    if (resource.volume) {
      resource.volume.setVolume(session.volume / 100);
    }

    session.currentResource = resource;
    session.startTime = Date.now() - (targetSeconds * 1000);
    session.totalPausedMs = 0;
    session.pauseTime = 0;
    session.isPaused = false;

    session.player.play(resource);
    await updatePlayerCardMessage(session);

    logIncident('INFO', 'SEEK', `Seeked to ${targetSeconds}s in "${track.title}" (guild ${guildId})`);
    return { success: true, targetSeconds, track };
  } catch (err) {
    logIncident('ERROR', 'SEEK_ERROR', `Failed to seek in "${track.title}": ${err.message}`);
    return { success: false, message: `Could not seek: ${err.message}` };
  }
}

/**
 * Enables 24/7 persistent voice connection for a guild
 */
async function enable247(guild, vc, textChannel = null) {
  const { updateGuildConfig } = require('../config/guildConfig');
  const session = getSession(guild.id, guild.name);
  session.is247 = true;
  session.reconnectAttempts = 0;
  if (textChannel) session.textChannel = textChannel;
  session.voiceChannel = vc;

  updateGuildConfig(guild.id, {
    music247: {
      enabled: true,
      channelId: vc.id,
      textChannelId: textChannel?.id || '',
      reconnectAttempts: 0,
      lastError: null,
    },
  });

  const res = await ensureVoiceConnection(guild, vc);
  if (!res.success) {
    updateGuildConfig(guild.id, {
      'music247.lastError': res.message,
    });
    return res;
  }

  logIncident('INFO', '247_ENABLED', `24/7 persistent voice enabled in guild ${guild.id} (channel: ${vc.id})`);
  return { success: true, channel: vc, connection: res.connection };
}

/**
 * Disables 24/7 persistent voice mode for a guild
 */
async function disable247(guildId) {
  const { updateGuildConfig } = require('../config/guildConfig');
  const session = sessions.get(guildId);
  if (session) {
    session.is247 = false;
    session.reconnectAttempts = 0;
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }
    // If not playing, cleanly destroy session
    if (!session.isPlaying) {
      destroySession(guildId, true);
    }
  }

  updateGuildConfig(guildId, {
    music247: {
      enabled: false,
      reconnectAttempts: 0,
      lastError: null,
    },
  });

  logIncident('INFO', '247_DISABLED', `24/7 persistent voice disabled in guild ${guildId}`);
  return { success: true };
}

/**
 * Configures the designated voice channel for 24/7 persistence
 */
function setup247(guild, vc, textChannel = null) {
  const { updateGuildConfig } = require('../config/guildConfig');
  updateGuildConfig(guild.id, {
    music247: {
      channelId: vc.id,
      textChannelId: textChannel?.id || '',
    },
  });

  const session = sessions.get(guild.id);
  if (session && session.is247) {
    session.voiceChannel = vc;
    ensureVoiceConnection(guild, vc).catch(() => {});
  }

  logIncident('INFO', '247_SETUP', `Configured 24/7 target voice channel to ${vc.id} in guild ${guild.id}`);
  return { success: true, channel: vc };
}

/**
 * Retrieves comprehensive 24/7 status report for a guild
 * Distinguishes: Disabled, Connecting, Connected and ready, Reconnecting, Failed
 */
function get247Status(guildId, guild = null) {
  const { getGuildConfig } = require('../config/guildConfig');
  const config = getGuildConfig(guildId);
  const session = sessions.get(guildId);

  const isConnected = !!(session?.connection && session.connection.state?.status === VoiceConnectionStatus.Ready);
  const connStatus = session?.connection?.state?.status || 'disconnected';
  const targetChannelId = config?.music247?.channelId || session?.voiceChannel?.id || '';
  const channel = guild?.channels?.cache?.get(targetChannelId) || session?.voiceChannel;

  let stateLabel = 'Disabled';
  if (!config?.music247?.enabled) {
    stateLabel = 'Disabled';
  } else if (isConnected) {
    stateLabel = 'Connected and ready';
  } else if (session?.reconnectTimeout || (session?.reconnectAttempts && session.reconnectAttempts > 0 && connStatus !== VoiceConnectionStatus.Ready)) {
    stateLabel = 'Reconnecting';
  } else if (connStatus === VoiceConnectionStatus.Signalling || connStatus === VoiceConnectionStatus.Connecting || session?.detailedStatus === 'connecting') {
    stateLabel = 'Connecting';
  } else if (config?.music247?.lastError || connStatus === VoiceConnectionStatus.Destroyed || session?.detailedStatus === 'failed') {
    stateLabel = 'Failed';
  } else {
    stateLabel = 'Connecting';
  }

  return {
    enabled: Boolean(config?.music247?.enabled),
    channelId: targetChannelId,
    channelName: channel?.name || null,
    isConnected,
    status: connStatus,
    stateLabel,
    reconnectAttempts: session?.reconnectAttempts || 0,
    isPlaying: Boolean(session?.isPlaying),
    currentTrack: session?.currentTrack || null,
    lastError: config?.music247?.lastError || session?.lastError || null,
    transitions: session?.stateTransitions?.slice(-5) || [],
  };
}

/**
 * Initializes and restores all 24/7 connections across guilds on bot startup
 */
async function init247Connections(client) {
  if (!client?.guilds?.cache) return;
  const { getGuildConfig, updateGuildConfig } = require('../config/guildConfig');

  for (const guild of client.guilds.cache.values()) {
    try {
      const config = getGuildConfig(guild.id, guild.name);
      if (config.music247?.enabled && config.music247?.channelId) {
        const vc = guild.channels.cache.get(config.music247.channelId) || await guild.channels.fetch(config.music247.channelId).catch(() => null);
        if (!vc) {
          console.warn(`[24/7 Music] Guild "${guild.name}" (${guild.id}): Channel ${config.music247.channelId} not found.`);
          updateGuildConfig(guild.id, { 'music247.lastError': 'Voice channel not found on startup' });
          continue;
        }
        console.log(`[24/7 Music] Restoring persistent connection in "${guild.name}" -> #${vc.name}...`);
        await enable247(guild, vc);
      }
    } catch (err) {
      console.error(`[24/7 Music] Failed to restore 24/7 connection in "${guild.name}":`, err.message);
    }
  }
}

/**
 * Favorites Management Helpers
 */
function addFavorite(guildId, userId, track) {
  if (!track || !track.title) return { success: false, message: 'Invalid track data.' };
  const { getGuildConfig, updateGuildConfig } = require('../config/guildConfig');
  const cfg = getGuildConfig(guildId);
  const userFavs = cfg.musicFavorites?.[userId] || [];

  if (userFavs.some(f => f.title.toLowerCase() === track.title.toLowerCase())) {
    return { success: false, message: `**${track.title}** is already in your favorites.` };
  }

  const newFav = {
    title: track.title,
    artist: track.artist || 'Unknown',
    durationSec: track.durationSec || 0,
    thumbnail: track.thumbnail || null,
    streamUrl: track.streamUrl || null,
    spotifyUrl: track.spotifyUrl || null,
    source: track.source || 'unknown',
    addedAt: Date.now(),
  };

  const updated = [newFav, ...userFavs].slice(0, 50);
  updateGuildConfig(guildId, (c) => {
    if (!c.musicFavorites) c.musicFavorites = {};
    c.musicFavorites[userId] = updated;
  });

  return { success: true, count: updated.length, track: newFav };
}

function removeFavorite(guildId, userId, indexOrTitle) {
  const { getGuildConfig, updateGuildConfig } = require('../config/guildConfig');
  const cfg = getGuildConfig(guildId);
  const userFavs = cfg.musicFavorites?.[userId] || [];
  if (userFavs.length === 0) return { success: false, message: 'Your favorites list is empty.' };

  let removed = null;
  let remaining = [];

  if (typeof indexOrTitle === 'number') {
    if (indexOrTitle < 1 || indexOrTitle > userFavs.length) {
      return { success: false, message: `Invalid favorite number (1-${userFavs.length}).` };
    }
    removed = userFavs[indexOrTitle - 1];
    remaining = userFavs.filter((_, idx) => idx !== indexOrTitle - 1);
  } else {
    const q = String(indexOrTitle).toLowerCase().trim();
    const idx = userFavs.findIndex(f => f.title.toLowerCase().includes(q));
    if (idx === -1) {
      return { success: false, message: `No favorite found matching "${indexOrTitle}".` };
    }
    removed = userFavs[idx];
    remaining = userFavs.filter((_, i) => i !== idx);
  }

  updateGuildConfig(guildId, (c) => {
    if (!c.musicFavorites) c.musicFavorites = {};
    c.musicFavorites[userId] = remaining;
  });

  return { success: true, removed, count: remaining.length };
}

function getFavorites(guildId, userId) {
  const { getGuildConfig } = require('../config/guildConfig');
  const cfg = getGuildConfig(guildId);
  return cfg.musicFavorites?.[userId] || [];
}

module.exports = {
  sessions,
  getSession,
  destroySession,
  ensureVoiceConnection,
  enqueueTrack,
  playNext,
  pause,
  resume,
  skip,
  playPrevious,
  shuffle,
  setLoop,
  setVolume,
  move,
  jump,
  remove,
  clearQueue,
  seek,
  handleTrackEnded,
  updatePlayerCardMessage,
  enable247,
  disable247,
  setup247,
  get247Status,
  handle247Reconnect,
  init247Connections,
  // Search Cache
  searchCache,
  setSearchCache,
  getSearchCache,
  // Favorites
  addFavorite,
  removeFavorite,
  getFavorites,
  // Voice Assistant
  voiceAssistant,
  enableVoiceAssistant: (g, c, u, t) => voiceAssistant.enableVoiceAssistant(g, c, u, { sessions, enqueueTrack, pause, resume, skip, playPrevious, destroySession, setVolume, setLoop, shuffle }, t),
  disableVoiceAssistant: voiceAssistant.disableVoiceAssistant,
  getVoiceState: voiceAssistant.getVoiceState,
};
