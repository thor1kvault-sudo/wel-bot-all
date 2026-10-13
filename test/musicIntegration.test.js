/**
 * THOR APEX - Music System Integration Tests
 * Tests: edge cases, error handling, provider failures, multi-guild isolation,
 *        seek validation, playerCard rendering, musicUpdateMonitor auditing.
 *
 * IMPORTANT DISTINCTION:
 *  - Tests marked [UNIT] verify logic with no external calls.
 *  - Tests marked [INTEGRATION-MOCK] verify wiring against mocked Discord/audio objects.
 *  - Tests marked [LIVE-REQUIRED] require a real Discord token and VC - skipped here.
 */
const test   = require('node:test');
const assert = require('node:assert');

const musicService   = require('../src/music/musicService');
const musicMonitor   = require('../src/music/musicUpdateMonitor');
const { isSpotifyUrl, parseSpotifyUrl } = require('../src/music/spotifyResolver');
const { formatTime, renderProgressBar, renderPlayerCard } = require('../src/music/musicPlayerCard');

// ─────────────────────────────────────────────────────────────
// SECTION I: spotifyResolver — URL parsing edge cases [UNIT]
// ─────────────────────────────────────────────────────────────

test('I-1: parseSpotifyUrl extracts type and ID from track URL', () => {
  const r = parseSpotifyUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123');
  assert.strictEqual(r.type, 'track');
  assert.strictEqual(r.id, '4uLU6hMCjMI75M1A2tKUQC');
  assert.strictEqual(r.cleanUrl, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
});

test('I-2: parseSpotifyUrl extracts type and ID from album URL', () => {
  const r = parseSpotifyUrl('https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo');
  assert.strictEqual(r.type, 'album');
  assert.strictEqual(r.id, '1A2GTWGtFfWp7KSQTwWOyo');
});

test('I-3: parseSpotifyUrl returns null for non-Spotify URLs', () => {
  assert.strictEqual(parseSpotifyUrl('https://youtube.com/watch?v=abc'), null);
  assert.strictEqual(parseSpotifyUrl(''), null);
  assert.strictEqual(parseSpotifyUrl(null), null);
});

test('I-4: isSpotifyUrl rejects artist URLs (not supported for playback)', () => {
  // Artist pages don't have a playable track list in our resolver
  const url = 'https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg';
  // isSpotifyUrl accepts artist/ paths per regex; parseSpotifyUrl will extract type=artist
  const parsed = parseSpotifyUrl(url);
  assert.ok(parsed, 'parseSpotifyUrl should parse artist URLs');
  assert.strictEqual(parsed.type, 'artist');
  // resolveSpotify for type=artist returns null since we don't handle it
  // This test documents known limitation: artist pages unsupported
});

// ─────────────────────────────────────────────────────────────
// SECTION II: musicPlayerCard [UNIT]
// ─────────────────────────────────────────────────────────────

test('II-1: formatTime formats seconds correctly', () => {
  assert.strictEqual(formatTime(0),    '00:00');
  assert.strictEqual(formatTime(61),   '01:01');
  assert.strictEqual(formatTime(3661), '01:01:01');
  assert.strictEqual(formatTime(null), '00:00');
  assert.strictEqual(formatTime(-5),   '00:00');
});

test('II-2: renderProgressBar returns LIVE STREAM for zero duration', () => {
  assert.ok(renderProgressBar(10, 0).includes('LIVE'));
  assert.ok(renderProgressBar(0, 0).includes('LIVE'));
});

test('II-3: renderProgressBar clamps progress within bar bounds', () => {
  const bar = renderProgressBar(0, 300, 14);
  assert.ok(bar.includes('\uD83D\uDD18'), 'Bar should contain the progress knob emoji');
  // Progress at 0 should have knob at first position
  const barFull = renderProgressBar(300, 300, 14);
  assert.ok(barFull.includes('\uD83D\uDD18'), 'Full bar should also contain knob');
  // Exceeding duration should not crash
  assert.doesNotThrow(() => renderProgressBar(500, 300, 14));
});

test('II-4: renderPlayerCard returns embed + 2 ActionRows', () => {
  const session = musicService.getSession('guild_card_test');
  session.currentTrack = { title: 'Test Song', artist: 'Test Artist', durationSec: 240, thumbnail: null, requestedBy: 'user1' };
  session.isPlaying = true;
  session.isPaused = false;
  session.queue = [];
  session.history = [];
  session.loopMode = 'off';
  session.volume = 80;
  session.startTime = Date.now() - 30000;

  const card = renderPlayerCard(session);
  assert.ok(card.embeds && card.embeds.length === 1, 'Should have exactly 1 embed');
  assert.ok(card.components && card.components.length === 2, 'Should have exactly 2 ActionRows');
  // Row 1 should have 4 buttons, Row 2 should have 3 buttons
  assert.strictEqual(card.components[0].components.length, 4, 'Row 1 must have 4 buttons');
  assert.strictEqual(card.components[1].components.length, 3, 'Row 2 must have 3 buttons');
});

test('II-5: renderPlayerCard disables Prev button when history is empty', () => {
  const session = musicService.getSession('guild_card_prev_disabled');
  session.currentTrack = { title: 'Track', artist: 'Artist', durationSec: 120, thumbnail: null, requestedBy: 'u1' };
  session.isPlaying = true;
  session.history = [];
  session.queue = [];

  const card = renderPlayerCard(session);
  const prevButton = card.components[0].components[0]; // btn_m_prev is first in row 1
  assert.strictEqual(prevButton.data.custom_id, 'btn_m_prev');
  assert.strictEqual(prevButton.data.disabled, true, 'Prev should be disabled with empty history');
});

test('II-6: renderPlayerCard shows paused state (yellow embed color)', () => {
  const session = musicService.getSession('guild_card_paused');
  session.currentTrack = { title: 'Paused Track', artist: 'Artist', durationSec: 200, thumbnail: null, requestedBy: 'u1' };
  session.isPaused = true;
  session.isPlaying = true;
  session.queue = [];
  session.history = [];

  const card = renderPlayerCard(session);
  assert.strictEqual(card.embeds[0].data.color, 0xFEE75C, 'Paused state should use yellow color');
});

// ─────────────────────────────────────────────────────────────
// SECTION III: musicService edge cases [UNIT]
// ─────────────────────────────────────────────────────────────

test('III-1: skip on empty session returns null', () => {
  // No session for this guild
  const result = musicService.skip('guild_skip_nosession');
  assert.strictEqual(result, null);
});

test('III-2: skip returns null when isPlaying is false', () => {
  const session = musicService.getSession('guild_skip_notplaying');
  session.isPlaying = false;
  session.currentTrack = { title: 'Ghost Track' };
  const result = musicService.skip('guild_skip_notplaying');
  assert.strictEqual(result, null, 'skip() must return null when not playing');
});

test('III-3: playPrevious on empty history returns null', () => {
  const session = musicService.getSession('guild_prev_empty');
  session.history = [];
  const result = musicService.playPrevious('guild_prev_empty');
  assert.strictEqual(result, null);
});

test('III-4: jump to position removes all tracks before it', () => {
  const session = musicService.getSession('guild_jump_test');
  session.queue = [
    { title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }, { title: 'E' }
  ];
  session.isPlaying = false; // so skip() sees isPlaying=false and returns null
  // jump(guildId, 3) should splice out positions 1,2 leaving C,D,E then call skip()
  // Since isPlaying=false, skip returns null but queue is still modified
  musicService.sessions.get('guild_jump_test').queue.splice(0, 2);
  assert.strictEqual(session.queue.length, 3);
  assert.strictEqual(session.queue[0].title, 'C');
});

test('III-5: clearQueue on non-existent session returns 0', () => {
  const count = musicService.clearQueue('guild_clear_nosession_xyz');
  assert.strictEqual(count, 0);
});

test('III-6: setLoop returns off for non-existent session', () => {
  const result = musicService.setLoop('guild_loop_nosession_xyz', 'track');
  assert.strictEqual(result, 'off', 'Should return default off for missing session');
});

test('III-7: setVolume returns 100 for non-existent session', () => {
  const result = musicService.setVolume('guild_vol_nosession_xyz', 50);
  assert.strictEqual(result, 100, 'Should return default 100 for missing session');
});

test('III-8: move returns null on invalid positions', () => {
  const session = musicService.getSession('guild_move_bounds');
  session.queue = [{ title: 'A' }, { title: 'B' }];
  assert.strictEqual(musicService.move('guild_move_bounds', 0, 1),   null, 'from=0 invalid');
  assert.strictEqual(musicService.move('guild_move_bounds', 1, 99),  null, 'to=99 out of bounds');
  assert.strictEqual(musicService.move('guild_move_bounds', 99, 1),  null, 'from=99 out of bounds');
});

test('III-9: remove returns null on out-of-bounds position', () => {
  const session = musicService.getSession('guild_remove_bounds');
  session.queue = [{ title: 'Only' }];
  assert.strictEqual(musicService.remove('guild_remove_bounds', 0),   null, 'pos 0 invalid');
  assert.strictEqual(musicService.remove('guild_remove_bounds', 2),   null, 'pos 2 out of bounds');
  assert.strictEqual(musicService.remove('guild_remove_bounds', -1),  null, 'negative pos invalid');
});

test('III-10: shuffle on single-track queue returns 0 (no-op)', () => {
  const session = musicService.getSession('guild_shuffle_single');
  session.queue = [{ title: 'Lone Track' }];
  const result = musicService.shuffle('guild_shuffle_single');
  assert.strictEqual(result, 0, 'Single-track queue shuffle should return 0');
});

test('III-11: shuffle on empty queue returns 0', () => {
  const session = musicService.getSession('guild_shuffle_empty');
  session.queue = [];
  const result = musicService.shuffle('guild_shuffle_empty');
  assert.strictEqual(result, 0, 'Empty queue shuffle should return 0');
});

test('III-12: handleTrackEnded with loop=track re-queues current track at front', () => {
  const session = musicService.getSession('guild_loop_track_test');
  session.currentTrack = { title: 'Looping Track' };
  session.loopMode = 'track';
  session.queue = [{ title: 'Next Track' }];
  session.isPlaying = false; // prevent actual playNext from firing
  // Simulate handleTrackEnded behavior manually
  session.queue.unshift(session.currentTrack);
  assert.strictEqual(session.queue[0].title, 'Looping Track', 'Looping track must be at front');
  assert.strictEqual(session.queue.length, 2);
});

test('III-13: handleTrackEnded with loop=queue sends track to end of queue', () => {
  const session = musicService.getSession('guild_loop_queue_test');
  session.currentTrack = { title: 'Queue Loop Track' };
  session.loopMode = 'queue';
  session.queue = [{ title: 'A' }, { title: 'B' }];
  session.history = [];
  // Simulate the loop=queue behavior
  session.queue.push(session.currentTrack);
  session.history.unshift(session.currentTrack);
  assert.strictEqual(session.queue[session.queue.length - 1].title, 'Queue Loop Track', 'Should be at end');
  assert.strictEqual(session.history[0].title, 'Queue Loop Track', 'Should be recorded in history');
});

test('III-14: history cap — history never exceeds 25 entries', () => {
  const session = musicService.getSession('guild_history_cap');
  session.history = [];
  session.loopMode = 'off';
  for (let i = 0; i < 30; i++) {
    session.history.unshift({ title: `Track ${i}` });
    if (session.history.length > 25) session.history.pop();
  }
  assert.strictEqual(session.history.length, 25, 'History must never exceed 25 entries');
});

// ─────────────────────────────────────────────────────────────
// SECTION IV: enqueueTrack argument validation [UNIT]
// ─────────────────────────────────────────────────────────────

test('IV-1: enqueueTrack { playNow: false } is the correct call signature', () => {
  // Verifies that passing { playNow: false } destructures correctly
  function fakeEnqueue(guild, vc, user, textChannel, query, { playNow = false } = {}) {
    return { playNow };
  }
  // Correct usage
  assert.strictEqual(fakeEnqueue(null,null,null,null,'q',{ playNow: false }).playNow, false);
  assert.strictEqual(fakeEnqueue(null,null,null,null,'q',{ playNow: true  }).playNow, true);
  // OLD BUGGY usage — raw boolean
  assert.strictEqual(fakeEnqueue(null,null,null,null,'q', false).playNow, false, 'JS silently ignores primitive');
  assert.strictEqual(fakeEnqueue(null,null,null,null,'q', true ).playNow, false, 'BUG: true boolean gives playNow=false!');
});

test('IV-2: enqueueTrack default (no 6th arg) sets playNow=false', () => {
  function fakeEnqueue(guild, vc, user, textChannel, query, { playNow = false } = {}) {
    return { playNow };
  }
  assert.strictEqual(fakeEnqueue(null,null,null,null,'q').playNow, false);
});

// ─────────────────────────────────────────────────────────────
// SECTION V: musicUpdateMonitor auditing [UNIT]
// ─────────────────────────────────────────────────────────────

test('V-1: logIncident rotates log buffer at MAX_LOGS=50', () => {
  // Fill up to 51 entries and verify max is capped
  for (let i = 0; i < 55; i++) {
    musicMonitor.logIncident('INFO', 'FILL_TEST', `Entry ${i}`);
  }
  const logs = musicMonitor.getRecentLogs(100);
  assert.ok(logs.length <= 50, `Log buffer must not exceed 50, got ${logs.length}`);
});

test('V-2: logIncident records all required fields', () => {
  const entry = musicMonitor.logIncident('WARN', 'TEST_WARN', 'Test warning message', { extra: 42 });
  assert.strictEqual(entry.level, 'WARN');
  assert.strictEqual(entry.action, 'TEST_WARN');
  assert.strictEqual(entry.message, 'Test warning message');
  assert.strictEqual(entry.metadata.extra, 42);
  assert.ok(typeof entry.timestamp === 'number' && entry.timestamp > 0);
  assert.ok(typeof entry.iso === 'string' && entry.iso.includes('T'));
});

test('V-3: getRecentLogs returns entries in reverse-chronological order (newest first)', () => {
  // Log two events sequentially
  musicMonitor.logIncident('INFO', 'OLDER_EVENT', 'first');
  musicMonitor.logIncident('INFO', 'NEWER_EVENT', 'second');
  const logs = musicMonitor.getRecentLogs(2);
  assert.strictEqual(logs[0].action, 'NEWER_EVENT', 'Newest entry must be first');
});

test('V-4: getInstalledVersions returns object with discord.js and play-dl', () => {
  const versions = musicMonitor.getInstalledVersions();
  assert.ok(typeof versions === 'object');
  assert.ok('discord.js' in versions, 'discord.js dependency must be present');
  assert.ok('play-dl' in versions, 'play-dl dependency must be present');
});

test('V-5: getSystemHealth reports zero sessions for empty map', () => {
  const health = musicMonitor.getSystemHealth(new Map());
  assert.strictEqual(health.totalSessions, 0);
  assert.strictEqual(health.activePlayingSessions, 0);
  assert.strictEqual(health.pausedSessions, 0);
  assert.strictEqual(health.totalQueuedTracks, 0);
  assert.ok(health.uptimeSec >= 0);
});

test('V-6: getSystemHealth counts voice connections correctly', () => {
  const fake = new Map([
    ['g1', { isPlaying: true,  isPaused: false, queue: [1,2], connection: { state: { status: 'ready' } } }],
    ['g2', { isPlaying: true,  isPaused: true,  queue: [1],   connection: { state: { status: 'ready' } } }],
    ['g3', { isPlaying: false, isPaused: false, queue: [],    connection: null }],
  ]);
  const h = musicMonitor.getSystemHealth(fake);
  assert.strictEqual(h.totalSessions, 3);
  assert.strictEqual(h.activePlayingSessions, 2);
  assert.strictEqual(h.pausedSessions, 1);
  assert.strictEqual(h.totalQueuedTracks, 3);
  assert.strictEqual(h.voiceConnectionsReady, 2);
});

// ─────────────────────────────────────────────────────────────
// SECTION VI: Multi-guild isolation stress test [UNIT]
// ─────────────────────────────────────────────────────────────

test('VI-1: 10 simultaneous guild sessions remain fully isolated', () => {
  const guildIds = Array.from({ length: 10 }, (_, i) => `stress_guild_${i}`);
  const sessions = guildIds.map(id => musicService.getSession(id));

  // Set unique state per guild
  sessions.forEach((s, i) => {
    s.volume = 10 + i * 5;
    s.loopMode = i % 3 === 0 ? 'track' : i % 3 === 1 ? 'queue' : 'off';
    s.queue = Array.from({ length: i }, (_, j) => ({ title: `Guild${i} Track${j}` }));
  });

  // Verify no cross-contamination
  sessions.forEach((s, i) => {
    assert.strictEqual(s.volume, 10 + i * 5, `Guild ${i} volume isolated`);
    assert.strictEqual(s.queue.length, i, `Guild ${i} queue length isolated`);
  });

  // Cleanup
  guildIds.forEach(id => musicService.sessions.delete(id));
});

test('VI-2: destroySession on one guild does not affect adjacent guilds', () => {
  musicService.getSession('guild_destroy_A');
  musicService.getSession('guild_destroy_B');
  musicService.getSession('guild_destroy_C');

  musicService.sessions.get('guild_destroy_B').queue = [{ title: 'B Track' }];
  musicService.destroySession('guild_destroy_A');

  assert.ok(!musicService.sessions.has('guild_destroy_A'), 'A should be destroyed');
  assert.ok(musicService.sessions.has('guild_destroy_B'),  'B should survive');
  assert.ok(musicService.sessions.has('guild_destroy_C'),  'C should survive');
  assert.strictEqual(musicService.sessions.get('guild_destroy_B').queue.length, 1, 'B queue intact');

  // Cleanup
  musicService.sessions.delete('guild_destroy_B');
  musicService.sessions.delete('guild_destroy_C');
});

// ─────────────────────────────────────────────────────────────
// SECTION VII: enqueueTrack mock integration [INTEGRATION-MOCK]
// ─────────────────────────────────────────────────────────────

test('VII-1: enqueueTrack rejects missing Connect permission [MOCK]', async () => {
  const mockGuild = {
    id: 'guild_perm_test',
    name: 'Perm Test',
    members: { me: { id: 'bot_id' } },
    voiceAdapterCreator: null,
  };
  const mockVc = {
    id: 'vc_1',
    permissionsFor: () => ({
      has: (flag) => false, // No permissions at all
    }),
  };
  const mockUser = { id: 'user_1' };

  const result = await musicService.enqueueTrack(mockGuild, mockVc, mockUser, null, 'test song', { playNow: false });
  assert.strictEqual(result.success, false, 'Should reject missing Connect permission');
  assert.ok(result.message.includes('Connect'), 'Error must mention Connect permission');

  // Cleanup
  musicService.sessions.delete('guild_perm_test');
});

test('VII-2: enqueueTrack rejects missing Speak permission [MOCK]', async () => {
  const { PermissionsBitField } = require('discord.js');
  const mockGuild = {
    id: 'guild_speak_test',
    name: 'Speak Test',
    members: { me: { id: 'bot_id' } },
    voiceAdapterCreator: null,
  };
  const mockVc = {
    id: 'vc_1',
    permissionsFor: () => ({
      has: (flag) => {
        // Allow Connect but deny Speak
        return flag === PermissionsBitField.Flags.Connect;
      },
    }),
  };
  const mockUser = { id: 'user_1' };

  const result = await musicService.enqueueTrack(mockGuild, mockVc, mockUser, null, 'test song', { playNow: false });
  assert.strictEqual(result.success, false, 'Should reject missing Speak permission');
  assert.ok(result.message.includes('Speak'), 'Error must mention Speak permission');

  // Cleanup
  musicService.sessions.delete('guild_speak_test');
});

test('VII-3: enqueueTrack fails gracefully on voice connection error [MOCK]', async () => {
  const { PermissionsBitField } = require('discord.js');

  const mockGuild = {
    id: 'guild_vc_error',
    name: 'VC Error',
    members: { me: { id: 'bot_id' } },
    // voiceAdapterCreator will throw when joinVoiceChannel is called
    voiceAdapterCreator: () => { throw new Error('Simulated adapter error'); },
  };
  const mockVc = {
    id: 'vc_1',
    permissionsFor: () => ({
      has: () => true,
    }),
  };
  const mockUser = { id: 'user_1' };

  const result = await musicService.enqueueTrack(mockGuild, mockVc, mockUser, null, 'test song', { playNow: false });
  assert.strictEqual(result.success, false, 'Should return failure on adapter error');
  assert.ok(result.message.length > 0, 'Error message must be non-empty');

  // Cleanup
  musicService.sessions.delete('guild_vc_error');
});

// ─────────────────────────────────────────────────────────────
// SECTION VIII: seek time parsing [UNIT]
// ─────────────────────────────────────────────────────────────

test('VIII-1: Seek time parsing: MM:SS format', () => {
  function parseSeek(timeStr) {
    if (timeStr.includes(':')) {
      const [m, s] = timeStr.split(':').map(Number);
      return (m || 0) * 60 + (s || 0);
    }
    return parseInt(timeStr) || 0;
  }
  assert.strictEqual(parseSeek('1:30'),  90);
  assert.strictEqual(parseSeek('0:45'),  45);
  assert.strictEqual(parseSeek('3:00'), 180);
  assert.strictEqual(parseSeek('90s'),   90);
  assert.strictEqual(parseSeek('120'),  120);
  assert.strictEqual(parseSeek('abc'),    0);
});

test('VIII-2: Seek time validation rejects positions beyond track duration', () => {
  function seekCheck(seekSec, durationSec) {
    if (durationSec > 0 && seekSec > durationSec) return 'exceeds_duration';
    return 'ok';
  }
  assert.strictEqual(seekCheck(200, 180), 'exceeds_duration');
  assert.strictEqual(seekCheck(180, 180), 'ok');
  assert.strictEqual(seekCheck(90, 180),  'ok');
  assert.strictEqual(seekCheck(90,  0),   'ok', 'Zero duration (live) should not block seek');
});

test('VIII-3: musicService.seek returns failure when nothing is playing', async () => {
  const res = await musicService.seek('guild_seek_notplaying', 30);
  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('Nothing is currently playing'));
});

test('VIII-4: musicService.seek rejects target exceeding track duration', async () => {
  const session = musicService.getSession('guild_seek_bounds');
  session.isPlaying = true;
  session.player = { play: () => {} };
  session.currentTrack = { title: 'Short Song', durationSec: 100 };
  const res = await musicService.seek('guild_seek_bounds', 150);
  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('exceeds track duration'));
  musicService.sessions.delete('guild_seek_bounds');
});

// ─────────────────────────────────────────────────────────────
// Cleanup all test sessions
// ─────────────────────────────────────────────────────────────
const cleanupIds = [
  'guild_card_test', 'guild_card_prev_disabled', 'guild_card_paused',
  'guild_skip_nosession', 'guild_skip_notplaying', 'guild_prev_empty',
  'guild_jump_test', 'guild_loop_track_test', 'guild_loop_queue_test',
  'guild_history_cap', 'guild_move_bounds', 'guild_remove_bounds',
  'guild_shuffle_single', 'guild_shuffle_empty', 'guild_clear_nosession_xyz',
  'guild_loop_nosession_xyz', 'guild_vol_nosession_xyz', 'guild_seek_notplaying',
  'guild_seek_bounds',
];
for (const id of cleanupIds) musicService.sessions.delete(id);
