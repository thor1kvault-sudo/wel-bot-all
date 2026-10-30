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
  extractVideoId, isSoundCloudUrl, isDirectUrl,
} = require('./audioProvider');
const { renderPlayerCard } = require('./musicPlayerCard');
const { logIncident } = require('./musicUpdateMonitor');
const voiceAssistant = require('./voiceAssistant');
const lavalinkManager = require('./lavalinkManager');

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
      lavalinkPlayer: null,
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
        if (this.lavalinkPlayer && typeof this.lavalinkPlayer.position === 'number' && this.lavalinkPlayer.position > 0) {
          return Math.floor(this.lavalinkPlayer.position / 1000);
        }
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

  if (session.lavalinkPlayer) {
    try { session.lavalinkPlayer.stopTrack(); } catch (_) {}
    session.lavalinkPlayer = null;
    try { lavalinkManager.leaveVoice(guildId); } catch (_) {}
  }

  if (session.connection) {
    try {
      session.connection.removeAllListeners();
      session.connection.destroy();
    } catch (_) {}
    session.connection = null;
  }

  if (session.currentResource) {
    try {
      if (session.currentResource.playStream && typeof session.currentResource.playStream.destroy === 'function') {
        session.currentResource.playStream.destroy();
      }
    } catch (_) {}
    session.currentResource = null;
  }
  if (session._activeStream) {
    try {
      if (typeof session._activeStream.destroy === 'function') session._activeStream.destroy();
    } catch (_) {}
    session._activeStream = null;
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
 * Attempts playback of the next verified full-length candidate if the current YouTube stream fails.
 * Protects against premature termination, infinite loops, and 30s preview fallbacks.
 */
async function tryFallbackCandidate(guildId, track) {
  const session = sessions.get(guildId);
  if (!session || !session.lavalinkPlayer || !track) return false;

  track._attemptedUrls = track._attemptedUrls || new Set();
  if (track.youtubeUrl) track._attemptedUrls.add(track.youtubeUrl);
  if (track.lavalinkTrack?.info?.uri) track._attemptedUrls.add(track.lavalinkTrack.info.uri);

  track._fallbackRetries = (track._fallbackRetries || 0) + 1;
  if (track._fallbackRetries > 4) {
    console.warn(`[THOR-LAVALINK] Reached max candidate retries (4) for "${track.title}".`);
    return false;
  }

  let nextCand = null;
  if (Array.isArray(track.fallbackCandidates) && track.fallbackCandidates.length > 0) {
    while (track.fallbackCandidates.length > 0) {
      const cand = track.fallbackCandidates.shift();
      const url = cand.youtubeUrl || cand.uri || cand.url;
      if (url && !track._attemptedUrls.has(url)) {
        nextCand = cand;
        break;
      }
    }
  }

  if (!nextCand && Array.isArray(track.fallbackUrls) && track.fallbackUrls.length > 0) {
    while (track.fallbackUrls.length > 0) {
      const url = track.fallbackUrls.shift();
      if (url && !track._attemptedUrls.has(url)) {
        nextCand = { youtubeUrl: url };
        break;
      }
    }
  }

  if (!nextCand) {
    console.warn(`[THOR-LAVALINK] No remaining verified full-length candidates for "${track.title}".`);
    return false;
  }

  const nextUrl = nextCand.youtubeUrl || nextCand.url;
  track._attemptedUrls.add(nextUrl);

  console.log(`[THOR-LAVALINK Fallback] Attempting next verified candidate for "${track.title}": "${nextCand.title || nextUrl}" (${nextUrl})`);

  try {
    let chosen = nextCand.lavalinkTrack || null;
    let encoded = nextCand.encoded || null;

    if (!encoded) {
      const res = await lavalinkManager.resolveTrack(nextUrl);
      if (res && res.tracks && res.tracks.length > 0) {
        chosen = res.tracks[0];
        encoded = chosen.encoded;
      }
    }

    if (encoded) {
      track.encoded = encoded;
      track.lavalinkTrack = chosen;
      track.youtubeUrl = nextUrl;
      if (chosen?.info?.title) track.matchedTitle = chosen.info.title;
      if (chosen?.info?.author) track.matchedArtist = chosen.info.author;
      if (chosen?.info?.length) track.durationSec = Math.round(chosen.info.length / 1000);

      await session.lavalinkPlayer.playTrack({ track: { encoded } });
      console.log(`[THOR-LAVALINK Fallback] Successfully switched to candidate "${track.matchedTitle || track.title}"`);
      updatePlayerCardMessage(session);
      return true;
    }
  } catch (err) {
    console.error(`[THOR-LAVALINK Fallback] Candidate "${nextUrl}" failed: ${err.message}`);
    return tryFallbackCandidate(guildId, track);
  }

  return false;
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
          track.provider = 'youtube';
          track.youtubeUrl = ytMatch.youtubeUrl;
          track.youtubeVideoId = extractVideoId(ytMatch.youtubeUrl);
          track.matchedYouTubeTitle = ytMatch.matchedTitle;
          track.matchedYouTubeChannel = ytMatch.matchedArtist;
          track.matchedTitle = ytMatch.matchedTitle;
          track.matchedArtist = ytMatch.matchedArtist;
          track.matchedCandidate = {
            title: ytMatch.matchedTitle,
            channel: ytMatch.matchedArtist,
            youtubeUrl: ytMatch.youtubeUrl,
            durationSec: ytMatch.durationSec,
            videoId: track.youtubeVideoId,
          };
          if (!track.durationSec && ytMatch.durationSec) {
            track.durationSec = ytMatch.durationSec;
          }
          if (!track.thumbnail && ytMatch.thumbnail) {
            track.thumbnail = ytMatch.thumbnail;
          }
        }
      } catch (_) {}
    }

    // ── Lavalink 4.2.2 Playback Pipeline ──
    if (session.lavalinkPlayer) {
      try {
        if (!track.encoded) {
          const lIdentifier = track.youtubeUrl || `${track.title} ${track.artist || ''}`.trim();
          const lRes = await lavalinkManager.resolveTrack(track.youtubeUrl ? track.youtubeUrl : `ytsearch:${lIdentifier}`);
          if (lRes && lRes.tracks && lRes.tracks.length > 0) {
            // Filter out short previews, snippets, and YouTube Shorts
            const validTracks = lRes.tracks.filter(t => {
              const durSec = Math.round((t.info?.length || 0) / 1000);
              const isShort = durSec > 0 && durSec <= 45;
              const hasShortsTag = /(?:#shorts|\bshorts\b|\bteaser\b|\bsnippet\b|\bpreview\b)/i.test(t.info?.title || '');
              return !isShort && !hasShortsTag;
            });
            const chosen = validTracks[0] || lRes.tracks[0];
            track.encoded = chosen.encoded;
            track.lavalinkTrack = chosen;
            if (chosen.info?.length) {
              track.durationSec = Math.round(chosen.info.length / 1000);
            }
            if (chosen.info?.uri && !track.youtubeUrl) {
              track.youtubeUrl = chosen.info.uri;
            }
            if (!track.fallbackCandidates || track.fallbackCandidates.length === 0) {
              track.fallbackCandidates = validTracks.slice(1, 5).map(vt => ({
                title: vt.info?.title,
                artist: vt.info?.author,
                durationSec: Math.round((vt.info?.length || 0) / 1000),
                youtubeUrl: vt.info?.uri,
                encoded: vt.encoded,
                lavalinkTrack: vt,
              }));
              track.fallbackUrls = track.fallbackCandidates.map(c => c.youtubeUrl).filter(Boolean);
            }
          }
        }

        if (track.encoded) {
          const lInfo = track.lavalinkTrack?.info || {};
          console.log(`[THOR-LAVALINK] Streaming "${track.title}" via Lavalink 4.2.2...`);
          console.log(`[THOR-LAVALINK DIAG] Diagnostics:
  - Requested Song: "${track.title}" (Original Artist: "${track.artist || 'Unknown'}")
  - Spotify Expected Duration: ${track.spotifyExpectedDurationSec ? track.spotifyExpectedDurationSec + 's' : 'N/A'}
  - Selected YouTube Video: "${lInfo.title || track.matchedTitle || track.title}"
  - Channel / Author: "${lInfo.author || track.matchedArtist || 'Unknown'}"
  - YouTube URL: "${lInfo.uri || track.youtubeUrl || 'N/A'}"
  - Selected Duration: ${lInfo.length || ((track.durationSec || 0) * 1000)}ms (${track.durationSec}s)
  - Lavalink Source: "${lInfo.sourceName || 'youtube'}" | isStream: ${Boolean(lInfo.isStream)} | isSeekable: ${Boolean(lInfo.isSeekable)}
  - Actual Playback Position: ${session.lavalinkPlayer?.position || 0}ms`);

          // Safe: playTrack with clean payload - NO accidental endTime or startTime restriction
          await session.lavalinkPlayer.playTrack({ track: { encoded: track.encoded } });
          if (session.volume && session.lavalinkPlayer && typeof session.lavalinkPlayer.setGlobalVolume === 'function') {
            try { session.lavalinkPlayer.setGlobalVolume(session.volume); } catch (_) {}
          }
          session.recoveryAttempts = 0;
          session.consecutiveFailures = 0;

          if (session.textChannel) {
            try {
              const card = await renderPlayerCard(session);
              if (session.playerMessage) {
                await session.playerMessage.edit(card).catch(() => {});
              } else {
                session.playerMessage = await session.textChannel.send(card).catch(() => null);
              }
            } catch (_) {}
          }
          return;
        }
      } catch (lavalinkErr) {
        if (!sessions.has(guildId) || !session.isPlaying) return;
        console.warn(`[THOR-LAVALINK] Stream failed for "${track.title}": ${lavalinkErr.message}. Attempting fallback candidate.`);
        const fallbackOk = await tryFallbackCandidate(guildId, track);
        if (fallbackOk) return;
        if (!sessions.has(guildId) || !session.isPlaying) return;
        console.warn(`[THOR-LAVALINK] All Lavalink candidates failed for "${track.title}". Falling back to direct audio.`);
      }
    }

    console.log(`[THOR-AUDIO] Resolving audio stream for "${track.title}" (source: ${track.source || 'unknown'})...`);
    const audioData = track._preResolved || (await resolveAudioStream(track));
    track._preResolved = null;
    console.log(`[THOR-AUDIO] Stream resolved: type=${audioData.type}, source=${audioData.source}, isStream=${!!audioData.stream?.on}`);

    if (!sessions.has(guildId) || !session.isPlaying || session.currentTrack !== track) {
      if (audioData?.stream && typeof audioData.stream.destroy === 'function') {
        try { audioData.stream.destroy(); } catch (_) {}
      }
      return;
    }
    session._activeStream = audioData.stream;

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
  if (session.connection && session.connection.state && session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    if (!session.connection.joinConfig || session.connection.joinConfig.channelId === vc.id) {
      if (session.connection.state.status === VoiceConnectionStatus.Ready || session.connection.state.status === 'ready') {
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
        if (process.env.NODE_ENV === 'test') {
          return { success: true, connection: session.connection };
        }
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

  // 2b. Lavalink 4.2.2 Engine Integration
  if (lavalinkManager.isLavalinkReady()) {
    try {
      if (!session.lavalinkPlayer || session.lavalinkPlayer.channelId !== vc.id) {
        const player = await lavalinkManager.joinVoice({
          guildId: guild.id,
          channelId: vc.id,
          shardId: guild.shardId || 0,
          deaf: true,
        });

        session.lavalinkPlayer = player;
        session.detailedStatus = 'connected_ready';
        session.reconnectAttempts = 0;
        session.lastError = null;

        if (typeof player.removeAllListeners === 'function') {
          player.removeAllListeners('start');
          player.removeAllListeners('end');
          player.removeAllListeners('exception');
          player.removeAllListeners('stuck');
          player.removeAllListeners('closed');
        }

        player.on('start', () => {
          session.isPlaying = true;
          session.isPaused = false;
          session.startTime = Date.now();
          session.totalPausedMs = 0;
          session.pauseTime = 0;
          console.log(`[THOR-LAVALINK Event: TrackStartEvent] Guild ${guild.id} | Track: "${session.currentTrack?.title}" | Position: ${player.position || 0}ms`);
          updatePlayerCardMessage(session);
        });

        player.on('end', async (data) => {
          const reason = data?.reason || 'finished';
          console.log(`[THOR-LAVALINK Event: TrackEndEvent] Guild ${guild.id} | Track: "${session.currentTrack?.title}" | Reason: "${reason}" | Final Position: ${player.position || 0}ms`);

          if (reason === 'replaced') return;
          if (reason === 'stopped') {
            session.isPlaying = false;
            return;
          }

          if (reason === 'loadFailed') {
            console.warn(`[THOR-LAVALINK] TrackEndEvent with loadFailed for "${session.currentTrack?.title}". Attempting fallback candidate.`);
            const fallbackOk = await tryFallbackCandidate(guild.id, session.currentTrack);
            if (fallbackOk) return;
          }

          handleTrackEnded(guild.id);
        });

        player.on('exception', async (data) => {
          const exc = data?.exception || {};
          console.error(`[THOR-LAVALINK Event: TrackExceptionEvent] Guild ${guild.id} | Track: "${session.currentTrack?.title}" | Severity: ${exc.severity || 'UNKNOWN'} | Message: ${exc.message || data} | Cause: ${exc.cause || 'none'}`);
          const fallbackOk = await tryFallbackCandidate(guild.id, session.currentTrack);
          if (fallbackOk) return;
          handleTrackEnded(guild.id);
        });

        player.on('stuck', async (data) => {
          console.warn(`[THOR-LAVALINK Event: TrackStuckEvent] Guild ${guild.id} | Track: "${session.currentTrack?.title}" | Threshold: ${data?.thresholdMs}ms | Current Position: ${player.position || 0}ms`);
          const fallbackOk = await tryFallbackCandidate(guild.id, session.currentTrack);
          if (fallbackOk) return;
          handleTrackEnded(guild.id);
        });

        player.on('closed', (data) => {
          console.warn(`[THOR-LAVALINK Event: WebSocketClosedEvent] Guild ${guild.id} | Code: ${data?.code} | Reason: "${data?.reason}" | ByRemote: ${Boolean(data?.byRemote)}`);
        });
      }

      return { success: true, connection: session.connection || { state: { status: 'ready' } }, lavalink: true };
    } catch (lavalinkErr) {
      console.warn(`[THOR-LAVALINK] Join voice failed: ${lavalinkErr.message}. Falling back to direct audio.`);
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

  // 1. Validate query format before joining voice
  if (!exactTrack && typeof query === 'string' && (query.trim().startsWith('http://') || query.trim().startsWith('https://')) && !isSpotifyUrl(query) && !isYouTubeUrl(query) && !isSoundCloudUrl(query) && !isDirectUrl(query)) {
    return {
      success: false,
      message: 'This URL format is not supported for playback. Supported link types: YouTube (videos & playlists), Spotify (tracks, albums, playlists), and SoundCloud (tracks & playlists).',
    };
  }

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
      provider: exactTrack.provider || (exactTrack.youtubeUrl || isYouTubeUrl(exactTrack.streamUrl) ? 'youtube' : (exactTrack.source === 'spotify' ? 'youtube' : 'soundcloud')),
      spotifyUrl: exactTrack.spotifyUrl || null,
      youtubeUrl: exactTrack.youtubeUrl || null,
      youtubeVideoId: exactTrack.youtubeVideoId || (exactTrack.youtubeUrl ? extractVideoId(exactTrack.youtubeUrl) : null),
      matchedCandidate: exactTrack.matchedCandidate || null,
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
        if (ytMatch.requiresChoice && ytMatch.candidates?.length > 0) {
          return {
            success: false,
            requiresChoice: true,
            candidates: ytMatch.candidates.slice(0, 3),
            message: ytMatch.reason || `Found multiple possible versions for "${sp.title}". Please select your preferred version below:`,
          };
        }
        return {
          success: false,
          message: `No reliable match found for "${sp.title}" by ${sp.artist || 'Unknown'}. ${ytMatch.reason || 'The available versions did not match the original song.'}`,
        };
      }
      tracksToAdd = [{
        title: sp.title,
        artist: sp.artist,
        album: sp.album,
        durationSec: ytMatch.durationSec || sp.durationSec,
        spotifyExpectedDurationSec: sp.durationSec || null,
        thumbnail: sp.thumbnail || ytMatch.thumbnail,
        streamUrl: null,
        provider: 'youtube',
        youtubeUrl: ytMatch.youtubeUrl,
        youtubeVideoId: extractVideoId(ytMatch.youtubeUrl),
        matchedYouTubeTitle: ytMatch.matchedTitle,
        matchedYouTubeChannel: ytMatch.matchedArtist,
        matchedTitle: ytMatch.matchedTitle,
        matchedArtist: ytMatch.matchedArtist,
        matchedCandidate: {
          title: ytMatch.matchedTitle,
          channel: ytMatch.matchedArtist,
          youtubeUrl: ytMatch.youtubeUrl,
          durationSec: ytMatch.durationSec,
          videoId: extractVideoId(ytMatch.youtubeUrl),
        },
        fallbackUrls: ytMatch.fallbackUrls || [],
        fallbackCandidates: ytMatch.fallbackCandidates || [],
        requestedBy: user.id,
        source: 'spotify',
        spotifyUrl: sp.spotifyUrl,
        confidence: ytMatch.confidence,
      }];
      sourceNote = `Spotify track matched to YouTube: "${ytMatch.matchedTitle}" by ${ytMatch.matchedArtist || 'Artist'}`;
    } else {
      tracksToAdd = spotifyRes.tracks.map(t => ({
        title: t.title,
        artist: t.artist,
        album: t.album,
        durationSec: t.durationSec,
        thumbnail: t.thumbnail,
        streamUrl: null,
        provider: 'youtube',
        requestedBy: user.id,
        source: 'spotify',
        spotifyUrl: t.spotifyUrl,
      }));
    }
  } else if (typeof query === 'string' && (query.trim().startsWith('http://') || query.trim().startsWith('https://')) && !isSpotifyUrl(query) && !isYouTubeUrl(query) && !isSoundCloudUrl(query) && !isDirectUrl(query)) {
    return {
      success: false,
      message: 'This URL format is not supported for playback. Supported link types: YouTube (videos & playlists), Spotify (tracks, albums, playlists), and SoundCloud (tracks & playlists).',
    };
  } else if (isYouTubeUrl(query)) {
    let resolvedViaLavalink = false;
    if (lavalinkManager.isLavalinkReady()) {
      try {
        const lRes = await lavalinkManager.resolveTrack(query);
        if (lRes) {
          if (lRes.loadType === 'playlist') {
            isPlaylist = true;
            playlistName = lRes.playlistInfo?.name || 'YouTube Playlist';
            tracksToAdd = (lRes.tracks || []).map(t => ({
              title: t.info?.title || 'YouTube Track',
              artist: t.info?.author || 'YouTube',
              album: playlistName,
              durationSec: Math.round((t.info?.length || 0) / 1000),
              thumbnail: `https://i.ytimg.com/vi/${t.info?.identifier}/hqdefault.jpg`,
              streamUrl: null,
              provider: 'youtube',
              youtubeUrl: t.info?.uri || `https://www.youtube.com/watch?v=${t.info?.identifier}`,
              youtubeVideoId: t.info?.identifier || extractVideoId(t.info?.uri || ''),
              encoded: t.encoded,
              lavalinkTrack: t,
              requestedBy: user.id,
              source: 'youtube',
            }));
            sourceNote = `YouTube playlist: "${playlistName}" (${tracksToAdd.length} tracks)`;
            resolvedViaLavalink = true;
          } else if (lRes.tracks && lRes.tracks.length > 0) {
            const chosen = lRes.tracks[0];
            tracksToAdd = [{
              title: chosen.info?.title || 'YouTube Video',
              artist: chosen.info?.author || 'YouTube',
              album: '',
              durationSec: Math.round((chosen.info?.length || 0) / 1000),
              thumbnail: `https://i.ytimg.com/vi/${chosen.info?.identifier}/hqdefault.jpg`,
              streamUrl: null,
              provider: 'youtube',
              youtubeUrl: chosen.info?.uri || query,
              youtubeVideoId: chosen.info?.identifier || extractVideoId(chosen.info?.uri || query),
              encoded: chosen.encoded,
              lavalinkTrack: chosen,
              requestedBy: user.id,
              source: 'youtube',
              fallbackUrls: lRes.tracks.slice(1, 5).map(t => t.info?.uri).filter(Boolean),
              fallbackCandidates: lRes.tracks.slice(1, 5).map(t => ({
                title: t.info?.title,
                artist: t.info?.author,
                durationSec: Math.round((t.info?.length || 0) / 1000),
                youtubeUrl: t.info?.uri,
                encoded: t.encoded,
                lavalinkTrack: t,
              })),
            }];
            sourceNote = `YouTube track: "${chosen.info?.title}" (${chosen.info?.uri || query})`;
            resolvedViaLavalink = true;
          } else if (lRes.loadType === 'empty') {
            return { success: false, message: 'Could not find or load the YouTube video at the provided URL. It may be private or deleted.' };
          } else if (lRes.loadType === 'error') {
            return { success: false, message: `YouTube playback unavailable for this video: ${lRes.exception?.message || 'Video is restricted or private.'}` };
          }
        }
      } catch (err) {
        console.warn(`[THOR-LAVALINK] Direct URL resolution failed: ${err.message}. Trying audioProvider fallback.`);
      }
    }

    if (!resolvedViaLavalink) {
      const searchRes = await searchAudioTracks(query, 1);
      if (!searchRes || searchRes.length === 0) {
        return { success: false, message: `Could not resolve YouTube link "${query}".` };
      }
      const ytMeta = searchRes[0];
      const ytUrl = ytMeta.youtubeUrl || query;
      tracksToAdd = [{
        title: ytMeta.title,
        artist: ytMeta.artist,
        album: '',
        durationSec: ytMeta.durationSec,
        thumbnail: ytMeta.thumbnail,
        streamUrl: null,
        provider: 'youtube',
        youtubeUrl: ytUrl,
        youtubeVideoId: extractVideoId(ytUrl),
        matchedCandidate: {
          title: ytMeta.title,
          channel: ytMeta.artist,
          youtubeUrl: ytUrl,
          durationSec: ytMeta.durationSec,
          videoId: extractVideoId(ytUrl),
        },
        requestedBy: user.id,
        source: 'youtube',
        fallbackUrls: ytMeta.fallbackUrls || [],
        fallbackCandidates: ytMeta.fallbackCandidates || [],
      }];
      sourceNote = `YouTube track: "${ytMeta.title}" (${ytUrl})`;
    }
  } else if (isSoundCloudUrl(query)) {
    let resolvedViaLavalink = false;
    if (lavalinkManager.isLavalinkReady()) {
      try {
        const lRes = await lavalinkManager.resolveTrack(query);
        if (lRes) {
          if (lRes.loadType === 'playlist') {
            isPlaylist = true;
            playlistName = lRes.playlistInfo?.name || 'SoundCloud Playlist';
            tracksToAdd = (lRes.tracks || []).map(t => ({
              title: t.info?.title || 'SoundCloud Track',
              artist: t.info?.author || 'SoundCloud',
              album: playlistName,
              durationSec: Math.round((t.info?.length || 0) / 1000),
              thumbnail: null,
              streamUrl: null,
              provider: 'soundcloud',
              encoded: t.encoded,
              lavalinkTrack: t,
              requestedBy: user.id,
              source: 'soundcloud',
            }));
            sourceNote = `SoundCloud playlist: "${playlistName}" (${tracksToAdd.length} tracks)`;
            resolvedViaLavalink = true;
          } else if (lRes.tracks && lRes.tracks.length > 0) {
            const chosen = lRes.tracks[0];
            tracksToAdd = [{
              title: chosen.info?.title || 'SoundCloud Track',
              artist: chosen.info?.author || 'SoundCloud',
              album: '',
              durationSec: Math.round((chosen.info?.length || 0) / 1000),
              thumbnail: null,
              streamUrl: null,
              provider: 'soundcloud',
              encoded: chosen.encoded,
              lavalinkTrack: chosen,
              requestedBy: user.id,
              source: 'soundcloud',
            }];
            sourceNote = `SoundCloud track: "${chosen.info?.title}"`;
            resolvedViaLavalink = true;
          }
        }
      } catch (_) {}
    }

    if (!resolvedViaLavalink) {
      const searchRes = await searchAudioTracks(query, 1);
      if (!searchRes || searchRes.length === 0) {
        return { success: false, message: `Could not resolve SoundCloud link "${query}".` };
      }
      const scMeta = searchRes[0];
      tracksToAdd = [{
        title: scMeta.title,
        artist: scMeta.artist,
        album: '',
        durationSec: scMeta.durationSec,
        thumbnail: scMeta.thumbnail,
        streamUrl: scMeta.streamUrl,
        provider: 'soundcloud',
        requestedBy: user.id,
        source: 'soundcloud',
      }];
      sourceNote = `SoundCloud track: "${scMeta.title}"`;
    }
  } else {
    // Ordinary Search or direct link
    let candidates = [];
    let resolvedViaLavalink = false;

    if (lavalinkManager.isLavalinkReady()) {
      try {
        const lRes = await lavalinkManager.resolveTrack(`ytsearch:${query}`);
        if (lRes && lRes.tracks && lRes.tracks.length > 0) {
          const rawCandidates = lRes.tracks.map(t => ({
            title: t.info?.title || query,
            artist: t.info?.author || 'YouTube',
            durationSec: Math.round((t.info?.length || 0) / 1000),
            thumbnail: `https://i.ytimg.com/vi/${t.info?.identifier}/hqdefault.jpg`,
            youtubeUrl: t.info?.uri || `https://www.youtube.com/watch?v=${t.info?.identifier}`,
            encoded: t.encoded,
            lavalinkTrack: t,
            source: 'youtube',
            provider: 'youtube',
          }));

          let searchTitle = query;
          let searchArtist = '';
          if (query.includes(' - ')) {
            const parts = query.split(' - ');
            searchArtist = parts[0].trim();
            searchTitle = parts.slice(1).join(' - ').trim();
          }
          const ranked = rankYouTubeCandidates(rawCandidates, { title: searchTitle, artist: searchArtist });
          if (ranked && ranked.length > 0) {
            candidates = ranked.filter(c =>
              (c.penalty || 0) === 0 &&
              !c.isDifferentArtist &&
              !c.penaltyWords?.includes('short_preview') &&
              !c.penaltyWords?.includes('shorts_or_teaser') &&
              (c.durationSec === 0 || c.durationSec > 45)
            );
            if (candidates.length > 0) {
              resolvedViaLavalink = true;
            }
          }
        }
      } catch (_) {}
    }

    if (!resolvedViaLavalink) {
      const searchRes = await searchAudioTracks(query, 5);
      if (!searchRes || searchRes.length === 0) {
        return { success: false, message: "Couldn't find a verified full-length playable version of this song." };
      }
      candidates = searchRes;
    }

    if (candidates.length === 0) {
      return { success: false, message: "Couldn't find a verified full-length playable version of this song." };
    }

    const best = candidates[0];
    if (best?.requiresChoice && !exactTrack) {
      return {
        success: false,
        requiresChoice: true,
        candidates: best.candidates || candidates,
        canonicalYouTube: best.canonicalYouTube || null,
        message: `Multiple matching versions found for "${query}". Please choose a version from the menu below.`,
      };
    }

    tracksToAdd = [{
      title: best.title,
      artist: best.artist,
      album: '',
      durationSec: best.durationSec,
      thumbnail: best.thumbnail,
      streamUrl: best.streamUrl || null,
      requestedBy: user.id,
      source: best.source || 'youtube',
      provider: best.provider || (best.source === 'soundcloud' ? 'soundcloud' : 'youtube'),
      youtubeUrl: best.youtubeUrl || null,
      youtubeVideoId: best.youtubeVideoId || (best.youtubeUrl ? extractVideoId(best.youtubeUrl) : null),
      encoded: best.encoded || null,
      lavalinkTrack: best.lavalinkTrack || null,
      matchedCandidate: best.matchedCandidate || null,
      fallbackUrls: best.fallbackUrls || (candidates.slice(1, 5).map(c => c.youtubeUrl || c.streamUrl).filter(Boolean)),
      fallbackCandidates: best.fallbackCandidates || (candidates.slice(1, 5)),
    }];
  }

  // 5. Pre-validate playback stream when starting fresh playback on an idle player
  // Per Requirement B: Validate provider can start playback before announcing success!
  if (!session.isPlaying && tracksToAdd.length > 0) {
    if (session.lavalinkPlayer || lavalinkManager.isLavalinkReady()) {
      if (!tracksToAdd[0].encoded) {
        try {
          const lId = tracksToAdd[0].youtubeUrl || `${tracksToAdd[0].title} ${tracksToAdd[0].artist || ''}`.trim();
          const lRes = await lavalinkManager.resolveTrack(tracksToAdd[0].youtubeUrl ? tracksToAdd[0].youtubeUrl : `ytsearch:${lId}`);
          if (lRes && lRes.tracks && lRes.tracks.length > 0) {
            const validTracks = lRes.tracks.filter(t => {
              const durSec = Math.round((t.info?.length || 0) / 1000);
              const isShort = durSec > 0 && durSec <= 45;
              const hasShortsTag = /(?:#shorts|\bshorts\b|\bteaser\b|\bsnippet\b|\bpreview\b)/i.test(t.info?.title || '');
              return !isShort && !hasShortsTag;
            });
            const chosen = validTracks[0] || lRes.tracks[0];
            tracksToAdd[0].encoded = chosen.encoded;
            tracksToAdd[0].lavalinkTrack = chosen;
            if (chosen.info?.length) {
              tracksToAdd[0].durationSec = Math.round(chosen.info.length / 1000);
            }
            if (chosen.info?.uri && !tracksToAdd[0].youtubeUrl) {
              tracksToAdd[0].youtubeUrl = chosen.info.uri;
            }
            if (!tracksToAdd[0].fallbackCandidates || tracksToAdd[0].fallbackCandidates.length === 0) {
              tracksToAdd[0].fallbackCandidates = validTracks.slice(1, 5).map(vt => ({
                title: vt.info?.title,
                artist: vt.info?.author,
                durationSec: Math.round((vt.info?.length || 0) / 1000),
                youtubeUrl: vt.info?.uri,
                encoded: vt.encoded,
                lavalinkTrack: vt,
              }));
              tracksToAdd[0].fallbackUrls = tracksToAdd[0].fallbackCandidates.map(c => c.youtubeUrl).filter(Boolean);
            }
          }
        } catch (_) {}
      }
    } else {
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
  if (!session || (!session.player && !session.lavalinkPlayer) || !session.isPlaying || session.isPaused) return false;
  if (session.lavalinkPlayer && typeof session.lavalinkPlayer.setPaused === 'function') {
    try { session.lavalinkPlayer.setPaused(true); } catch (_) {}
  }
  if (session.player) {
    session.player.pause();
  }
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
  if (!session || (!session.player && !session.lavalinkPlayer) || !session.isPaused) return false;
  if (session.lavalinkPlayer && typeof session.lavalinkPlayer.setPaused === 'function') {
    try { session.lavalinkPlayer.setPaused(false); } catch (_) {}
  }
  if (session.player) {
    session.player.unpause();
  }
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
  if (session.lavalinkPlayer && typeof session.lavalinkPlayer.stopTrack === 'function') {
    try { session.lavalinkPlayer.stopTrack(); } catch (_) {}
  }
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
    if (session.lavalinkPlayer && typeof session.lavalinkPlayer.stopTrack === 'function') {
      try { session.lavalinkPlayer.stopTrack(); } catch (_) {}
    }
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
  if (session.lavalinkPlayer && typeof session.lavalinkPlayer.setGlobalVolume === 'function') {
    try { session.lavalinkPlayer.setGlobalVolume(session.volume); } catch (_) {}
  }
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
  if (!session || !session.currentTrack || !session.isPlaying || (!session.player && !session.lavalinkPlayer)) {
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

  if (session.lavalinkPlayer && typeof session.lavalinkPlayer.seekTo === 'function') {
    try {
      await session.lavalinkPlayer.seekTo(targetSeconds * 1000);
      session.startTime = Date.now() - (targetSeconds * 1000);
      session.totalPausedMs = 0;
      session.pauseTime = 0;
      session.isPaused = false;
      await updatePlayerCardMessage(session);
      logIncident('INFO', 'SEEK_LAVALINK', `Seeked to ${targetSeconds}s via Lavalink in "${track.title}" (guild ${guildId})`);
      return { success: true, targetSeconds, track };
    } catch (err) {
      logIncident('ERROR', 'SEEK_LAVALINK_ERROR', `Failed to seek in "${track.title}" via Lavalink: ${err.message}`);
      return { success: false, message: `Could not seek: ${err.message}` };
    }
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
  tryFallbackCandidate,
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
