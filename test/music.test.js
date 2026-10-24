/**
 * THOR APEX - Music Subsystem Unit Tests
 */
const test   = require('node:test');
const assert = require('node:assert');

// 1. Spotify Resolver
const { isSpotifyUrl } = require('../src/music/spotifyResolver');

test('M-1: isSpotifyUrl - identifies Spotify track URLs', () => {
  assert.strictEqual(isSpotifyUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), true);
  assert.strictEqual(isSpotifyUrl('https://open.spotify.com/track/xyz?si=abc'), true);
});

test('M-2: isSpotifyUrl - identifies Spotify album URLs', () => {
  assert.strictEqual(isSpotifyUrl('https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'), true);
});

test('M-3: isSpotifyUrl - identifies Spotify playlist URLs', () => {
  assert.strictEqual(isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true);
});

test('M-4: isSpotifyUrl - rejects non-Spotify URLs', () => {
  assert.strictEqual(isSpotifyUrl('https://youtube.com/watch?v=abc'), false);
  assert.strictEqual(isSpotifyUrl('lofi hip hop chill'), false);
  assert.strictEqual(isSpotifyUrl(''), false);
  assert.strictEqual(isSpotifyUrl(null), false);
  assert.strictEqual(isSpotifyUrl(undefined), false);
});

// 2. Music Service - Session lifecycle
const musicService = require('../src/music/musicService');

test('M-5: getSession - creates isolated session per guild', () => {
  const s1 = musicService.getSession('guild_test_1', 'Test Server A');
  const s2 = musicService.getSession('guild_test_2', 'Test Server B');
  assert.strictEqual(s1.guildId, 'guild_test_1');
  assert.strictEqual(s2.guildId, 'guild_test_2');
  assert.notStrictEqual(s1, s2);
});

test('M-6: getSession - returns same session on repeat calls', () => {
  const s1 = musicService.getSession('guild_same_test');
  const s2 = musicService.getSession('guild_same_test');
  assert.strictEqual(s1, s2);
});

test('M-7: getSession - initializes all required fields', () => {
  const session = musicService.getSession('guild_field_check');
  assert.ok(Array.isArray(session.queue));
  assert.ok(Array.isArray(session.history));
  assert.strictEqual(session.isPlaying, false);
  assert.strictEqual(session.isPaused, false);
  assert.strictEqual(session.loopMode, 'off');
  assert.strictEqual(session.volume, 100);
  assert.strictEqual(typeof session.getPlaybackSeconds, 'function');
});

test('M-8: getPlaybackSeconds - returns 0 when not playing', () => {
  const session = musicService.getSession('guild_pb_check');
  assert.strictEqual(session.getPlaybackSeconds(), 0);
});

test('M-9: destroySession - removes session from map', () => {
  musicService.getSession('guild_destroy_test');
  assert.ok(musicService.sessions.has('guild_destroy_test'));
  musicService.destroySession('guild_destroy_test');
  assert.strictEqual(musicService.sessions.has('guild_destroy_test'), false);
});

test('M-10: destroySession - safe on non-existent guild', () => {
  assert.doesNotThrow(() => musicService.destroySession('guild_not_exist_xyz'));
});

// 3. Queue operations
test('M-11: clearQueue - clears all queued tracks', () => {
  const session = musicService.getSession('guild_queue_clear');
  session.queue.push({ title: 'Track A' });
  session.queue.push({ title: 'Track B' });
  session.queue.push({ title: 'Track C' });
  const cleared = musicService.clearQueue('guild_queue_clear');
  assert.strictEqual(cleared, 3);
  assert.strictEqual(session.queue.length, 0);
});

test('M-12: clearQueue - returns 0 on empty queue', () => {
  musicService.getSession('guild_queue_empty');
  const cleared = musicService.clearQueue('guild_queue_empty');
  assert.strictEqual(cleared, 0);
});

test('M-13: remove - removes track at correct index', () => {
  const session = musicService.getSession('guild_remove_test');
  session.queue = [
    { title: 'Alpha' },
    { title: 'Beta'  },
    { title: 'Gamma' },
  ];
  const removed = musicService.remove('guild_remove_test', 2);
  assert.ok(removed);
  assert.strictEqual(removed.title, 'Beta');
  assert.strictEqual(session.queue.length, 2);
});

test('M-14: remove - returns null on invalid position', () => {
  const session = musicService.getSession('guild_remove_oob');
  session.queue = [{ title: 'Only Track' }];
  assert.strictEqual(musicService.remove('guild_remove_oob', 99), null);
  assert.strictEqual(musicService.remove('guild_remove_oob', 0), null);
});

test('M-15: move - reorders queue correctly', () => {
  const session = musicService.getSession('guild_move_test');
  session.queue = [
    { title: 'First'  },
    { title: 'Second' },
    { title: 'Third'  },
  ];
  const moved = musicService.move('guild_move_test', 1, 3);
  assert.ok(moved);
  assert.strictEqual(moved.title, 'First');
  assert.strictEqual(session.queue[2].title, 'First');
});

test('M-16: shuffle - randomizes queue in place', () => {
  const session = musicService.getSession('guild_shuffle_test');
  const originals = ['A','B','C','D','E','F','G','H'];
  session.queue = originals.map(t => ({ title: t }));
  musicService.shuffle('guild_shuffle_test');
  assert.strictEqual(session.queue.length, originals.length);
  const after = session.queue.map(t => t.title).sort();
  assert.deepStrictEqual(after, [...originals].sort());
});

// 4. Loop mode
test('M-17: setLoop - valid modes: off, track, queue', () => {
  musicService.getSession('guild_loop_test');
  assert.strictEqual(musicService.setLoop('guild_loop_test', 'track'), 'track');
  assert.strictEqual(musicService.setLoop('guild_loop_test', 'queue'), 'queue');
  assert.strictEqual(musicService.setLoop('guild_loop_test', 'off'), 'off');
});

// 5. Volume
test('M-18: setVolume - clamps between 1 and 100', () => {
  musicService.getSession('guild_volume_test');
  assert.strictEqual(musicService.setVolume('guild_volume_test', 75), 75);
  assert.strictEqual(musicService.setVolume('guild_volume_test', 0), 1);
  assert.strictEqual(musicService.setVolume('guild_volume_test', 200), 100);
});

// 6. Pause/Resume guards
test('M-19: pause - returns false when not playing', () => {
  musicService.getSession('guild_pause_test');
  assert.strictEqual(musicService.pause('guild_pause_test'), false);
});

test('M-20: resume - returns false when not paused', () => {
  musicService.getSession('guild_resume_test');
  assert.strictEqual(musicService.resume('guild_resume_test'), false);
});

// 7. Monitor
const musicMonitor = require('../src/music/musicUpdateMonitor');

test('M-21: logIncident - logs entries correctly', () => {
  const entry = musicMonitor.logIncident('INFO', 'TEST_ACTION', 'Unit test log entry', { testKey: 'value' });
  assert.strictEqual(entry.level, 'INFO');
  assert.strictEqual(entry.action, 'TEST_ACTION');
  assert.strictEqual(entry.message, 'Unit test log entry');
  assert.strictEqual(entry.metadata.testKey, 'value');
  assert.ok(entry.timestamp > 0);
});

test('M-22: getRecentLogs - returns up to limit entries', () => {
  for (let i = 0; i < 5; i++) musicMonitor.logIncident('INFO', `ACT_${i}`, `Log ${i}`);
  const logs = musicMonitor.getRecentLogs(3);
  assert.ok(logs.length <= 3);
});

test('M-23: getSystemHealth - returns correct structure', () => {
  const fakeSessions = new Map([
    ['g1', { isPlaying: true,  isPaused: false, queue: [1,2,3], connection: { state: { status: 'ready' } } }],
    ['g2', { isPlaying: false, isPaused: true,  queue: [1],     connection: null }],
  ]);
  const health = musicMonitor.getSystemHealth(fakeSessions);
  assert.strictEqual(health.totalSessions, 2);
  assert.strictEqual(health.activePlayingSessions, 1);
  assert.strictEqual(health.pausedSessions, 1);
  assert.strictEqual(health.totalQueuedTracks, 4);
  assert.ok(health.uptimeSec >= 0);
  assert.ok(typeof health.nodeVersion === 'string');
  assert.ok(typeof health.memoryRssMb === 'number');
});

test('M-24: getInstalledVersions - returns dependency map', () => {
  const versions = musicMonitor.getInstalledVersions();
  assert.ok(typeof versions === 'object');
  assert.ok('discord.js' in versions);
});

// 8. Multi-guild isolation
test('M-25: Multi-guild isolation - mutations in one guild do not affect another', () => {
  const sA = musicService.getSession('guild_iso_A');
  const sB = musicService.getSession('guild_iso_B');
  sA.queue.push({ title: 'Guild A Track' });
  sA.volume = 80;
  sA.loopMode = 'track';
  assert.strictEqual(sB.queue.length, 0);
  assert.strictEqual(sB.volume, 100);
  assert.strictEqual(sB.loopMode, 'off');
});

// 9. Favorites System
test('M-26: addFavorite stores track for user and rejects duplicates', () => {
  const gId = 'guild_fav_test_1_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const uId = 'user_fav_1';
  const track = { title: 'Starboy', artist: 'The Weeknd', durationSec: 230, source: 'soundcloud' };

  const res1 = musicService.addFavorite(gId, uId, track);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.track.title, 'Starboy');

  // Attempt duplicate
  const res2 = musicService.addFavorite(gId, uId, track);
  assert.strictEqual(res2.success, false);
  assert.ok(res2.message.includes('already in your favorites'));
});

test('M-27: removeFavorite removes by 1-based index or search query', () => {
  const gId = 'guild_fav_test_2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const uId = 'user_fav_2';
  musicService.addFavorite(gId, uId, { title: 'Song Alpha' });
  musicService.addFavorite(gId, uId, { title: 'Song Beta' });

  // Remove by index
  const r1 = musicService.removeFavorite(gId, uId, 1);
  assert.strictEqual(r1.success, true);

  // Remove by title
  const r2 = musicService.removeFavorite(gId, uId, 'Alpha');
  assert.strictEqual(r2.success, true);
});

test('M-28: getFavorites returns user list or empty array', () => {
  const favs = musicService.getFavorites('guild_non_existent', 'user_none');
  assert.ok(Array.isArray(favs));
  assert.strictEqual(favs.length, 0);
});

// 10. Search Cache
test('M-29: searchCache stores and retrieves results accurately', () => {
  const results = [{ title: 'Result 1' }, { title: 'Result 2' }];
  musicService.setSearchCache('g_cache', 'u_cache', results);
  const fetched = musicService.getSearchCache('g_cache', 'u_cache');
  assert.ok(fetched);
  assert.strictEqual(fetched.length, 2);
  assert.strictEqual(fetched[0].title, 'Result 1');
});

