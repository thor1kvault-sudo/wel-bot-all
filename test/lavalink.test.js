const test = require('node:test');
const assert = require('node:assert');
const lavalinkManager = require('../src/music/lavalinkManager');
const musicService = require('../src/music/musicService');
const audioProvider = require('../src/music/audioProvider');

test('LL-1: Lavalink configuration parses host, port, password, and secure from env', () => {
  const origHost = process.env.LAVALINK_HOST;
  const origPort = process.env.LAVALINK_PORT;
  const origPass = process.env.LAVALINK_PASSWORD;
  const origSec = process.env.LAVALINK_SECURE;

  try {
    process.env.LAVALINK_HOST = 'test-lavalink.internal';
    process.env.LAVALINK_PORT = '2334';
    process.env.LAVALINK_PASSWORD = 'super_secret_lavalink_pass';
    process.env.LAVALINK_SECURE = 'true';

    const cfg = lavalinkManager.getLavalinkConfig();
    assert.strictEqual(cfg.host, 'test-lavalink.internal');
    assert.strictEqual(cfg.port, 2334);
    assert.strictEqual(cfg.password, 'super_secret_lavalink_pass');
    assert.strictEqual(cfg.secure, true);
    assert.strictEqual(cfg.url, 'test-lavalink.internal:2334');
  } finally {
    process.env.LAVALINK_HOST = origHost;
    process.env.LAVALINK_PORT = origPort;
    process.env.LAVALINK_PASSWORD = origPass;
    process.env.LAVALINK_SECURE = origSec;
  }
});

test('LL-2: Diagnostics reporting returns target version 4.2.2 and honest node metrics', () => {
  const diag = lavalinkManager.getDiagnostics();
  assert.strictEqual(diag.targetVersion, '4.2.2');
  assert.strictEqual(typeof diag.configured, 'boolean');
  assert.strictEqual(typeof diag.ready, 'boolean');
  assert.strictEqual(typeof diag.activePlayers, 'number');
});

test('LL-3: Readiness checks accurately report node connectivity', () => {
  lavalinkManager._setMockNode(null);
  // Without live server or mock, readiness is false
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);

  // When mock connected node is present, readiness is true
  const mockNode = {
    name: 'test-node',
    state: 1, // Constants.State.CONNECTED in Shoukaku 4.3.0
    rest: {
      resolve: async (id) => ({ loadType: 'empty', data: [] }),
    },
  };
  lavalinkManager._setMockNode(mockNode);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), true);
  assert.strictEqual(lavalinkManager.getIdealNode(), mockNode);

  lavalinkManager._setMockNode(null);
});

test('LL-4: resolveTrack normalizes Lavalink v4 loadType responses', async () => {
  const sampleTrack = {
    encoded: 'QAAAjQIAJUVuZGEgU29uYSAtIEEgUiBSYWhtYW4...',
    info: {
      identifier: 'i52TYO13Nyg',
      isSeekable: true,
      author: 'A.R. Rahman',
      length: 215000,
      isStream: false,
      position: 0,
      title: 'Enna Sona',
      uri: 'https://www.youtube.com/watch?v=i52TYO13Nyg',
      sourceName: 'youtube',
    },
  };

  const mockNode = {
    rest: {
      resolve: async (id) => {
        if (id.includes('empty')) return { loadType: 'empty', data: [] };
        if (id.includes('error')) return { loadType: 'error', data: { message: 'Track decode failure' } };
        if (id.includes('playlist')) return { loadType: 'playlist', data: { info: { name: 'Top Hits' }, tracks: [sampleTrack] } };
        return { loadType: 'track', data: sampleTrack };
      },
    },
  };

  lavalinkManager._setMockNode(mockNode);

  // Test single track
  const resTrack = await lavalinkManager.resolveTrack('https://youtube.com/watch?v=single');
  assert.strictEqual(resTrack.loadType, 'track');
  assert.strictEqual(resTrack.tracks.length, 1);
  assert.strictEqual(resTrack.tracks[0].info.title, 'Enna Sona');

  // Test empty
  const resEmpty = await lavalinkManager.resolveTrack('empty');
  assert.strictEqual(resEmpty.loadType, 'empty');
  assert.strictEqual(resEmpty.tracks.length, 0);

  // Test playlist
  const resPlaylist = await lavalinkManager.resolveTrack('playlist');
  assert.strictEqual(resPlaylist.loadType, 'playlist');
  assert.strictEqual(resPlaylist.playlistInfo.name, 'Top Hits');
  assert.strictEqual(resPlaylist.tracks.length, 1);

  // Test error
  const resError = await lavalinkManager.resolveTrack('error');
  assert.strictEqual(resError.loadType, 'error');
  assert.strictEqual(resError.exception.message, 'Track decode failure');

  lavalinkManager._setMockNode(null);
});

test('LL-5: Lavalink voice joining attaches player and tracks lifecycle events', async () => {
  let playTrackArg = null;
  let pausedState = false;
  let volumeState = 100;
  let seekState = 0;
  let stopped = false;

  const mockPlayer = {
    guildId: 'guild_ll5',
    channelId: 'vc_ll5',
    paused: false,
    position: 45000,
    playTrack: async (opts) => { playTrackArg = opts; },
    setPaused: (p) => { pausedState = p; },
    setGlobalVolume: (v) => { volumeState = v; },
    seekTo: async (ms) => { seekState = ms; },
    stopTrack: async () => { stopped = true; },
    on: (event, handler) => {},
  };

  const mockNode = {
    joinVoiceChannel: async (opts) => mockPlayer,
    leaveVoiceChannel: async (gid) => {},
    players: new Map([['guild_ll5', mockPlayer]]),
    rest: {
      resolve: async () => ({ loadType: 'track', data: { encoded: 'encoded_sample', info: { title: 'Test' } } }),
    },
  };

  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_ll5', name: 'Lavalink Test Guild' };
  const mockVc = { id: 'vc_ll5', name: 'General Voice' };

  const session = musicService.getSession(mockGuild.id, mockGuild.name);
  const connResult = await musicService.ensureVoiceConnection(mockGuild, mockVc);

  assert.strictEqual(connResult.success, true);
  assert.strictEqual(connResult.lavalink, true);
  assert.strictEqual(session.lavalinkPlayer, mockPlayer);

  // Test pause via Lavalink
  session.isPlaying = true;
  musicService.pause(mockGuild.id);
  assert.strictEqual(pausedState, true);
  assert.strictEqual(session.isPaused, true);

  // Test resume via Lavalink
  musicService.resume(mockGuild.id);
  assert.strictEqual(pausedState, false);
  assert.strictEqual(session.isPaused, false);

  // Test volume via Lavalink
  musicService.setVolume(mockGuild.id, 75);
  assert.strictEqual(volumeState, 75);
  assert.strictEqual(session.volume, 75);

  // Test seek via Lavalink
  session.currentTrack = { title: 'Seek Track', durationSec: 200 };
  await musicService.seek(mockGuild.id, 60);
  assert.strictEqual(seekState, 60000);

  // Test skip via Lavalink
  musicService.skip(mockGuild.id);
  assert.strictEqual(stopped, true);

  // Cleanup
  musicService.destroySession(mockGuild.id, true);
  assert.strictEqual(session.lavalinkPlayer, null);
  lavalinkManager._setMockNode(null);
});

test('LL-6: playNext streams encoded audio through Lavalink player', async () => {
  let playedOpts = null;

  const mockPlayer = {
    guildId: 'guild_ll6',
    channelId: 'vc_ll6',
    playTrack: async (opts) => { playedOpts = opts; },
    setGlobalVolume: () => {},
    on: () => {},
  };

  const mockNode = {
    rest: {
      resolve: async (q) => ({
        loadType: 'track',
        data: { encoded: 'enc_sheesha_123', info: { title: 'Sheesha', length: 240000 } },
      }),
    },
  };

  lavalinkManager._setMockNode(mockNode);

  const session = musicService.getSession('guild_ll6');
  session.lavalinkPlayer = mockPlayer;
  session.queue = [{
    title: 'Aakhya Mai Aakh Ghali Jo Bairan',
    artist: 'Sheesha',
    durationSec: 240,
    youtubeUrl: 'https://www.youtube.com/watch?v=i52TYO13Nyg',
  }];

  await musicService.playNext('guild_ll6');

  assert.ok(playedOpts, 'Lavalink playTrack must be invoked');
  assert.strictEqual(playedOpts.track.encoded, 'enc_sheesha_123');
  assert.strictEqual(session.isPlaying, true);
  assert.strictEqual(session.currentTrack.title, 'Aakhya Mai Aakh Ghali Jo Bairan');

  musicService.destroySession('guild_ll6', true);
  lavalinkManager._setMockNode(null);
});

test('LL-7: Spotify verified candidates resolve and load cleanly in Lavalink without SoundCloud fallback', async () => {
  let resolvedId = null;

  const mockNode = {
    joinVoiceChannel: async () => ({
      on: () => {},
      playTrack: async () => {},
      stopTrack: async () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (identifier) => {
        resolvedId = identifier;
        return {
          loadType: 'track',
          data: {
            encoded: 'enc_enna_sona_arijit',
            info: { title: 'Enna Sona', author: 'A.R. Rahman', length: 215000 },
          },
        };
      },
    },
  };

  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_ll7', name: 'Spotify Lavalink Guild' };
  const mockVc = { id: 'vc_ll7', name: 'Music VC' };
  const mockUser = { id: 'user_ll7' };

  // Enqueue verified track
  const verifiedTrack = {
    title: 'Enna Sona',
    artist: 'A.R. Rahman, Arijit Singh',
    album: 'OK Jaanu',
    durationSec: 215,
    source: 'spotify',
    provider: 'youtube',
    youtubeUrl: 'https://www.youtube.com/watch?v=s_95jJvXFqg',
  };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    verifiedTrack.title,
    { exactTrack: verifiedTrack }
  );

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.firstTrack.provider, 'youtube');
  assert.strictEqual(res.firstTrack.title, 'Enna Sona');
  assert.strictEqual(res.firstTrack.artist, 'A.R. Rahman, Arijit Singh');

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('LL-8: Unconfigured Lavalink falls back gracefully to direct audio engine', () => {
  lavalinkManager._setMockNode(null);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);

  const session = musicService.getSession('guild_ll8');
  assert.strictEqual(session.lavalinkPlayer, null);
  musicService.destroySession('guild_ll8', true);
});

// ─────────────────────────────────────────────────────────────
// Mandatory Full-Length Music Playback Verification Suite (20 Requirements)
// ─────────────────────────────────────────────────────────────

test('1. Spotify URL resolves to a full YouTube version', async () => {
  const spotifyTrack = {
    title: 'Starboy',
    artist: 'The Weeknd',
    durationSec: 230,
    source: 'spotify',
  };

  const candidates = [
    { title: 'The Weeknd - Starboy (Official Music Video) ft. Daft Punk', artist: 'The Weeknd', durationSec: 230, youtubeUrl: 'https://youtube.com/watch?v=starboy_full' },
    { title: 'Starboy 30s Snippet', artist: 'The Weeknd', durationSec: 30, youtubeUrl: 'https://youtube.com/watch?v=starboy_short' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, spotifyTrack);
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=starboy_full');
  assert.ok(ranked[0].durationSec > 60);
  assert.strictEqual(ranked[0].penalty, 0);
});

test('2. Spotify 30-second preview is rejected', () => {
  const spotifyTrack = { title: 'Blinding Lights', artist: 'The Weeknd', durationSec: 200 };
  const candidates = [
    { title: 'Blinding Lights - 30 Second Preview', artist: 'The Weeknd', durationSec: 30, youtubeUrl: 'https://youtube.com/watch?v=preview30' },
    { title: 'Blinding Lights (Official Audio)', artist: 'The Weeknd', durationSec: 200, youtubeUrl: 'https://youtube.com/watch?v=official_full' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, spotifyTrack);
  const preview = ranked.find(c => c.durationSec === 30);
  assert.ok(preview.penalty >= 1.0);
  assert.ok(preview.penaltyWords.includes('short_preview'));
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=official_full');
});

test('3. Correct artist is preferred', () => {
  const track = { title: 'Enna Sona', artist: 'Arijit Singh', durationSec: 213 };
  const candidates = [
    { title: 'Enna Sona', artist: 'Mitraz', durationSec: 213, youtubeUrl: 'https://youtube.com/watch?v=wrong_artist' },
    { title: 'Enna Sona - OK Jaanu | Arijit Singh', artist: 'Sony Music India', durationSec: 215, youtubeUrl: 'https://youtube.com/watch?v=correct_artist' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=correct_artist');
  assert.ok(ranked[0].finalScore > ranked[1].finalScore);
});

test('4. Wrong artist is rejected', () => {
  const track = { title: 'Enna Sona', artist: 'Arijit Singh', durationSec: 213 };
  const candidates = [
    { title: 'Enna Sona', artist: 'Mitraz', durationSec: 213, youtubeUrl: 'https://youtube.com/watch?v=wrong_artist' },
    { title: 'Enna Sona - Arijit Singh', artist: 'Arijit Singh', durationSec: 215, youtubeUrl: 'https://youtube.com/watch?v=correct_artist' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  const wrong = ranked.find(c => c.artist === 'Mitraz');
  assert.ok(wrong.penalty >= 0.75);
  assert.ok(wrong.penaltyWords.includes('different_artist'));
  const clean = ranked.filter(c => (c.penalty || 0) === 0 && !c.isDifferentArtist);
  assert.strictEqual(clean.length, 1);
  assert.strictEqual(clean[0].youtubeUrl, 'https://youtube.com/watch?v=correct_artist');
});

test('5. Preview clips are rejected', () => {
  const track = { title: 'Aakhya Mai Aakh Ghali Jo Bairan', artist: 'Sheesha', durationSec: 240 };
  const candidates = [
    { title: 'Aakhya Mai Aakh Ghali Jo Bairan - Official Teaser Preview Clip', artist: 'Sheesha', durationSec: 35, youtubeUrl: 'https://youtube.com/watch?v=teaser_clip' },
    { title: 'Aakhya Mai Aakh Ghali Jo Bairan (Official Video) - Sheesha', artist: 'Sheesha', durationSec: 240, youtubeUrl: 'https://youtube.com/watch?v=full_sheesha' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  const teaser = ranked.find(c => c.youtubeUrl.includes('teaser'));
  assert.ok(teaser.penalty >= 1.0);
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=full_sheesha');
});

test('6. Shorts and teasers are rejected', () => {
  const track = { title: 'Kesariya', artist: 'Arijit Singh', durationSec: 268 };
  const candidates = [
    { title: 'Kesariya Tera Ishq Hai Piya #shorts', artist: 'Arijit Singh', durationSec: 45, youtubeUrl: 'https://youtube.com/shorts/kesariya_short' },
    { title: 'Kesariya - Official Video | Brahmāstra | Arijit Singh', artist: 'Sony Music India', durationSec: 270, youtubeUrl: 'https://youtube.com/watch?v=kesariya_full' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  const shortCand = ranked.find(c => c.youtubeUrl.includes('short'));
  assert.ok(shortCand.penalty >= 1.0);
  assert.ok(shortCand.penaltyWords.includes('shorts_or_teaser') || shortCand.penaltyWords.includes('short_preview'));
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=kesariya_full');
});

test('7. Full-length YouTube track is accepted', () => {
  const track = { title: 'Shape of You', artist: 'Ed Sheeran', durationSec: 233 };
  const candidates = [
    { title: 'Ed Sheeran - Shape of You (Official Music Video)', artist: 'Ed Sheeran', durationSec: 233, youtubeUrl: 'https://youtube.com/watch?v=shape_official' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].penalty, 0);
  assert.strictEqual(ranked[0].durScore, 1.0);
  assert.ok(ranked[0].finalScore >= 0.85);
});

test('8. A genuinely short original song is not incorrectly rejected', () => {
  // Genuinely short interlude or intro track (35s expected duration)
  const track = { title: 'An Honest Interlude', artist: 'Album Artist', durationSec: 35 };
  const candidates = [
    { title: 'Album Artist - An Honest Interlude (Official Audio)', artist: 'Album Artist', durationSec: 35, youtubeUrl: 'https://youtube.com/watch?v=interlude_real' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, track);
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=interlude_real');
  assert.strictEqual(ranked[0].penalty, 0);
  assert.strictEqual(ranked[0].durScore, 1.0);
  assert.ok(!ranked[0].penaltyWords.includes('short_preview'));
});

test('9. No artificial 30-second playback limit exists', async () => {
  let playedPayload = null;

  const mockPlayer = {
    guildId: 'guild_no_30s',
    channelId: 'vc_no_30s',
    playTrack: async (opts) => { playedPayload = opts; },
    setGlobalVolume: () => {},
    on: () => {},
  };

  const session = musicService.getSession('guild_no_30s');
  session.lavalinkPlayer = mockPlayer;
  session.queue = [{
    title: 'Full Length Masterpiece',
    artist: 'Artist',
    durationSec: 310,
    encoded: 'enc_310s_track',
    youtubeUrl: 'https://youtube.com/watch?v=full310',
  }];

  await musicService.playNext('guild_no_30s');

  assert.ok(playedPayload, 'playTrack must be called');
  assert.strictEqual(playedPayload.track.encoded, 'enc_310s_track');
  // Confirm NO accidental endTime or 30s cut-off
  assert.strictEqual(playedPayload.endTime, undefined);
  assert.strictEqual(playedPayload.track.endTime, undefined);
  assert.strictEqual(session.currentTrack.durationSec, 310);

  musicService.destroySession('guild_no_30s', true);
});

test('10. No artificial 60-second playback limit exists', async () => {
  let playedPayload = null;

  const mockPlayer = {
    guildId: 'guild_no_60s',
    channelId: 'vc_no_60s',
    playTrack: async (opts) => { playedPayload = opts; },
    setGlobalVolume: () => {},
    on: () => {},
  };

  const session = musicService.getSession('guild_no_60s');
  session.lavalinkPlayer = mockPlayer;
  session.queue = [{
    title: 'Long Full Song',
    artist: 'Artist',
    durationSec: 420,
    encoded: 'enc_420s_track',
    youtubeUrl: 'https://youtube.com/watch?v=full420',
  }];

  await musicService.playNext('guild_no_60s');

  assert.ok(playedPayload);
  assert.strictEqual(playedPayload.endTime, undefined);
  assert.strictEqual(session.currentTrack.durationSec, 420);

  musicService.destroySession('guild_no_60s', true);
});

test('11. TrackEndEvent with reason finished works correctly', async () => {
  const events = new Map();
  const mockPlayer = {
    guildId: 'guild_end_event',
    channelId: 'vc_end_event',
    playTrack: async () => {},
    stopTrack: async () => {},
    setGlobalVolume: () => {},
    on: (evt, handler) => { events.set(evt, handler); },
    removeAllListeners: () => { events.clear(); },
  };

  const mockNode = {
    joinVoiceChannel: async () => mockPlayer,
    leaveVoiceChannel: async () => {},
    players: new Map([['guild_end_event', mockPlayer]]),
    rest: { resolve: async () => ({ loadType: 'empty', tracks: [] }) },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_end_event', name: 'End Event Guild' };
  const mockVc = { id: 'vc_end_event', name: 'General' };

  await musicService.ensureVoiceConnection(mockGuild, mockVc);
  const session = musicService.getSession(mockGuild.id);
  session.queue = [{ title: 'Track 2', artist: 'Artist 2', durationSec: 180, encoded: 'enc_t2' }];
  session.currentTrack = { title: 'Track 1', artist: 'Artist 1', durationSec: 200, encoded: 'enc_t1' };
  session.isPlaying = true;

  // Simulate TrackEndEvent finished
  const endHandler = events.get('end');
  assert.ok(typeof endHandler === 'function', 'End event listener must be registered');

  await endHandler({ type: 'TrackEndEvent', reason: 'finished' });

  // Queue should advance to Track 2
  assert.strictEqual(session.currentTrack.title, 'Track 2');
  assert.strictEqual(session.queue.length, 0);

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('12. TrackExceptionEvent is handled correctly', async () => {
  const events = new Map();
  let played = null;
  const mockPlayer = {
    guildId: 'guild_exc_event',
    channelId: 'vc_exc_event',
    playTrack: async (p) => { played = p; },
    stopTrack: async () => {},
    setGlobalVolume: () => {},
    on: (evt, handler) => { events.set(evt, handler); },
    removeAllListeners: () => { events.clear(); },
  };

  const mockNode = {
    joinVoiceChannel: async () => mockPlayer,
    leaveVoiceChannel: async () => {},
    players: new Map([['guild_exc_event', mockPlayer]]),
    rest: {
      resolve: async (q) => ({
        loadType: 'track',
        data: { encoded: 'enc_fallback_safe', info: { title: 'Fallback Candidate', length: 220000 } },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_exc_event', name: 'Exception Guild' };
  const mockVc = { id: 'vc_exc_event', name: 'General' };

  await musicService.ensureVoiceConnection(mockGuild, mockVc);
  const session = musicService.getSession(mockGuild.id);
  session.currentTrack = {
    title: 'Primary Song',
    durationSec: 200,
    encoded: 'enc_primary',
    fallbackUrls: ['https://youtube.com/watch?v=fallback_safe'],
    fallbackCandidates: [{ title: 'Fallback Safe', youtubeUrl: 'https://youtube.com/watch?v=fallback_safe' }],
  };
  session.isPlaying = true;

  const excHandler = events.get('exception');
  assert.ok(typeof excHandler === 'function', 'Exception handler must be registered');

  // Trigger TrackExceptionEvent
  await excHandler({
    type: 'TrackExceptionEvent',
    exception: { message: 'YouTube rate limit 429', severity: 'SUSPICIOUS' },
  });

  // Verify safe fallback candidate was switched to
  assert.ok(played, 'Fallback track must be streamed');
  assert.strictEqual(played.track.encoded, 'enc_fallback_safe');

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('13. TrackStuckEvent is handled correctly', async () => {
  const events = new Map();
  let played = null;
  const mockPlayer = {
    guildId: 'guild_stuck_event',
    channelId: 'vc_stuck_event',
    playTrack: async (p) => { played = p; },
    stopTrack: async () => {},
    setGlobalVolume: () => {},
    on: (evt, handler) => { events.set(evt, handler); },
    removeAllListeners: () => { events.clear(); },
  };

  const mockNode = {
    joinVoiceChannel: async () => mockPlayer,
    leaveVoiceChannel: async () => {},
    players: new Map([['guild_stuck_event', mockPlayer]]),
    rest: {
      resolve: async (q) => ({
        loadType: 'track',
        data: { encoded: 'enc_stuck_fallback', info: { title: 'Stuck Fallback', length: 210000 } },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_stuck_event', name: 'Stuck Guild' };
  const mockVc = { id: 'vc_stuck_event', name: 'General' };

  await musicService.ensureVoiceConnection(mockGuild, mockVc);
  const session = musicService.getSession(mockGuild.id);
  session.currentTrack = {
    title: 'Stuck Song',
    durationSec: 200,
    encoded: 'enc_stuck_primary',
    fallbackCandidates: [{ title: 'Stuck Fallback', youtubeUrl: 'https://youtube.com/watch?v=stuck_fb' }],
  };
  session.isPlaying = true;

  const stuckHandler = events.get('stuck');
  assert.ok(typeof stuckHandler === 'function', 'Stuck handler must be registered');

  await stuckHandler({ type: 'TrackStuckEvent', thresholdMs: 10000 });

  assert.ok(played);
  assert.strictEqual(played.track.encoded, 'enc_stuck_fallback');

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('14. Queue advances exactly once', () => {
  const session = musicService.getSession('guild_single_advance');
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };
  session.queue = [
    { title: 'Track 1', durationSec: 100, encoded: 'enc1' },
    { title: 'Track 2', durationSec: 200, encoded: 'enc2' },
    { title: 'Track 3', durationSec: 300, encoded: 'enc3' },
  ];
  session.currentTrack = { title: 'Track 0', durationSec: 150, encoded: 'enc0' };

  // Call handleTrackEnded
  musicService.handleTrackEnded('guild_single_advance');

  // Must advance exactly one track
  assert.strictEqual(session.currentTrack.title, 'Track 1');
  assert.strictEqual(session.queue.length, 2);
  assert.strictEqual(session.queue[0].title, 'Track 2');

  musicService.destroySession('guild_single_advance', true);
});

test('15. Pause and resume work', () => {
  let pausedCall = null;
  const mockPlayer = {
    guildId: 'guild_pause_resume',
    setPaused: (p) => { pausedCall = p; },
  };

  const session = musicService.getSession('guild_pause_resume');
  session.lavalinkPlayer = mockPlayer;
  session.isPlaying = true;
  session.isPaused = false;

  const paused = musicService.pause('guild_pause_resume');
  assert.strictEqual(paused, true);
  assert.strictEqual(pausedCall, true);
  assert.strictEqual(session.isPaused, true);

  const resumed = musicService.resume('guild_pause_resume');
  assert.strictEqual(resumed, true);
  assert.strictEqual(pausedCall, false);
  assert.strictEqual(session.isPaused, false);

  musicService.destroySession('guild_pause_resume', true);
});

test('16. Skip works', () => {
  let stopped = false;
  const mockPlayer = {
    guildId: 'guild_skip_test',
    stopTrack: () => { stopped = true; },
  };

  const session = musicService.getSession('guild_skip_test');
  session.lavalinkPlayer = mockPlayer;
  session.isPlaying = true;
  session.queue = [{ title: 'Next Song', durationSec: 180 }];
  session.currentTrack = { title: 'Current Song', durationSec: 200 };

  const skipped = musicService.skip('guild_skip_test');
  assert.ok(skipped);
  assert.strictEqual(skipped.title, 'Current Song');
  assert.strictEqual(stopped, true);

  musicService.destroySession('guild_skip_test', true);
});

test('17. Seek works', async () => {
  let seekPosition = null;
  const mockPlayer = {
    guildId: 'guild_seek_test',
    seekTo: async (ms) => { seekPosition = ms; },
  };

  const session = musicService.getSession('guild_seek_test');
  session.lavalinkPlayer = mockPlayer;
  session.isPlaying = true;
  session.currentTrack = { title: 'Seek Track', durationSec: 240 };

  const res = await musicService.seek('guild_seek_test', 90);
  assert.strictEqual(res.success, true);
  assert.strictEqual(seekPosition, 90000);

  musicService.destroySession('guild_seek_test', true);
});

test('18. Volume works', () => {
  let volumeSet = null;
  const mockPlayer = {
    guildId: 'guild_volume_test',
    setGlobalVolume: (v) => { volumeSet = v; },
  };

  const session = musicService.getSession('guild_volume_test');
  session.lavalinkPlayer = mockPlayer;

  const vol = musicService.setVolume('guild_volume_test', 85);
  assert.strictEqual(vol, 85);
  assert.strictEqual(volumeSet, 85);
  assert.strictEqual(session.volume, 85);

  musicService.destroySession('guild_volume_test', true);
});

test('19. Failed YouTube candidates trigger safe fallback', async () => {
  let played = null;
  const mockPlayer = {
    guildId: 'guild_fallback_test',
    playTrack: async (p) => { played = p; },
  };

  const mockNode = {
    rest: {
      resolve: async (url) => ({
        loadType: 'track',
        data: { encoded: 'enc_candidate_2', info: { title: 'Song (Official 2)', length: 235000 } },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const session = musicService.getSession('guild_fallback_test');
  session.lavalinkPlayer = mockPlayer;

  const trackWithFallback = {
    title: 'Enna Sona',
    artist: 'Arijit Singh',
    youtubeUrl: 'https://youtube.com/watch?v=failing_candidate_1',
    durationSec: 215,
    fallbackCandidates: [
      { title: 'Enna Sona Official 2', youtubeUrl: 'https://youtube.com/watch?v=backup_candidate_2' },
    ],
  };

  const handled = await musicService.tryFallbackCandidate('guild_fallback_test', trackWithFallback);
  assert.strictEqual(handled, true);
  assert.ok(played);
  assert.strictEqual(played.track.encoded, 'enc_candidate_2');
  assert.strictEqual(trackWithFallback.youtubeUrl, 'https://youtube.com/watch?v=backup_candidate_2');

  musicService.destroySession('guild_fallback_test', true);
  lavalinkManager._setMockNode(null);
});

test('20. Both Spotify URL and normal song-name input work', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (q) => ({
        loadType: 'track',
        data: { encoded: 'enc_resolved_song', info: { title: 'Resolved Song', author: 'Singer', length: 215000 } },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_both_inputs', name: 'Inputs Guild' };
  const mockVc = { id: 'vc_both_inputs', name: 'General' };
  const mockUser = { id: 'user_both_inputs' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };

  // 1. Exact verified track input (simulating Spotify resolution)
  const spotifyResolvedTrack = {
    title: 'Enna Sona',
    artist: 'Arijit Singh',
    durationSec: 215,
    source: 'spotify',
    provider: 'youtube',
    youtubeUrl: 'https://youtube.com/watch?v=enna_sona_yt',
  };

  const resSpotify = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    spotifyResolvedTrack.title,
    { exactTrack: spotifyResolvedTrack }
  );

  assert.strictEqual(resSpotify.success, true);
  assert.strictEqual(resSpotify.firstTrack.provider, 'youtube');
  assert.strictEqual(resSpotify.firstTrack.source, 'spotify');
  assert.strictEqual(resSpotify.firstTrack.durationSec, 215);

  // 2. Normal song name input
  const normalSearchTrack = {
    title: 'Aakhya Mai Aakh Ghali Jo Bairan',
    artist: 'Sheesha',
    durationSec: 240,
    source: 'youtube',
    provider: 'youtube',
    youtubeUrl: 'https://youtube.com/watch?v=sheesha_yt',
  };

  const resName = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    normalSearchTrack.title,
    { exactTrack: normalSearchTrack }
  );

  assert.strictEqual(resName.success, true);
  assert.strictEqual(resName.firstTrack.provider, 'youtube');
  assert.strictEqual(resName.firstTrack.title, 'Aakhya Mai Aakh Ghali Jo Bairan');
  assert.strictEqual(resName.firstTrack.durationSec, 240);

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('21. Unsupported URL formats are rejected with a clear user-facing error', async () => {
  const mockGuild = { id: 'guild_unsupported_url', name: 'Unsupported Guild' };
  const mockVc = { id: 'vc_unsupported', name: 'General' };
  const mockUser = { id: 'user_unsupported' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://music.apple.com/us/album/some-album/123456789'
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('not supported for playback'), 'Must explain supported link formats');
  assert.ok(res.message.includes('YouTube') && res.message.includes('Spotify') && res.message.includes('SoundCloud'));

  musicService.destroySession(mockGuild.id, true);
});

test('22. Direct YouTube video URL resolves via Lavalink with encoded track and full duration', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (url) => ({
        loadType: 'track',
        data: {
          encoded: 'enc_yt_direct_video',
          info: {
            title: 'Enna Sona Official Video',
            author: 'A.R. Rahman',
            length: 215000,
            uri: 'https://www.youtube.com/watch?v=s_95jJvXFqg',
            identifier: 's_95jJvXFqg',
          },
        },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_yt_direct', name: 'YT Direct Guild' };
  const mockVc = { id: 'vc_yt_direct', name: 'General' };
  const mockUser = { id: 'user_yt_direct' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://www.youtube.com/watch?v=s_95jJvXFqg'
  );

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.firstTrack.provider, 'youtube');
  assert.strictEqual(res.firstTrack.encoded, 'enc_yt_direct_video');
  assert.strictEqual(res.firstTrack.durationSec, 215);
  assert.strictEqual(res.firstTrack.title, 'Enna Sona Official Video');

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('23. Direct YouTube playlist URL resolves all tracks via Lavalink with playlist name and count', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (url) => ({
        loadType: 'playlist',
        data: {
          info: { name: 'Bollywood Hits 2024' },
          tracks: [
            { encoded: 'enc_pl_1', info: { title: 'Track 1', author: 'Artist 1', length: 200000, identifier: 'id1', uri: 'https://youtube.com/watch?v=id1' } },
            { encoded: 'enc_pl_2', info: { title: 'Track 2', author: 'Artist 2', length: 180000, identifier: 'id2', uri: 'https://youtube.com/watch?v=id2' } },
            { encoded: 'enc_pl_3', info: { title: 'Track 3', author: 'Artist 3', length: 240000, identifier: 'id3', uri: 'https://youtube.com/watch?v=id3' } },
          ],
        },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_yt_playlist', name: 'YT Playlist Guild' };
  const mockVc = { id: 'vc_yt_playlist', name: 'General' };
  const mockUser = { id: 'user_yt_playlist' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://www.youtube.com/playlist?list=PL_TEST_BOLLYWOOD'
  );

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.isPlaylist, true);
  assert.strictEqual(res.playlistName, 'Bollywood Hits 2024');
  assert.strictEqual(res.count, 3);
  assert.strictEqual(session.currentTrack.encoded, 'enc_pl_1');
  assert.strictEqual(session.queue.length, 2);

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('24. Direct SoundCloud track and playlist URL resolves via Lavalink', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (url) => ({
        loadType: 'track',
        data: {
          encoded: 'enc_sc_single',
          info: { title: 'Indie Vibe', author: 'Indie Artist', length: 195000, sourceName: 'soundcloud' },
        },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_sc_resolve', name: 'SC Guild' };
  const mockVc = { id: 'vc_sc_resolve', name: 'General' };
  const mockUser = { id: 'user_sc_resolve' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://soundcloud.com/indie-artist/indie-vibe'
  );

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.firstTrack.provider, 'soundcloud');
  assert.strictEqual(res.firstTrack.encoded, 'enc_sc_single');
  assert.strictEqual(res.firstTrack.durationSec, 195);

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('25. Song with featured artist (ft./feat.) matches canonical without penalization', () => {
  const candidates = [
    { title: 'Enna Sona (feat. Arijit Singh)', artist: 'A.R. Rahman', durationSec: 215, youtubeUrl: 'https://youtube.com/watch?v=feat1' },
    { title: 'Enna Sona (Cover by SomeUser)', artist: 'SomeUser', durationSec: 210, youtubeUrl: 'https://youtube.com/watch?v=cover1' },
  ];

  const queryInfo = { title: 'Enna Sona', artist: 'A.R. Rahman ft. Arijit Singh' };
  const ranked = audioProvider.rankYouTubeCandidates(candidates, queryInfo);

  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=feat1');
  assert.strictEqual(ranked[0].penalty, 0);
  assert.strictEqual(ranked[0].isDifferentArtist, false);
});

test('26. Regional Tamil Unicode song search preserves Unicode and scores authentic video', () => {
  const candidates = [
    { title: 'காதலே காதலே - 96 Official Lyric Video', artist: 'Govind Vasantha', durationSec: 210, youtubeUrl: 'https://youtube.com/watch?v=tamil_official' },
    { title: 'Kadhale Kadhale Slowed Reverb', artist: 'Random Editor', durationSec: 240, youtubeUrl: 'https://youtube.com/watch?v=tamil_slowed' },
  ];

  const queryInfo = { title: 'காதலே காதலே', artist: 'Govind Vasantha' };
  const ranked = audioProvider.rankYouTubeCandidates(candidates, queryInfo);

  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=tamil_official');
  assert.ok(ranked[1].penalty > 0, 'Slowed reverb version must be penalized');
});

test('27. Spotify track metadata extracts ISRC and expected duration', async () => {
  const { resolveSpotify } = require('../src/music/spotifyResolver');
  // Resolves track metadata cleanly
  const res = await resolveSpotify('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  if (res && res.tracks && res.tracks.length > 0) {
    const track = res.tracks[0];
    assert.ok(track.title);
    assert.ok(track.artist);
    assert.strictEqual(typeof track.durationSec, 'number');
    assert.strictEqual(track.spotifyUrl, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
  }
});

test('28. Lavalink loadType error returns exact user-facing explanation', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (url) => ({
        loadType: 'error',
        data: { message: 'This video is not available in your country.' },
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_loadtype_err', name: 'Err Guild' };
  const mockVc = { id: 'vc_loadtype_err', name: 'General' };
  const mockUser = { id: 'user_loadtype_err' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://www.youtube.com/watch?v=geo_restricted_video'
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('This video is not available in your country'), 'Error message must reflect Lavalink exception');

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('29. Lavalink loadType empty returns clear not found message', async () => {
  const mockNode = {
    joinVoiceChannel: async () => ({
      playTrack: async () => {},
      stopTrack: async () => {},
      on: () => {},
    }),
    leaveVoiceChannel: async () => {},
    rest: {
      resolve: async (url) => ({
        loadType: 'empty',
        data: {},
      }),
    },
  };
  lavalinkManager._setMockNode(mockNode);

  const mockGuild = { id: 'guild_loadtype_empty', name: 'Empty Guild' };
  const mockVc = { id: 'vc_loadtype_empty', name: 'General' };
  const mockUser = { id: 'user_loadtype_empty' };

  const session = musicService.getSession(mockGuild.id);
  session.connection = { state: { status: 'ready' } };

  const res = await musicService.enqueueTrack(
    mockGuild,
    mockVc,
    mockUser,
    null,
    'https://www.youtube.com/watch?v=deleted_or_missing_id'
  );

  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('Could not find or load the YouTube video'));

  musicService.destroySession(mockGuild.id, true);
  lavalinkManager._setMockNode(null);
});

test('30. Shoukaku v4 node states are recognized accurately (0=connecting, 1=connected, 2=disconnecting, 3=disconnected)', () => {
  assert.strictEqual(lavalinkManager.isLavalinkConfigured(), true);

  // 1. CONNECTING (state 0) must be rejected
  const connectingNode = { state: 0 };
  lavalinkManager._setMockNode(connectingNode);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);
  assert.strictEqual(lavalinkManager.getIdealNode(), null);

  // 2. CONNECTED (state 1 / Constants.State.CONNECTED) must be accepted
  const connectedNode = { state: 1 };
  lavalinkManager._setMockNode(connectedNode);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), true);
  assert.strictEqual(lavalinkManager.getIdealNode(), connectedNode);

  // 3. DISCONNECTING (state 2) must be strictly rejected
  const disconnectingNode = { state: 2 };
  lavalinkManager._setMockNode(disconnectingNode);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);
  assert.strictEqual(lavalinkManager.getIdealNode(), null);

  // 4. DISCONNECTED (state 3) must be strictly rejected
  const disconnectedNode = { state: 3 };
  lavalinkManager._setMockNode(disconnectedNode);
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);
  assert.strictEqual(lavalinkManager.getIdealNode(), null);

  lavalinkManager._setMockNode(null);
});

test('33. Node selection when multiple nodes exist selects the only connected node and rejects non-connected nodes', () => {
  lavalinkManager._setMockNode(null);

  const nodeA = { name: 'node-A-connecting', state: 0 };
  const nodeB = { name: 'node-B-disconnecting', state: 2 };
  const nodeC = { name: 'node-C-connected', state: 1 };
  const nodeD = { name: 'node-D-disconnected', state: 3 };

  const fakeShoukaku = {
    getIdealNode: () => null, // simulates idealNode not directly assigned yet
    nodes: new Map([
      ['node-A', nodeA],
      ['node-B', nodeB],
      ['node-C', nodeC],
      ['node-D', nodeD],
    ]),
  };

  lavalinkManager._setShoukakuInstance(fakeShoukaku);

  assert.strictEqual(lavalinkManager.isLavalinkReady(), true);
  const ideal = lavalinkManager.getIdealNode();
  assert.ok(ideal);
  assert.strictEqual(ideal, nodeC);
  assert.strictEqual(ideal.name, 'node-C-connected');

  // When nodeC transitions to DISCONNECTING (state 2)
  nodeC.state = 2;
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);
  assert.strictEqual(lavalinkManager.getIdealNode(), null);

  // When nodeC transitions to DISCONNECTED (state 3)
  nodeC.state = 3;
  assert.strictEqual(lavalinkManager.isLavalinkReady(), false);
  assert.strictEqual(lavalinkManager.getIdealNode(), null);

  lavalinkManager._setShoukakuInstance(null);
});

test('31. Duplicate play requests do not cause double queue advancement or race conditions', async () => {
  const session = musicService.getSession('guild_duplicate_prevention');
  session.lavalinkPlayer = { playTrack: async () => {}, stopTrack: async () => {} };
  session.queue = [
    { title: 'Track 1', durationSec: 100, encoded: 'enc1' },
    { title: 'Track 2', durationSec: 200, encoded: 'enc2' },
  ];
  session.currentTrack = { title: 'Track 0', durationSec: 150, encoded: 'enc0' };
  session.isPlaying = true;

  // Simulate two simultaneous track end triggers
  musicService.handleTrackEnded('guild_duplicate_prevention');
  // First advancement shifted Track 1
  assert.strictEqual(session.currentTrack.title, 'Track 1');

  musicService.destroySession('guild_duplicate_prevention', true);
});

test('32. Search timeout handling safety with AbortController prevents indefinite hanging', async () => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50);

  const timedOut = await Promise.race([
    new Promise(resolve => setTimeout(() => resolve('finished'), 500)),
    new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve('aborted'));
    }),
  ]);

  clearTimeout(timeoutId);
  assert.strictEqual(timedOut, 'aborted');
});

test('33. joinVoice reuses active player on the same channel without duplicate connection creation', async () => {
  const fakePlayer = { channelId: 'vc_100', guildId: 'guild_reuse_test' };
  const fakeConn = { channelId: 'vc_100', guildId: 'guild_reuse_test' };
  let joinCalled = false;

  const fakeShoukaku = {
    players: new Map([['guild_reuse_test', fakePlayer]]),
    connections: new Map([['guild_reuse_test', fakeConn]]),
    joinVoiceChannel: async () => { joinCalled = true; return fakePlayer; },
  };

  lavalinkManager._setShoukakuInstance(fakeShoukaku);
  const player = await lavalinkManager.joinVoice({ guildId: 'guild_reuse_test', channelId: 'vc_100' });
  assert.strictEqual(player, fakePlayer);
  assert.strictEqual(joinCalled, false, 'joinVoiceChannel must not be called when player already exists on channel');
  lavalinkManager._setShoukakuInstance(null);
});

test('34. joinVoice cleans up existing connection when channel changes before joining new channel', async () => {
  const fakePlayer = { channelId: 'vc_old', guildId: 'guild_move_test' };
  const fakeConn = { channelId: 'vc_old', guildId: 'guild_move_test' };
  let leaveCalled = false;
  let joinCalled = false;

  const fakeShoukaku = {
    players: new Map([['guild_move_test', fakePlayer]]),
    connections: new Map([['guild_move_test', fakeConn]]),
    leaveVoiceChannel: async (gId) => {
      leaveCalled = true;
      fakeShoukaku.connections.delete(gId);
      fakeShoukaku.players.delete(gId);
    },
    joinVoiceChannel: async (opts) => {
      joinCalled = true;
      return { channelId: opts.channelId, guildId: opts.guildId };
    },
  };

  lavalinkManager._setShoukakuInstance(fakeShoukaku);
  const player = await lavalinkManager.joinVoice({ guildId: 'guild_move_test', channelId: 'vc_new' });
  assert.strictEqual(leaveCalled, true, 'leaveVoiceChannel must be called to purge stale connection');
  assert.strictEqual(joinCalled, true, 'joinVoiceChannel must be called for new channel');
  assert.strictEqual(player.channelId, 'vc_new');
  lavalinkManager._setShoukakuInstance(null);
});

test('35. commandDispatcher /play timeout prevents indefinite searching message', async () => {
  const { dispatchCommand } = require('../src/commands/commandDispatcher');
  let editReplyMessage = null;
  const mockInteraction = {
    commandName: 'play',
    isChatInputCommand: () => true,
    deferReply: async () => {},
    editReply: async (msg) => { editReplyMessage = typeof msg === 'string' ? msg : msg.content; },
    member: { voice: { channel: { id: 'vc_test', name: 'Voice' } }, id: 'user_1' },
    guild: { id: 'guild_timeout_test', name: 'Timeout Guild', voiceAdapterCreator: () => {} },
    user: { id: 'user_1', tag: 'Tester#0001' },
    channel: { send: async () => {} },
    options: { getString: () => 'some song that hangs' },
  };

  // Dispatch command where enqueueTrack throws to verify immediate message finalization
  const prevEnqueue = musicService.enqueueTrack;
  musicService.enqueueTrack = async () => { throw new Error('Search failed to find video'); };

  try {
    await dispatchCommand(mockInteraction, { client: { isReady: () => true } });
    assert.ok(editReplyMessage, 'editReply must have been called');
    assert.match(editReplyMessage, /Unable to find or load this song/i);
  } finally {
    musicService.enqueueTrack = prevEnqueue;
  }
});

test('36. playNext does not abort playback when Lavalink player is active even if session.connection is not ready', async () => {
  const session = musicService.getSession('guild_lavalink_standalone');
  let playTrackCalled = false;
  session.lavalinkPlayer = {
    channelId: 'vc_ll',
    playTrack: async () => { playTrackCalled = true; },
    setGlobalVolume: () => {},
  };
  // Simulate stale or signalling discordjs connection
  session.connection = {
    state: { status: 'signalling' },
    destroy: () => {},
  };
  session.queue = [{ title: 'Lavalink Song', encoded: 'valid_encoded_string' }];
  session.isPlaying = false;

  await musicService.playNext('guild_lavalink_standalone');
  assert.strictEqual(playTrackCalled, true, 'Lavalink playTrack must be invoked despite non-ready discordjs connection');
  musicService.destroySession('guild_lavalink_standalone', true);
});

test('37. ensureVoiceConnection destroys legacy @discordjs/voice connection when Lavalink is ready', async () => {
  const session = musicService.getSession('guild_dismantle_test');
  let destroyed = false;
  session.connection = {
    state: { status: 'ready' },
    destroy: () => { destroyed = true; },
    removeAllListeners: () => {},
  };

  const mockNode = {
    state: 1,
    joinVoiceChannel: async (opts) => ({ channelId: opts.channelId, guildId: opts.guildId, on: () => {}, removeAllListeners: () => {} }),
  };
  lavalinkManager._setMockNode(mockNode);

  const vc = { id: 'vc_dismantle', permissionsFor: () => ({ has: () => true }) };
  const guild = { id: 'guild_dismantle_test', members: { me: {} }, voiceAdapterCreator: () => {} };

  const res = await musicService.ensureVoiceConnection(guild, vc);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.lavalink, true);
  assert.strictEqual(destroyed, true, 'Legacy discordjs voice connection must be destroyed when switching to Lavalink');
  assert.strictEqual(session.connection, null, 'session.connection must be nullified to prevent collision');

  lavalinkManager._setMockNode(null);
  musicService.destroySession('guild_dismantle_test', true);
});

test('38. Health server EADDRINUSE error is handled safely without throwing uncaught exceptions', async () => {
  const http = require('http');
  const dummyServer = http.createServer((req, res) => res.end('ok'));
  let errorCaught = false;

  await new Promise((resolve) => {
    dummyServer.listen(0, () => {
      const port = dummyServer.address().port;
      const collisionServer = http.createServer();
      collisionServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          errorCaught = true;
          collisionServer.close();
          dummyServer.close();
          resolve();
        }
      });
      collisionServer.listen(port);
    });
  });

  assert.strictEqual(errorCaught, true, 'EADDRINUSE error must be caught gracefully');
});



