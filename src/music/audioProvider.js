'use strict';
/**
 * THOR APEX — Audio Provider v3.0
 *
 * VERIFIED LIVE STATUS (2026-10-13):
 *   ✅ SoundCloud search       — play-dl getFreeClientID() + search() WORKING
 *   ✅ SoundCloud streaming    — play-dl.stream() WORKING (type: arbitrary)
 *   ✅ Spotify oEmbed          — WORKING (no API key needed for single tracks)
 *   ✅ Direct HTTP streams     — Supported (Zeno.fm, mp3 URLs, etc.)
 *   ❌ YouTube streaming       — BLOCKED (HTTP 403 from Google CDN — both play-dl and ytdl-core)
 *   ❌ YouTube audio extraction — BLOCKED
 *
 * Architecture:
 *   1. Text queries → SoundCloud search (primary)
 *   2. SoundCloud URLs → direct stream
 *   3. Spotify URLs → metadata only (resolveSpotify) → SoundCloud fuzzy match → stream
 *   4. YouTube URLs → metadata via play-dl → SoundCloud fuzzy match → stream
 *      (YouTube streaming is BLOCKED; we resolve metadata and find the best SoundCloud equivalent)
 *   5. Direct audio URLs → ffmpeg arbitrary stream
 *
 * Seeking: supported for SoundCloud + direct URLs via ffmpeg -ss injection.
 */

const { spawn }    = require('child_process');
const { StreamType } = require('@discordjs/voice');
const playdl       = require('play-dl');

/* ── Optional deps loaded defensively ─────────────────────────── */
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath && !process.env.FFMPEG_PATH) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }
} catch (_) {}

/* ── SoundCloud client state ───────────────────────────────────── */
let scClientId    = null;
let scInitialized = false;
let scInitPromise = null;

/* ── Per-guild search rate limiting: 3 searches / 10 s ────────── */
const _rateMap = new Map();
const RATE_MAX    = 3;
const RATE_WIN_MS = 10_000;

/* ── Limits ────────────────────────────────────────────────────── */
const MAX_PLAYLIST_TRACKS    = 50;
const MAX_QUEUE_SIZE         = 200;
const MAX_SINGLE_QUERY_LEN   = 300;

/* ── URL security patterns ─────────────────────────────────────── */
const UNSAFE_URL_RE = /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+)/i;
const SAFE_SCHEMES  = /^https?:\/\//i;

/* ── Source patterns ───────────────────────────────────────────── */
const YOUTUBE_RE    = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/)|youtu\.be\/)[\w-]+/i;
const SOUNDCLOUD_RE = /^https?:\/\/(?:www\.)?soundcloud\.com\/.+/i;
const DIRECT_RE     = /^https?:\/\/.+\.(?:mp3|aac|ogg|wav|flac|m4a|opus|webm)(?:[?#].*)?$/i;
const RADIO_HOSTS   = ['stream.zeno.fm', 'stream.nightride.fm', 'icecast', 'shoutcast'];

/* ═══════════════════════════════════════════════════════════════
   SECURITY & VALIDATION
   ═══════════════════════════════════════════════════════════════ */

function isUnsafeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return true;
  if (!SAFE_SCHEMES.test(url))   return true; // Only http/https
  if (UNSAFE_URL_RE.test(url))   return true; // Block private networks
  return false;
}

function isYouTubeUrl(url)    { return typeof url === 'string' && YOUTUBE_RE.test(url.trim()); }
function isSoundCloudUrl(url) { return typeof url === 'string' && SOUNDCLOUD_RE.test(url.trim()); }
function isDirectUrl(url) {
  if (typeof url !== 'string') return false;
  return DIRECT_RE.test(url.trim()) || RADIO_HOSTS.some(h => url.includes(h));
}

function validateQuery(query) {
  if (!query || typeof query !== 'string') throw new Error('Search query must be a non-empty string.');
  if (query.trim().length > MAX_SINGLE_QUERY_LEN) throw new Error('Search query is too long (max 300 characters).');
}

/* ── Rate limiter ──────────────────────────────────────────────── */
function checkRateLimit(guildId) {
  if (!guildId) return;
  const now   = Date.now();
  const entry = _rateMap.get(guildId);
  if (!entry || entry.resetAt < now) {
    _rateMap.set(guildId, { count: 1, resetAt: now + RATE_WIN_MS });
    return;
  }
  if (entry.count >= RATE_MAX) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    throw new Error(`Search rate limited. Please wait ${waitSec}s before searching again.`);
  }
  entry.count++;
}

/* ═══════════════════════════════════════════════════════════════
   SOUNDCLOUD CLIENT INITIALIZATION
   ═══════════════════════════════════════════════════════════════ */

async function ensureSoundCloudReady() {
  if (scInitialized) return true;
  if (scInitPromise)  return scInitPromise;

  scInitPromise = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const id = await playdl.getFreeClientID();
        if (id) {
          await playdl.setToken({ soundcloud: { client_id: id } });
          scClientId    = id;
          scInitialized = true;
          return true;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  })();

  const result = await scInitPromise;
  scInitPromise = null;
  return result;
}

/* ── Reinitialize SoundCloud client (for token refresh on error) ─ */
async function refreshSoundCloudClient() {
  scInitialized = false;
  scClientId    = null;
  return ensureSoundCloudReady();
}

/* ═══════════════════════════════════════════════════════════════
   FUZZY MATCHING UTILITIES
   ═══════════════════════════════════════════════════════════════ */

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function stringSimilarity(a, b) {
  const s1 = normalize(a);
  const s2 = normalize(b);
  if (!s1 || !s2)       return 0;
  if (s1 === s2)         return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;
  let common = 0;
  const set2 = new Set(s2.split(''));
  for (const c of s1) if (set2.has(c)) common++;
  return common / Math.max(s1.length, s2.length);
}

function durationScore(expectedSec, actualSec) {
  if (!expectedSec || !actualSec) return 0.5; // Unknown duration: neutral score
  const diff = Math.abs(expectedSec - actualSec);
  if (diff <= 3)  return 1.0;
  if (diff <= 10) return 0.85;
  if (diff <= 30) return 0.6;
  return 0.2;
}

/* ═══════════════════════════════════════════════════════════════
   SOUNDCLOUD SEARCH
   ═══════════════════════════════════════════════════════════════ */

async function searchSoundCloud(query, limit = 5) {
  const ready = await ensureSoundCloudReady();
  if (!ready) return [];
  try {
    const results = await playdl.search(query, { source: { soundcloud: 'tracks' }, limit });
    if (!results || results.length === 0) return [];
    return results.map(r => ({
      title:       r.name              || query,
      artist:      r.user?.name        || 'Artist',
      durationSec: Math.round((r.durationInMs || 0) / 1000),
      thumbnail:   r.thumbnail         || null,
      streamUrl:   r.url,
      source:      'soundcloud',
      confidence:  0.9,
    }));
  } catch (err) {
    // If client ID expired, try once more with refreshed credentials
    if (err.message?.includes('client_id') || err.message?.includes('401')) {
      await refreshSoundCloudClient();
      try {
        const retry = await playdl.search(query, { source: { soundcloud: 'tracks' }, limit });
        if (retry && retry.length > 0) {
          return retry.map(r => ({
            title: r.name || query, artist: r.user?.name || 'Artist',
            durationSec: Math.round((r.durationInMs || 0) / 1000),
            thumbnail: r.thumbnail || null, streamUrl: r.url,
            source: 'soundcloud', confidence: 0.88,
          }));
        }
      } catch (_) {}
    }
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════
   YOUTUBE METADATA (search only — streaming is BLOCKED)
   Note: We use YouTube metadata to find the right track, then
   match it against SoundCloud for actual audio playback.
   ═══════════════════════════════════════════════════════════════ */

async function getYouTubeMetadata(query, limit = 5) {
  try {
    const results = await playdl.search(query, { source: { youtube: 'video' }, limit });
    if (!results || results.length === 0) return [];
    return results.map(r => ({
      title:       r.title             || query,
      artist:      r.channel?.name     || 'YouTube',
      durationSec: r.durationInSec     || 0,
      thumbnail:   r.thumbnails?.[0]?.url || null,
      youtubeUrl:  r.url,
      source:      'youtube_meta',      // metadata only — NOT streamable directly
    }));
  } catch (_) {
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════
   MAIN SEARCH — resolves queries to track metadata
   ═══════════════════════════════════════════════════════════════ */

async function searchAudioTracks(query, limit = 5, guildId = null) {
  validateQuery(query);
  if (guildId) checkRateLimit(guildId);
  const q = query.trim();

  // ── 1. SoundCloud direct URL ───────────────────────────────────
  if (isSoundCloudUrl(q)) {
    if (isUnsafeUrl(q)) throw new Error('Unsafe URL rejected.');
    const ready = await ensureSoundCloudReady();
    if (!ready) throw new Error('SoundCloud service is currently unavailable. Try again in a moment.');
    try {
      const info = await playdl.soundcloud(q);
      if (info) {
        return [{
          title:       info.name          || 'SoundCloud Track',
          artist:      info.user?.name    || 'Artist',
          durationSec: Math.round((info.durationInMs || 0) / 1000),
          thumbnail:   info.thumbnail     || null,
          streamUrl:   info.url,
          source:      'soundcloud',
          confidence:  1.0,
        }];
      }
    } catch (err) {
      throw new Error(`SoundCloud track unavailable: ${err.message}`);
    }
  }

  // ── 2. Direct audio / radio stream ────────────────────────────
  if (isDirectUrl(q)) {
    if (isUnsafeUrl(q)) throw new Error('Unsafe URL rejected.');
    return [{
      title:       'Live Audio Stream',
      artist:      'Web Stream',
      durationSec: 0,
      thumbnail:   null,
      streamUrl:   q,
      source:      'direct',
      confidence:  1.0,
    }];
  }

  // ── 3. YouTube URL — resolve metadata, note streaming status ──
  if (isYouTubeUrl(q)) {
    if (isUnsafeUrl(q)) throw new Error('Unsafe URL rejected.');
    // Extract video ID and get metadata via play-dl yt_info
    try {
      const info = await playdl.video_info(q);
      if (info?.video_details) {
        const det = info.video_details;
        return [{
          title:         det.title          || 'YouTube Video',
          artist:        det.channel?.name  || 'YouTube',
          durationSec:   det.durationInSec  || 0,
          thumbnail:     det.thumbnails?.[det.thumbnails.length - 1]?.url || null,
          streamUrl:     null,            // Streaming BLOCKED — will match to SoundCloud
          youtubeUrl:    q,
          source:        'youtube_meta',
          youtubeBlocked: true,           // ← honest flag
          confidence:    0.9,
        }];
      }
    } catch (_) {}
    // Fallback: use video URL as query for SoundCloud search
    const ytMeta = await getYouTubeMetadata(q, 1);
    if (ytMeta.length > 0) {
      const meta = ytMeta[0];
      return [{
        ...meta,
        streamUrl:      null,
        youtubeUrl:     q,
        youtubeBlocked: true,
        confidence:     0.85,
      }];
    }
    throw new Error('YouTube streaming is currently unavailable (HTTP 403 from Google CDN). The track will be matched against SoundCloud.');
  }

  // ── 4. Text search: SoundCloud primary ────────────────────────
  const scResults = await searchSoundCloud(q, limit);
  if (scResults.length > 0) return scResults;

  // ── 5. Fallback: parse YouTube metadata and surface as info-only ─
  const ytMeta = await getYouTubeMetadata(q, limit);
  if (ytMeta.length > 0) {
    // Return YouTube metadata with youtubeBlocked flag so matchPlayableTrack
    // can re-search SoundCloud for an equivalent
    return ytMeta.map(m => ({
      ...m, streamUrl: null, youtubeBlocked: true, confidence: 0.7,
    }));
  }

  return [];
}

/* ═══════════════════════════════════════════════════════════════
   SPOTIFY / YOUTUBE-META MATCHING
   Given a track (title + artist + optional durationSec), find
   the best SoundCloud stream.
   ═══════════════════════════════════════════════════════════════ */

async function matchPlayableTrack(track) {
  if (!track?.title) return { ...track, streamUrl: null, source: 'unknown', confidence: 0 };

  const queries = [
    `${track.title} ${track.artist || ''} official audio`,
    `${track.title} ${track.artist || ''}`,
    track.title,
  ].filter(Boolean).map(q => q.trim());

  let bestMatch = null;
  let bestScore = -1;

  const allCandidates = [];

  for (const q of queries) {
    let candidates;
    try {
      candidates = await searchSoundCloud(q, 5);
    } catch (_) { continue; }

    if (!candidates || candidates.length === 0) continue;

    for (const c of candidates) {
      const titleSim  = stringSimilarity(track.title, c.title);
      const artistSim = stringSimilarity(track.artist, c.artist);
      const durScore  = durationScore(track.durationSec, c.durationSec);
      // Weighted: title 50%, artist 30%, duration 20%
      const score = (titleSim * 0.5) + (artistSim * 0.3) + (durScore * 0.2);
      c._score = score;
      allCandidates.push(c);
      if (score > bestScore) {
        bestScore  = score;
        bestMatch  = c;
      }
    }

    if (bestScore >= 0.65) break; // Good enough on first pass
  }

  if (bestMatch && bestScore > 0.3) {
    const fallbackUrls = allCandidates
      .filter(c => c.streamUrl && c.streamUrl !== bestMatch.streamUrl)
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 4)
      .map(c => c.streamUrl);

    return {
      ...track,
      streamUrl:    bestMatch.streamUrl,
      source:       'soundcloud',
      matchedTitle: bestMatch.title,
      matchedArtist: bestMatch.artist,
      confidence:   bestScore,
      fallbackUrls,
    };
  }

  return { ...track, streamUrl: null, source: 'unmatched', confidence: bestScore };
}

/* ═══════════════════════════════════════════════════════════════
   SEEKING — ffmpeg raw PCM re-encode with -ss offset
   Works for SoundCloud streams and direct HTTP URLs.
   ═══════════════════════════════════════════════════════════════ */

function createSeekStream(inputStream, seekSec) {
  if (!ffmpegPath) throw new Error('ffmpeg-static not found. Seeking unavailable.');
  const args = [
    '-i',  'pipe:0',
    '-ss', String(Math.max(0, Math.floor(seekSec))),
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f',  's16le',
    'pipe:1',
  ];
  const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  inputStream.pipe(ff.stdin);
  ff.stdin.on('error', () => {});
  ff.stderr.on('data', () => {});
  ff.on('error', err => console.error('[audioProvider] ffmpeg error:', err.message));
  return ff.stdout; // StreamType.Raw
}

function createDirectSeekStream(url, seekSec) {
  if (!ffmpegPath) throw new Error('ffmpeg-static not found. Seeking unavailable.');
  const args = [
    '-ss', String(Math.max(0, Math.floor(seekSec))),
    '-i',  url,
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f',  's16le',
    'pipe:1',
  ];
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stderr.on('data', () => {});
  ff.on('error', err => console.error('[audioProvider] ffmpeg seek error:', err.message));
  return ff.stdout; // StreamType.Raw
}

/* ═══════════════════════════════════════════════════════════════
   RESOLVE AUDIO STREAM — the final step before Discord playback
   Returns { stream, type, seeked, source, matchedTitle? }
   ═══════════════════════════════════════════════════════════════ */

async function resolveAudioStream(track, seekSeconds = 0, retryCount = 1) {
  // ── Step 1: Resolve streamUrl if not already present ──────────
  if (!track.streamUrl) {
    if (track.youtubeBlocked || track.source === 'youtube_meta') {
      // YouTube streaming blocked; try SoundCloud equivalent
      const matched = await matchPlayableTrack(track);
      if (!matched.streamUrl) {
        throw new Error(
          `YouTube streaming is blocked by Google (HTTP 403). ` +
          `No matching SoundCloud track was found for "${track.title}".`
        );
      }
      Object.assign(track, matched);
    } else if (track.title) {
      const matched = await matchPlayableTrack(track);
      if (!matched.streamUrl) {
        throw new Error(`No playable audio found for "${track.title}" by ${track.artist || 'Unknown'}.`);
      }
      Object.assign(track, matched);
    } else {
      throw new Error('Track has no stream URL and no title to search for.');
    }
  }

  if (isUnsafeUrl(track.streamUrl)) {
    throw new Error(`Security: Unsafe stream URL rejected for "${track.title}".`);
  }

  // ── Step 2: Stream by source type ─────────────────────────────

  // Direct / radio stream
  if (track.source === 'direct' || isDirectUrl(track.streamUrl)) {
    if (seekSeconds > 0 && ffmpegPath) {
      const raw = createDirectSeekStream(track.streamUrl, seekSeconds);
      return { stream: raw, type: StreamType.Raw, seeked: true, source: 'direct' };
    }
    return { stream: track.streamUrl, type: StreamType.Arbitrary, isUrl: true, seeked: false, source: 'direct' };
  }

  // SoundCloud stream
  const ready = await ensureSoundCloudReady();
  if (!ready) throw new Error('SoundCloud client failed to initialize.');

  const candidateUrls = [track.streamUrl, ...(track.fallbackUrls || [])].filter(Boolean);
  let lastErr = null;

  for (const cUrl of candidateUrls) {
    try {
      const streamInfo = await playdl.stream(cUrl);
      if (!streamInfo?.stream) continue;

      if (seekSeconds > 0 && ffmpegPath) {
        const raw = createSeekStream(streamInfo.stream, seekSeconds);
        return { stream: raw, type: StreamType.Raw, seeked: true, source: 'soundcloud' };
      }
      return {
        stream:      streamInfo.stream,
        type:        streamInfo.type || StreamType.Arbitrary,
        seeked:      false,
        source:      'soundcloud',
        matchedTitle: track.matchedTitle,
      };
    } catch (err) {
      lastErr = err;
      if (err.message?.includes('client_id') || err.message?.includes('401')) {
        await refreshSoundCloudClient();
      }
    }
  }

  if (retryCount > 0) {
    await refreshSoundCloudClient();
    return resolveAudioStream(track, seekSeconds, retryCount - 1);
  }
  throw new Error(`SoundCloud stream failed: ${lastErr?.message || 'No stream available'}`);
}

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════ */

module.exports = {
  // Init
  ensureClientReady:      ensureSoundCloudReady,
  ensureSoundCloudReady,
  refreshSoundCloudClient,

  // Type checks
  isYouTubeUrl,
  isSoundCloudUrl,
  isDirectUrl,
  isUnsafeUrl,

  // Security
  checkRateLimit,
  validateQuery,

  // Search
  searchAudioTracks,
  searchSoundCloud,
  getYouTubeMetadata,

  // Matching
  matchPlayableTrack,
  stringSimilarity,

  // Streaming
  resolveAudioStream,
  createSeekStream,
  createDirectSeekStream,

  // Limits
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_SIZE,
};
