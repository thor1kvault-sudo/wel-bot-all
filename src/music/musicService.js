const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { PermissionsBitField } = require('discord.js');

const { isSpotifyUrl, resolveSpotify } = require('./spotifyResolver');
const { searchAudioTracks, matchPlayableTrack, resolveAudioStream, ensureClientReady } = require('./audioProvider');
const { renderPlayerCard } = require('./musicPlayerCard');
const { logIncident } = require('./musicUpdateMonitor');

// Multi-guild isolated playback sessions
const sessions = new Map();

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
 */
function destroySession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;

  session.isPlaying = false;
  session.isPaused = false;
  session.queue = [];
  session.history = [];
  session.currentTrack = null;

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

  const track = session.queue.shift();
  session.currentTrack = track;
  session.isPlaying = true;
  session.isPaused = false;
  session.startTime = Date.now();
  session.totalPausedMs = 0;
  session.pauseTime = 0;

  try {
    const audioData = await resolveAudioStream(track);
    const resource = createAudioResource(audioData.stream, {
      inputType: audioData.type === 'arbitrary' ? StreamType.Arbitrary : audioData.type,
      inlineVolume: true,
    });

    if (resource.volume) {
      resource.volume.setVolume(session.volume / 100);
    }

    session.currentResource = resource;
    session.recoveryAttempts = 0;
    session.player.play(resource);

    // Update or post player card
    await updatePlayerCardMessage(session);
    logIncident('INFO', 'PLAY_START', `Started playback of "${track.title}" in guild ${guildId}`);
  } catch (err) {
    logIncident('ERROR', 'PLAY_FAIL', `Playback error on "${track.title}": ${err.message}`);
    // Auto-skip unplayable track to keep queue alive
    if (session.textChannel && typeof session.textChannel.send === 'function') {
      session.textChannel.send(`⚠️ Could not stream **${track.title}**: ${err.message}. Skipping to next track...`).catch(() => {});
    }
    handleTrackEnded(guildId);
  }
}

/**
 * Resolves queries and adds tracks to the guild queue.
 * Automatically handles Spotify links (tracks, albums, playlists) and normal text queries.
 */
async function enqueueTrack(guild, vc, user, textChannel, query, { playNow = false } = {}) {
  const session = getSession(guild.id, guild.name);
  session.textChannel = textChannel;
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

  // 2. Establish Voice Connection with State Safety
  if (!session.connection || session.connection.state.status === VoiceConnectionStatus.Destroyed) {
    try {
      session.connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      // Monitor Voice Connection Lifecycle
      session.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(session.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(session.connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch (_) {
          logIncident('WARN', 'VOICE_DISCONNECT', `Voice disconnected unexpectedly in guild ${guild.id}`);
          destroySession(guild.id);
        }
      });

      session.connection.on(VoiceConnectionStatus.Destroyed, () => {
        sessions.delete(guild.id);
      });
    } catch (err) {
      logIncident('ERROR', 'VOICE_CONNECT_ERR', err.message);
      return { success: false, message: `Could not join voice channel: ${err.message}` };
    }
  }

  // 3. Initialize Audio Player and Lifecycle Handlers
  if (!session.player) {
    session.player = createAudioPlayer();
    session.connection.subscribe(session.player);

    session.player.on(AudioPlayerStatus.Idle, () => {
      handleTrackEnded(guild.id);
    });

    session.player.on('error', (err) => {
      logIncident('ERROR', 'PLAYER_ERROR', err.message);
      handleTrackEnded(guild.id);
    });
  }

  // 4. Resolve Tracks from Query (Spotify vs Native Provider)
  let tracksToAdd = [];
  let isPlaylist = false;
  let playlistName = null;

  if (isSpotifyUrl(query)) {
    const spotifyRes = await resolveSpotify(query, 50);
    if (!spotifyRes || !spotifyRes.tracks || spotifyRes.tracks.length === 0) {
      return { success: false, message: 'Could not resolve any playable metadata for the provided Spotify link.' };
    }

    isPlaylist = spotifyRes.type === 'album' || spotifyRes.type === 'playlist';
    playlistName = spotifyRes.name;

    tracksToAdd = spotifyRes.tracks.map(t => ({
      title: t.title,
      artist: t.artist,
      album: t.album,
      durationSec: t.durationSec,
      thumbnail: t.thumbnail,
      streamUrl: null, // Matched on-demand before streaming
      requestedBy: user.id,
      source: 'spotify',
      spotifyUrl: t.spotifyUrl,
    }));
  } else {
    // Ordinary Search or direct link
    const searchRes = await searchAudioTracks(query, 1);
    if (!searchRes || searchRes.length === 0) {
      return { success: false, message: `No playable recordings found for "${query}".` };
    }

    const best = searchRes[0];
    tracksToAdd = [{
      title: best.title,
      artist: best.artist,
      album: '',
      durationSec: best.durationSec,
      thumbnail: best.thumbnail,
      streamUrl: best.streamUrl,
      requestedBy: user.id,
      source: best.source,
    }];
  }

  // 5. Enqueue Tracks
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
    position: playNow ? 1 : session.queue.length - tracksToAdd.length + 1,
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

module.exports = {
  sessions,
  getSession,
  destroySession,
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
};
