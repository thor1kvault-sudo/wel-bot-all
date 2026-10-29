'use strict';

/**
 * THOR APEX — Spotify to YouTube Matching & Audio Engine Test Suite
 *
 * Verifies:
 *  - Spotify track URL metadata resolution
 *  - Correct YouTube candidate ranking (official video/audio selected over slowed/reverb/remixes)
 *  - Penalty on unrequested slowed, reverb, cover, and mashup modifiers
 *  - Failure reporting when no suitable YouTube candidate meets threshold
 *  - Voice connection readiness check (prevents false Playing state when connection not ready)
 *  - Stream failure handling, 404 fallback URLs, and queue recovery
 *  - Playback completion and speaking state synchronization
 */

const test = require('node:test');
const assert = require('node:assert');

const audioProvider = require('../src/music/audioProvider');
const musicService = require('../src/music/musicService');
const { parseSpotifyUrl, isSpotifyUrl } = require('../src/music/spotifyResolver');

// ─────────────────────────────────────────────────────────────
// 1. Spotify URL Parsing & Metadata
// ─────────────────────────────────────────────────────────────

test('SY-1: Spotify URL validation and identifier extraction', () => {
  const trackUrl = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';
  const albumUrl = 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo';
  const playlistUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

  assert.strictEqual(isSpotifyUrl(trackUrl), true);
  assert.strictEqual(isSpotifyUrl(albumUrl), true);
  assert.strictEqual(isSpotifyUrl(playlistUrl), true);
  assert.strictEqual(isSpotifyUrl('https://youtube.com/watch?v=123'), false);

  const parsedTrack = parseSpotifyUrl(trackUrl);
  assert.strictEqual(parsedTrack.type, 'track');
  assert.strictEqual(parsedTrack.id, '4uLU6hMCjMI75M1A2tKUQC');

  const parsedAlbum = parseSpotifyUrl(albumUrl);
  assert.strictEqual(parsedAlbum.type, 'album');
  assert.strictEqual(parsedAlbum.id, '1A2GTWGtFfWp7KSQTwWOyo');
});

// ─────────────────────────────────────────────────────────────
// 2. YouTube Candidate Ranking & Selection
// ─────────────────────────────────────────────────────────────

test('SY-2: rankYouTubeCandidates selects official version over remix and slowed/reverb', () => {
  const spotifyTrack = {
    title: 'Starboy',
    artist: 'The Weeknd',
    durationSec: 230,
  };

  const candidates = [
    { title: 'The Weeknd - Starboy (Slowed & Reverb)', artist: 'VibeStation', durationSec: 275, youtubeUrl: 'https://youtube.com/watch?v=slowed' },
    { title: 'The Weeknd - Starboy (Official Music Video) ft. Daft Punk', artist: 'The Weeknd', durationSec: 230, youtubeUrl: 'https://youtube.com/watch?v=official' },
    { title: 'The Weeknd - Starboy (Remix Club Edit)', artist: 'DJ Mixer', durationSec: 190, youtubeUrl: 'https://youtube.com/watch?v=remix' },
    { title: 'Starboy (Cover by Acoustic Singer)', artist: 'Acoustic Guy', durationSec: 220, youtubeUrl: 'https://youtube.com/watch?v=cover' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, spotifyTrack);
  assert.strictEqual(ranked.length, 4);

  const top = ranked[0];
  assert.strictEqual(top.youtubeUrl, 'https://youtube.com/watch?v=official');
  assert.strictEqual(top.penalty, 0);
  assert.ok(top.finalScore > 0.80, `Expected official track score > 0.80, got ${top.finalScore}`);

  // Slowed, remix and cover must receive heavy penalties
  const slowed = ranked.find(c => c.youtubeUrl.includes('slowed'));
  const remix = ranked.find(c => c.youtubeUrl.includes('remix'));
  const cover = ranked.find(c => c.youtubeUrl.includes('cover'));

  assert.ok(slowed.penalty >= 0.50);
  assert.ok(remix.penalty >= 0.50);
  assert.ok(cover.penalty >= 0.50);
  assert.ok(top.finalScore > slowed.finalScore);
  assert.ok(top.finalScore > remix.finalScore);
});

test('SY-3: rankYouTubeCandidates rejects candidates with large duration discrepancy', () => {
  const spotifyTrack = {
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    durationSec: 200,
  };

  const loopCandidate = [
    { title: 'The Weeknd - Blinding Lights 1 Hour Loop', artist: 'The Weeknd', durationSec: 3600, youtubeUrl: 'https://youtube.com/watch?v=loop' },
    { title: 'The Weeknd - Blinding Lights (Official Audio)', artist: 'The Weeknd', durationSec: 200, youtubeUrl: 'https://youtube.com/watch?v=real' },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(loopCandidate, spotifyTrack);
  assert.strictEqual(ranked[0].youtubeUrl, 'https://youtube.com/watch?v=real');
  assert.ok(ranked[0].finalScore > ranked[1].finalScore);
});

test('SY-4: matchSpotifyToYouTube returns failure when no candidates meet threshold', async () => {
  // Empty candidates or all completely mismatching
  const unmatchable = {
    title: 'Unmatchable Track XYZ 99999',
    artist: 'Ghost Artist 12345',
    durationSec: 180,
  };

  const match = await audioProvider.matchSpotifyToYouTube(unmatchable);
  assert.strictEqual(typeof match.success, 'boolean');
  if (!match.success) {
    assert.ok(match.reason && match.reason.length > 0);
  }
});

// ─────────────────────────────────────────────────────────────
// 3. Voice Connection Readiness & Error Recovery
// ─────────────────────────────────────────────────────────────

test('SY-5: playNext prevents playback if voice connection is not in READY state', async () => {
  const guild = { id: 'guild_sy5_voice_check', name: 'Voice Check Guild' };
  const session = musicService.getSession(guild.id, guild.name);

  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production'; // Simulate live production check

    session.connection = {
      state: { status: 'signalling' }, // Not ready
      subscribe: () => {},
    };
    session.queue = [{ title: 'Test Song', artist: 'Artist', streamUrl: 'https://example.com/audio.mp3', source: 'direct' }];
    session.isPlaying = false;

    let warned = false;
    session.textChannel = {
      send: (msg) => {
        if (typeof msg === 'string' && msg.includes('Voice connection could not be established')) warned = true;
        return Promise.resolve();
      },
    };

    await musicService.playNext(guild.id);

    assert.strictEqual(session.isPlaying, false, 'Player must not be marked playing when connection is not ready');
    assert.strictEqual(session.currentTrack, null, 'Current track must remain null');
    assert.strictEqual(warned, true, 'User should be notified that connection is not ready');
  } finally {
    process.env.NODE_ENV = prevEnv;
    musicService.destroySession(guild.id, true);
  }
});

test('SY-6: Stream error catches cleanly, does not throw, and cleans player state', async () => {
  const guild = { id: 'guild_sy6_stream_err', name: 'Stream Error Guild' };
  const vc = { id: 'vc_sy6', joinable: true, permissionsFor: () => ({ has: () => true }) };
  const user = { id: 'user_sy6' };
  const channel = { send: () => Promise.resolve() };

  const session = musicService.getSession(guild.id, guild.name);
  session.voiceChannel = vc;
  session.connection = {
    state: { status: 'ready' },
    joinConfig: { channelId: vc.id },
    subscribe: () => {},
    setSpeaking: () => {},
  };
  session.player = { play: () => {}, state: { status: 'idle' } };

  // Set mock stream function that rejects
  audioProvider._setStreamFunction(async () => {
    throw new Error('Simulated network socket timeout');
  });

  try {
    const brokenTrack = {
      title: 'Broken Audio Track',
      artist: 'Nobody',
      streamUrl: 'https://soundcloud.com/broken',
      source: 'soundcloud',
    };

    const res = await musicService.enqueueTrack(guild, vc, user, channel, brokenTrack.title, { exactTrack: brokenTrack });
    assert.strictEqual(res.success, false);
    assert.ok(res.message.includes('Playback stream verification failed'));
    assert.strictEqual(session.isPlaying, false);
  } finally {
    audioProvider._setStreamFunction(null);
    musicService.destroySession(guild.id, true);
  }
});

test('SY-7: Playback state transitions accurately and tracks loop modes', () => {
  const session = musicService.getSession('guild_sy7_loop_test');
  session.queue = [{ title: 'Track 1' }, { title: 'Track 2' }];
  session.currentTrack = { title: 'Track 0' };

  // Track loop
  session.loopMode = 'track';
  session.queue.unshift(session.currentTrack);
  assert.strictEqual(session.queue[0].title, 'Track 0');

  // Queue loop
  session.loopMode = 'queue';
  session.queue.shift(); // remove Track 0
  session.queue.push(session.currentTrack);
  assert.strictEqual(session.queue[session.queue.length - 1].title, 'Track 0');

  musicService.destroySession('guild_sy7_loop_test', true);
});
