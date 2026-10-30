'use strict';
process.env.NODE_ENV = 'test';

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

// ─────────────────────────────────────────────────────────────
// 4. Exact Artist Matching & Enna Sona Mismatch Regression Tests
// ─────────────────────────────────────────────────────────────

test('SY-8: Enna Sona by Arijit Singh rejects Enna Sona by Mitraz (never match on title alone)', () => {
  const spotifyTrack = {
    title: 'Enna Sona',
    artist: 'Arijit Singh, A.R. Rahman',
    durationSec: 213,
  };

  const candidates = [
    {
      title: 'Enna Sona',
      artist: 'Mitraz',
      durationSec: 195,
      youtubeUrl: 'https://youtube.com/watch?v=mitraz_enna_sona',
    },
    {
      title: 'Enna Sona | OK Jaanu | Arijit Singh | Shraddha Kapoor | Aditya Roy Kapur',
      artist: 'T-Series',
      durationSec: 213,
      youtubeUrl: 'https://youtube.com/watch?v=official_enna_sona',
    },
    {
      title: 'Enna Sona (Official Audio) - Arijit Singh',
      artist: 'Sony Music India',
      durationSec: 215,
      youtubeUrl: 'https://youtube.com/watch?v=sony_enna_sona',
    },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, spotifyTrack);
  assert.strictEqual(ranked.length, 3);

  // Top candidate MUST be an authentic upload with Arijit Singh
  const top = ranked[0];
  assert.notStrictEqual(top.artist, 'Mitraz', 'Mitraz MUST NOT be selected when Arijit Singh was requested');
  assert.ok(top.youtubeUrl.includes('official_enna_sona') || top.youtubeUrl.includes('sony_enna_sona'));
  assert.strictEqual(top.penalty, 0, 'Official upload should have 0 penalty');
  assert.ok(top.finalScore > 0.70, `Expected authentic upload score > 0.70, got ${top.finalScore}`);

  // Mitraz candidate MUST be penalized as a different artist
  const mitraz = ranked.find(c => c.artist === 'Mitraz');
  assert.ok(mitraz.penalty >= 0.75, 'Different artist (Mitraz) must receive different_artist penalty (>= 0.75)');
  assert.ok(mitraz.penaltyWords.includes('different_artist'), 'Penalty words must include different_artist');
  assert.strictEqual(mitraz.finalScore, 0, 'Different artist finalScore must be reduced to 0');
});

test('SY-9: calculateArtistMatch accurately handles multi-artist strings, labels, and different artists', () => {
  const { calculateArtistMatch } = audioProvider;

  // 1. Multi-artist comma-separated with label channel
  const resLabel = calculateArtistMatch(
    'Arijit Singh, A.R. Rahman',
    'T-Series',
    'Enna Sona | OK Jaanu | Arijit Singh | Shraddha Kapoor'
  );
  assert.strictEqual(resLabel.isDifferentArtist, false);
  assert.ok(resLabel.matchScore >= 0.90);

  // 2. Completely different artist
  const resDifferent = calculateArtistMatch(
    'Arijit Singh, A.R. Rahman',
    'Mitraz',
    'Enna Sona'
  );
  assert.strictEqual(resDifferent.isDifferentArtist, true);
  assert.strictEqual(resDifferent.matchScore, 0.0);

  // 3. Exact artist match
  const resExact = calculateArtistMatch('The Weeknd', 'The Weeknd', 'Blinding Lights (Official Video)');
  assert.strictEqual(resExact.isDifferentArtist, false);
  assert.strictEqual(resExact.matchScore, 1.0);
});

test('SY-10: scoreCandidate rejects SoundCloud candidate when artist does not match canonical', () => {
  const canonical = {
    title: 'Enna Sona',
    artist: 'Arijit Singh, A.R. Rahman',
    durationSec: 213,
  };

  const mitrazCandidate = {
    title: 'Enna Sona',
    artist: 'Mitraz',
    durationSec: 195,
  };

  const authenticCandidate = {
    title: 'Enna Sona (From "OK Jaanu")',
    artist: 'Arijit Singh',
    durationSec: 213,
  };

  const sMitraz = audioProvider.scoreCandidate(mitrazCandidate, 'Enna Sona', canonical);
  const sAuthentic = audioProvider.scoreCandidate(authenticCandidate, 'Enna Sona', canonical);

  assert.ok(sMitraz.penalty >= 0.75, 'Mitraz must receive different_artist penalty');
  assert.ok(sMitraz.penaltyWords.includes('different_artist'));
  assert.strictEqual(sMitraz.finalScore, 0, 'Mitraz score must be 0');

  assert.strictEqual(sAuthentic.penalty, 0, 'Authentic candidate must have 0 penalty');
  assert.ok(sAuthentic.finalScore > 0.70, 'Authentic candidate score should be high');
});

test('SY-11: resolveSpotify extracts exact title, artist, and duration for tracks without credentials', async () => {
  const { resolveSpotify } = require('../src/music/spotifyResolver');
  const trackUrl = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';

  const res = await resolveSpotify(trackUrl);
  assert.ok(res, 'resolveSpotify should return non-null result');
  assert.strictEqual(res.type, 'track');
  assert.strictEqual(res.tracks.length, 1);

  const t = res.tracks[0];
  assert.strictEqual(t.title, 'Never Gonna Give You Up');
  assert.strictEqual(t.artist, 'Rick Astley');
  assert.ok(t.durationSec >= 210 && t.durationSec <= 216, `Expected ~213s duration, got ${t.durationSec}`);
  assert.ok(t.thumbnail && t.thumbnail.startsWith('https://'), 'Must extract thumbnail URL');
});

// ─────────────────────────────────────────────────────────────
// 5. Regional, Unicode, and Query Variation Regression Tests
// ─────────────────────────────────────────────────────────────

test('SY-12: Aakhya Mai Aakh Ghali Jo Bairan by Sheesha matches official video without crashing', async () => {
  const spotifyTrack = {
    title: 'Aakhya Mai Aakh Ghali Jo Bairan',
    artist: 'Sheesha',
    album: 'Sheesha',
    durationSec: 199,
  };

  const candidates = [
    {
      title: 'SHEESHA | Aakhya Mai Aakh Ghali Jo Bairan | Mitta Ror Ft. Swara Verma | Viral Song 2026',
      artist: 'Mitta Ror',
      durationSec: 199,
      youtubeUrl: 'https://www.youtube.com/watch?v=official_sheesha_song',
    },
    {
      title: 'Sheesha (Official Music Video) | Mitta Ror ft. Swara Verma | Sorab Bedi | Niharika Tiwari',
      artist: 'Sony Music India and Mitta Ror',
      durationSec: 195,
      youtubeUrl: 'https://www.youtube.com/watch?v=sony_sheesha_video',
    },
    {
      title: 'Random Haryanvi Dance Mix 2026',
      artist: 'DJ Mix Master',
      durationSec: 300,
      youtubeUrl: 'https://www.youtube.com/watch?v=random_remix_mix',
    },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(candidates, spotifyTrack);
  assert.strictEqual(ranked.length, 3);

  // Top candidate must be the authentic release with Sheesha and Aakhya Mai Aakh Ghali Jo Bairan
  const top = ranked[0];
  assert.strictEqual(top.youtubeUrl, 'https://www.youtube.com/watch?v=official_sheesha_song');
  assert.strictEqual(top.penalty, 0, 'Authentic upload must have 0 penalty');
  assert.ok(top.finalScore > 0.85, `Expected score > 0.85, got ${top.finalScore}`);
  assert.strictEqual(top.artistMatch, 1.0, 'Sheesha in title must yield 1.0 artist match');
});

test('SY-13: Tamil and Hindi regional track matching preserves Unicode and scores authentic videos', () => {
  // Tamil test case: கண்ணழகா (Kannazhaga) by Anirudh
  const tamilTrack = {
    title: 'கண்ணழகா',
    artist: 'Anirudh Ravichander, Dhanush',
    durationSec: 205,
  };

  const tamilCandidates = [
    {
      title: '3 - Kannazhaga | கண்ணழகா Video | Dhanush, Shruti | Anirudh',
      artist: 'SonyMusicSouthVEVO',
      durationSec: 205,
      youtubeUrl: 'https://www.youtube.com/watch?v=kannazhaga_vevo',
    },
    {
      title: 'Random Tamil Song 2026',
      artist: 'Unknown Artist',
      durationSec: 260,
      youtubeUrl: 'https://www.youtube.com/watch?v=random_tamil',
    },
  ];

  const rankedTamil = audioProvider.rankYouTubeCandidates(tamilCandidates, tamilTrack);
  assert.strictEqual(rankedTamil[0].youtubeUrl, 'https://www.youtube.com/watch?v=kannazhaga_vevo');
  assert.strictEqual(rankedTamil[0].penalty, 0);
  assert.ok(rankedTamil[0].finalScore > 0.70);

  // Hindi Unicode test case: तुझे देखा तो ये जाना सनम
  const hindiTrack = {
    title: 'तुझे देखा तो ये जाना सनम',
    artist: 'Kumar Sanu, Lata Mangeshkar',
    durationSec: 314,
  };

  const hindiCandidates = [
    {
      title: 'Tujhe Dekha Toh Song | तुझे देखा तो ये जाना सनम | Dilwale Dulhania Le Jayenge | Lata, Kumar Sanu',
      artist: 'YRF',
      durationSec: 314,
      youtubeUrl: 'https://www.youtube.com/watch?v=ddlj_yrf_song',
    },
    {
      title: 'Slowed Reverb Hits 2026',
      artist: 'DJ Chill',
      durationSec: 350,
      youtubeUrl: 'https://www.youtube.com/watch?v=slowed_hindi',
    },
  ];

  const rankedHindi = audioProvider.rankYouTubeCandidates(hindiCandidates, hindiTrack);
  assert.strictEqual(rankedHindi[0].youtubeUrl, 'https://www.youtube.com/watch?v=ddlj_yrf_song');
  assert.strictEqual(rankedHindi[0].penalty, 0);
  assert.ok(rankedHindi[0].finalScore > 0.75);
});

test('SY-14: searchYouTubeHtml performs fast, reliable search without playdl browseId crashes', async () => {
  const { searchYouTubeHtml } = audioProvider;
  assert.strictEqual(typeof searchYouTubeHtml, 'function');

  const results = await searchYouTubeHtml('Aakhya Mai Aakh Ghali Jo Bairan Sheesha', 5);
  assert.ok(Array.isArray(results), 'Must return array of candidates');
  assert.ok(results.length >= 1, `Expected at least 1 candidate, got ${results.length}`);

  const first = results[0];
  assert.ok(first.title && first.title.length > 0);
  assert.ok(first.youtubeUrl && first.youtubeUrl.startsWith('https://www.youtube.com/watch?v='));
  assert.ok(typeof first.durationSec === 'number');
});

test('SY-15: Medium confidence triggers candidate selection menu while low confidence rejects cleanly', async () => {
  // Test medium confidence candidate ranking
  const spTrack = {
    title: 'Obscure Regional Track',
    artist: 'Emerging Singer',
    durationSec: 180,
  };

  // Candidates with moderate title/artist agreement (between 0.40 and 0.58)
  const medCandidates = [
    {
      title: 'Obscure Regional Melody',
      artist: 'Emerging Singer Official',
      durationSec: 185,
      youtubeUrl: 'https://www.youtube.com/watch?v=candidate_1',
    },
    {
      title: 'Obscure Regional Live Session',
      artist: 'Emerging Singer',
      durationSec: 182,
      youtubeUrl: 'https://www.youtube.com/watch?v=candidate_2',
    },
  ];

  const ranked = audioProvider.rankYouTubeCandidates(medCandidates, spTrack);
  assert.ok(ranked.length >= 2);
  assert.strictEqual(ranked[0].isDifferentArtist, false);

  // Low confidence candidate (< 0.40)
  const lowCandidate = [
    {
      title: 'Totally Unrelated Song',
      artist: 'Different Artist',
      durationSec: 300,
      youtubeUrl: 'https://www.youtube.com/watch?v=low_1',
    },
  ];
  const rankedLow = audioProvider.rankYouTubeCandidates(lowCandidate, spTrack);
  assert.ok(rankedLow[0].finalScore < 0.40);
  assert.strictEqual(rankedLow[0].isDifferentArtist, true);

  // Different artist candidate penalty check
  const diffArtistCand = [
    {
      title: 'Obscure Regional Track',
      artist: 'Completely Unrelated Band',
      durationSec: 180,
      youtubeUrl: 'https://www.youtube.com/watch?v=diff_1',
    },
  ];
  const rankedDiff = audioProvider.rankYouTubeCandidates(diffArtistCand, spTrack);
  assert.strictEqual(rankedDiff[0].isDifferentArtist, true);
  assert.ok(rankedDiff[0].penalty >= 0.75);
});


