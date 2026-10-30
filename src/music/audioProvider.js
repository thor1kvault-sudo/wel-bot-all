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
const https        = require('https');
const { StreamType } = require('@discordjs/voice');
const playdl       = require('play-dl');

/* ── Stream function wrapper (permits defensive injection & testing) ─ */
const defaultStreamFn = (...args) => playdl.stream(...args);
let _streamFn = defaultStreamFn;
function _setStreamFunction(fn) {
  _streamFn = fn || defaultStreamFn;
}

let _youtubeStreamFn = null;
function _setYouTubeStreamFunction(fn) {
  _youtubeStreamFn = fn;
}

/* ── Optional deps loaded defensively ─────────────────────────── */
let ffmpegPath = null;
try {
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) {
    if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ffmpegPath;
    if (process.platform !== 'win32') {
      try {
        const fs = require('fs');
        fs.chmodSync(ffmpegPath, 0o755);
      } catch (_) {}
    }
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
const YOUTUBE_RE    = /^https?:\/\/(?:(?:www|music|m)\.)?(?:youtube\.com\/(?:watch\?.*v=|playlist\?.*list=|shorts\/|live\/)|youtu\.be\/)[\w-]+/i;
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
function extractVideoId(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const match = url.trim().match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|(?:embed|v|shorts|live)\/))([a-zA-Z0-9_-]{11})/i);
  return match ? match[1] : null;
}
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
        let t;
        const idPromise = playdl.getFreeClientID();
        const timeoutPromise = new Promise(resolve => {
          t = setTimeout(() => resolve(null), 3000);
          if (typeof t.unref === 'function') t.unref();
        });
        const id = await Promise.race([idPromise, timeoutPromise]);
        if (t) clearTimeout(t);
        if (id) {
          await playdl.setToken({ soundcloud: { client_id: id } });
          scClientId    = id;
          scInitialized = true;
          return true;
        }
      } catch (_) {}
      await new Promise(r => {
        const tr = setTimeout(r, 200);
        if (typeof tr.unref === 'function') tr.unref();
      });
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
  return str.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, '').trim();
}

function stringSimilarity(a, b) {
  const s1 = normalize(a);
  const s2 = normalize(b);
  if (!s1 || !s2)       return 0;
  if (s1 === s2)         return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  const w1 = s1.split(/\s+/).filter(Boolean);
  const w2 = s2.split(/\s+/).filter(Boolean);
  if (w1.length === 0 || w2.length === 0) return 0;

  // Word token overlap
  const set2 = new Set(w2);
  let matchCount = 0;
  for (const w of w1) {
    if (set2.has(w)) matchCount++;
  }
  const tokenScore = (2 * matchCount) / (w1.length + w2.length);

  // Bigram character overlap for typo tolerance
  if (s1.length < 2 || s2.length < 2) return tokenScore;
  const bigrams1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bg = s1.substr(i, 2);
    bigrams1.set(bg, (bigrams1.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bg = s2.substr(i, 2);
    const count = bigrams1.get(bg) || 0;
    if (count > 0) {
      bigrams1.set(bg, count - 1);
      intersection++;
    }
  }
  const bigramScore = (2 * intersection) / (s1.length - 1 + s2.length - 1);

  return Math.max(tokenScore, bigramScore);
}

function durationScore(expectedSec, actualSec) {
  if (!expectedSec || !actualSec) return 0.5; // Unknown duration: neutral score
  // If expected is a full song (>= 60s) but candidate is a short preview (<= 45s or < 35% of expected duration), reject
  if (expectedSec >= 60 && (actualSec <= 45 || actualSec < expectedSec * 0.35)) {
    return 0.0;
  }
  const diff = Math.abs(expectedSec - actualSec);
  if (diff <= 5)  return 1.0;
  if (diff <= 15) return 0.85;
  if (diff <= 30) return 0.6;
  if (diff <= 60) return 0.35;
  return 0.1;
}

/* ═══════════════════════════════════════════════════════════════
   ARTIST EXTRACTION & MULTI-ARTIST MATCHING
   Supports multi-artist strings (comma, &, feat, ft, /, with, x),
   record label channels (T-Series, Sony, VEVO, etc.), and strict
   penalization of unrelated/different artists.
   ═══════════════════════════════════════════════════════════════ */

function extractArtists(artistStr) {
  if (!artistStr || typeof artistStr !== 'string') return [];
  return artistStr
    .split(/(?:,|\s+&\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s*\/\s*|\s+with\s+|\s+x\s+)/i)
    .map(a => a.trim().toLowerCase())
    .filter(a => a.length > 1);
}

function calculateArtistMatch(expectedArtistStr, candArtist, candTitle) {
  if (!expectedArtistStr) return { matchScore: 0.5, isDifferentArtist: false };

  const expectedArtists = extractArtists(expectedArtistStr);
  if (expectedArtists.length === 0) return { matchScore: 0.5, isDifferentArtist: false };

  const cArtist = (candArtist || '').toLowerCase().trim();
  const cTitle = (candTitle || '').toLowerCase().trim();
  const cFull = `${cTitle} ${cArtist}`;

  // 1. Direct inclusion: does candidate title or channel include any expected artist?
  for (const exp of expectedArtists) {
    if (cFull.includes(exp)) {
      return { matchScore: 1.0, isDifferentArtist: false, matchedArtist: exp };
    }
  }

  // 2. High string similarity with any expected artist
  for (const exp of expectedArtists) {
    const sim = stringSimilarity(exp, cArtist);
    if (sim >= 0.70) {
      return { matchScore: sim, isDifferentArtist: false, matchedArtist: exp };
    }
  }

  // 3. Official record label channel check
  const isLabel = /t-series|sony music|zee music|yrf|tips official|universal music|warner music|vevo|topic|records/i.test(cArtist);
  if (isLabel) {
    for (const exp of expectedArtists) {
      const tokens = exp.split(/\s+/).filter(t => t.length > 2);
      const tokenMatch = tokens.some(t => cTitle.includes(t));
      if (tokenMatch) {
        return { matchScore: 0.90, isDifferentArtist: false, matchedArtist: exp };
      }
    }
    // Major record label upload without expected artist name
    return { matchScore: 0.25, isDifferentArtist: false, matchedArtist: null };
  }

  // 4. Candidate has an identifiable artist that does NOT match expected artist at all
  if (cArtist && !isLabel) {
    return { matchScore: 0.0, isDifferentArtist: true, actualArtist: cArtist };
  }

  return { matchScore: 0.1, isDifferentArtist: true };
}

/* ═══════════════════════════════════════════════════════════════
   MODIFIER PENALTIES & VERSION SCORING
   Strongly penalizes slowed, reverb, remix, sped up, nightcore,
   cover, live, mashup, and lofi unless explicitly requested.
   ═══════════════════════════════════════════════════════════════ */

const PENALTY_MODIFIERS = [
  'slowed', 'reverb', 'slow', 'reverbed', 'remix', 'sped up', 'speed up', 'speedup',
  'nightcore', 'daycore', 'cover', 'live', 'mashup', 'lofi', 'lo-fi',
  'bass boosted', 'boosted', '8d', 'instrumental', 'karaoke', 'tribute',
  'acoustic', 'parody', 'edit', 'flip', 'bootleg', 'chopped', 'screwed'
];

function getRequestedModifiers(query) {
  const q = (query || '').toLowerCase();
  return PENALTY_MODIFIERS.filter(mod => {
    const escaped = mod.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    return new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)', 'i').test(q);
  });
}

function scoreCandidate(candidate, userQuery, canonical = null) {
  if (!candidate || !candidate.title) {
    return { finalScore: 0, penalty: 0, penaltyWords: [], baseScore: 0, artistMatch: 0, durScore: 0 };
  }

  const reqMods = getRequestedModifiers(userQuery);
  const candText = `${candidate.title} ${candidate.artist || ''}`.toLowerCase();

  let penalty = 0;
  const penaltyWords = [];

  for (const mod of PENALTY_MODIFIERS) {
    if (reqMods.includes(mod)) continue;
    const escaped = mod.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)', 'i').test(candText)) {
      penalty += 0.50;
      penaltyWords.push(mod);
    }
  }

  // Artist check against canonical or user query
  const expectedArtist = canonical?.artist || (canonical?.canonicalYouTube?.artist) || null;
  let artistMatch = 0.5;
  if (expectedArtist) {
    const artistResult = calculateArtistMatch(expectedArtist, candidate.artist, candidate.title);
    artistMatch = artistResult.matchScore;
    if (artistResult.isDifferentArtist) {
      // Check if user explicitly asked for this different artist in userQuery
      const queryHasActual = artistResult.actualArtist && userQuery.toLowerCase().includes(artistResult.actualArtist);
      if (!queryHasActual) {
        penalty += 0.75;
        penaltyWords.push('different_artist');
      }
    }
  }

  const querySim = stringSimilarity(userQuery, candidate.title);
  let canonicalSim = 0;
  let durScore = 0.5;

  if (canonical) {
    canonicalSim = stringSimilarity(canonical.title, candidate.title);
    if (canonical.durationSec && candidate.durationSec) {
      if (canonical.durationSec >= 60 && (candidate.durationSec <= 45 || candidate.durationSec < canonical.durationSec * 0.35)) {
        durScore = 0.0;
        penalty += 1.0;
        penaltyWords.push('short_preview');
      } else {
        const diff = Math.abs(canonical.durationSec - candidate.durationSec);
        if (diff <= 5) durScore = 1.0;
        else if (diff <= 15) durScore = 0.85;
        else if (diff <= 30) durScore = 0.65;
        else if (diff <= 60) durScore = 0.35;
        else {
          durScore = 0.05;
          penalty += 0.40;
          penaltyWords.push('duration_mismatch');
        }
      }
    }
  }

  const baseScore = canonical
    ? (expectedArtist
        ? (querySim * 0.30 + canonicalSim * 0.30 + artistMatch * 0.25 + durScore * 0.15)
        : (querySim * 0.35 + canonicalSim * 0.35 + durScore * 0.30))
    : querySim;

  const finalScore = Math.max(0, baseScore - penalty);

  return {
    finalScore: Number(finalScore.toFixed(3)),
    penalty: Number(penalty.toFixed(2)),
    penaltyWords,
    baseScore: Number(baseScore.toFixed(3)),
    artistMatch: Number(artistMatch.toFixed(3)),
    durScore: Number(durScore.toFixed(3)),
  };
}

/* ═══════════════════════════════════════════════════════════════
   SOUNDCLOUD SEARCH
   ═══════════════════════════════════════════════════════════════ */

async function searchSoundCloud(query, limit = 5) {
  const ready = await ensureSoundCloudReady();
  if (!ready) return [];
  try {
    let t;
    const searchPromise = playdl.search(query, { source: { soundcloud: 'tracks' }, limit });
    const timeoutPromise = new Promise(resolve => {
      t = setTimeout(() => resolve([]), 3500);
      if (typeof t.unref === 'function') t.unref();
    });
    const results = await Promise.race([searchPromise, timeoutPromise]);
    if (t) clearTimeout(t);

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
        let t2;
        const retryPromise = playdl.search(query, { source: { soundcloud: 'tracks' }, limit });
        const timeoutPromise2 = new Promise(resolve => {
          t2 = setTimeout(() => resolve([]), 3500);
          if (typeof t2.unref === 'function') t2.unref();
        });
        const retry = await Promise.race([retryPromise, timeoutPromise2]);
        if (t2) clearTimeout(t2);

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
   Includes direct HTML scraping to protect against play-dl browseId
   crashes and HTTP header overflows on regional/short content.
   ═══════════════════════════════════════════════════════════════ */

function fetchYouTubeHtmlInternal(query, limit = 5) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'CONSENT=YES+cb; SOCS=CAESEwgDEgk2MTQ1NzQ4OTQaAmVuIAEaBgiA_LyaBg',
      },
      timeout: 4500,
    }, (res) => {
      let html = '';
      res.on('data', c => html += c);
      res.on('end', () => {
        const match = html.match(/(?:var\s+ytInitialData|window\[['"]ytInitialData['"]\]|ytInitialData)\s*=\s*({.+?});<\/script>/);
        if (!match) return resolve([]);
        try {
          const data = JSON.parse(match[1]);
          const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
          if (!contents || !Array.isArray(contents)) return resolve([]);

          const videos = [];
          for (const sec of contents) {
            const itemSection = sec.itemSectionRenderer?.contents;
            if (!itemSection || !Array.isArray(itemSection)) continue;
            for (const item of itemSection) {
              const vr = item.videoRenderer;
              if (vr && vr.videoId && vr.title?.runs?.[0]?.text) {
                const title = vr.title.runs.map(r => r.text).join('');
                const channel = vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || '';
                const durationText = vr.lengthText?.simpleText || '';
                let durationSec = 0;
                if (durationText) {
                  const parts = durationText.split(':').map(Number);
                  if (parts.length === 2) durationSec = parts[0] * 60 + parts[1];
                  else if (parts.length === 3) durationSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
                const thumbs = vr.thumbnail?.thumbnails || [];
                const thumbnail = thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || null;
                videos.push({
                  title,
                  artist: channel,
                  durationSec,
                  thumbnail,
                  youtubeUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
                  source: 'youtube_meta',
                });
                if (videos.length >= limit) break;
              }
            }
            if (videos.length >= limit) break;
          }
          resolve(videos);
        } catch (_) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', function() { this.destroy(); resolve([]); });
  });
}

async function searchYouTubeHtml(query, limit = 5) {
  const firstTry = await fetchYouTubeHtmlInternal(query, limit);
  if (firstTry && firstTry.length > 0) return firstTry;
  await new Promise(r => setTimeout(r, 200));
  return fetchYouTubeHtmlInternal(query, limit);
}

async function getYouTubeMetadata(query, limit = 5) {
  // 1. Primary: Fast, direct HTML scrape (handles regional songs, Unicode, and avoids playdl browseId bug)
  try {
    const htmlResults = await searchYouTubeHtml(query, limit);
    if (htmlResults && htmlResults.length > 0) {
      return htmlResults;
    }
  } catch (_) {}

  // 2. Secondary fallback via playdl
  try {
    let t;
    const searchPromise = playdl.search(query, { source: { youtube: 'video' }, limit });
    const timeoutPromise = new Promise(resolve => {
      t = setTimeout(() => resolve([]), 3500);
      if (typeof t.unref === 'function') t.unref();
    });
    const results = await Promise.race([searchPromise, timeoutPromise]);
    if (t) clearTimeout(t);

    if (results && results.length > 0) {
      return results.map(r => ({
        title:       r.title             || query,
        artist:      r.channel?.name     || 'YouTube',
        durationSec: r.durationInSec     || 0,
        thumbnail:   r.thumbnails?.[0]?.url || null,
        youtubeUrl:  r.url,
        source:      'youtube_meta',      // metadata only — NOT streamable directly
      }));
    }
  } catch (_) {}

  return [];
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

  // ── 3. YouTube URL — resolve playable track via Lavalink or metadata fallback ──
  if (isYouTubeUrl(q)) {
    if (isUnsafeUrl(q)) throw new Error('Unsafe URL rejected.');
    try {
      const lavalinkManager = require('./lavalinkManager');
      if (lavalinkManager.isLavalinkReady()) {
        const lRes = await lavalinkManager.resolveTrack(q);
        if (lRes && lRes.tracks && lRes.tracks.length > 0) {
          const t = lRes.tracks[0];
          return [{
            title: t.info?.title || 'YouTube Video',
            artist: t.info?.author || 'YouTube',
            durationSec: Math.round((t.info?.length || 0) / 1000),
            thumbnail: `https://i.ytimg.com/vi/${t.info?.identifier}/hqdefault.jpg`,
            youtubeUrl: t.info?.uri || q,
            encoded: t.encoded,
            lavalinkTrack: t,
            source: 'youtube',
            provider: 'youtube',
            confidence: 1.0,
          }];
        }
      }
    } catch (_) {}

    try {
      const info = await playdl.video_info(q);
      if (info?.video_details) {
        const det = info.video_details;
        return [{
          title:         det.title          || 'YouTube Video',
          artist:        det.channel?.name  || 'YouTube',
          durationSec:   det.durationInSec  || 0,
          thumbnail:     det.thumbnails?.[det.thumbnails.length - 1]?.url || null,
          streamUrl:     null,
          youtubeUrl:    q,
          source:        'youtube',
          provider:      'youtube',
          confidence:    0.9,
        }];
      }
    } catch (_) {}

    const ytMeta = await getYouTubeMetadata(q, 1);
    if (ytMeta.length > 0) {
      return [{
        ...ytMeta[0],
        streamUrl:      null,
        youtubeUrl:     q,
        source:         'youtube',
        provider:       'youtube',
        confidence:     0.85,
      }];
    }
    throw new Error('Unable to retrieve metadata for this YouTube link. The video may be private, deleted, or unavailable.');
  }

  // ── 4. Text search: YouTube primary for full-length songs ──
  let ytCandidates = [];
  try {
    const lavalinkManager = require('./lavalinkManager');
    if (lavalinkManager.isLavalinkReady()) {
      const lRes = await lavalinkManager.resolveTrack(`ytsearch:${q}`);
      if (lRes && lRes.tracks && lRes.tracks.length > 0) {
        ytCandidates = lRes.tracks.map(t => ({
          title: t.info?.title || q,
          artist: t.info?.author || 'YouTube',
          durationSec: Math.round((t.info?.length || 0) / 1000),
          thumbnail: `https://i.ytimg.com/vi/${t.info?.identifier}/hqdefault.jpg`,
          youtubeUrl: t.info?.uri || `https://www.youtube.com/watch?v=${t.info?.identifier}`,
          encoded: t.encoded,
          lavalinkTrack: t,
          source: 'youtube',
          provider: 'youtube',
        }));
      }
    }
  } catch (_) {}

  if (!ytCandidates || ytCandidates.length === 0) {
    try {
      ytCandidates = await getYouTubeMetadata(q, Math.max(limit * 2, 10));
    } catch (_) {}
  }

  if (ytCandidates && ytCandidates.length > 0) {
    let searchTitle = q;
    let searchArtist = '';
    if (q.includes(' - ')) {
      const parts = q.split(' - ');
      searchArtist = parts[0].trim();
      searchTitle = parts.slice(1).join(' - ').trim();
    }
    const queryInfo = { title: searchTitle, artist: searchArtist };
    const ranked = rankYouTubeCandidates(ytCandidates, queryInfo);
    if (ranked && ranked.length > 0) {
      const cleanCandidates = ranked.filter(c =>
        (c.penalty || 0) === 0 &&
        !c.isDifferentArtist &&
        !c.penaltyWords?.includes('short_preview') &&
        !c.penaltyWords?.includes('shorts_or_teaser') &&
        (c.durationSec === 0 || c.durationSec > 45)
      );

      const top = cleanCandidates[0] || ranked[0];
      const isConfident = top &&
        (top.penalty || 0) === 0 &&
        !top.isDifferentArtist &&
        !top.penaltyWords?.includes('short_preview') &&
        !top.penaltyWords?.includes('shorts_or_teaser');

      const fallbackUrls = cleanCandidates
        .filter(c => c.youtubeUrl !== top.youtubeUrl)
        .slice(0, 4)
        .map(c => c.youtubeUrl);

      const fallbackCandidates = cleanCandidates
        .filter(c => c.youtubeUrl !== top.youtubeUrl)
        .slice(0, 4);

      if (isConfident) {
        const topTrack = {
          title: top.title,
          artist: top.artist,
          durationSec: top.durationSec,
          thumbnail: top.thumbnail,
          streamUrl: null,
          youtubeUrl: top.youtubeUrl,
          youtubeVideoId: extractVideoId(top.youtubeUrl),
          source: 'youtube',
          provider: 'youtube',
          confidence: top.finalScore || 0.85,
          fallbackUrls,
          fallbackCandidates,
          matchedCandidate: {
            title: top.title,
            channel: top.artist,
            youtubeUrl: top.youtubeUrl,
            durationSec: top.durationSec,
            videoId: extractVideoId(top.youtubeUrl),
          },
        };

        const others = cleanCandidates
          .filter(c => c.youtubeUrl !== top.youtubeUrl)
          .slice(0, limit - 1)
          .map(c => ({
            title: c.title,
            artist: c.artist,
            durationSec: c.durationSec,
            thumbnail: c.thumbnail,
            streamUrl: null,
            youtubeUrl: c.youtubeUrl,
            youtubeVideoId: extractVideoId(c.youtubeUrl),
            source: 'youtube',
            provider: 'youtube',
            confidence: c.finalScore || 0.75,
            fallbackUrls: [],
            fallbackCandidates: [],
          }));

        return [topTrack, ...others];
      }

      if (cleanCandidates.length > 0) {
        const choiceList = cleanCandidates.slice(0, limit).map((c, idx) => ({
          title: c.title,
          artist: c.artist,
          durationSec: c.durationSec,
          thumbnail: c.thumbnail,
          streamUrl: null,
          youtubeUrl: c.youtubeUrl,
          youtubeVideoId: extractVideoId(c.youtubeUrl),
          source: 'youtube',
          provider: 'youtube',
          confidence: c.finalScore || 0.5,
          requiresChoice: idx === 0,
          candidates: cleanCandidates.slice(0, limit),
        }));
        return choiceList;
      }
    }
  }

  // ── 5. Secondary fallback: SoundCloud search (if YouTube produced 0 results) ──
  let canonicalMeta = null;
  if (ytCandidates && ytCandidates.length > 0) {
    canonicalMeta = ytCandidates[0];
  }

  const scResults = await searchSoundCloud(q, Math.max(limit * 2, 10));
  if (scResults && scResults.length > 0) {
    const scored = scResults.map(c => {
      const scoring = scoreCandidate(c, q, canonicalMeta);
      return {
        ...c,
        _score: scoring.finalScore,
        _penalty: scoring.penalty,
        _penaltyWords: scoring.penaltyWords,
        confidence: scoring.finalScore,
      };
    });

    scored.sort((a, b) => (b._score || 0) - (a._score || 0));

    const cleanCandidates = scored.filter(c =>
      (c._penalty || 0) === 0 &&
      !c._penaltyWords?.includes('different_artist') &&
      !c._penaltyWords?.includes('short_preview') &&
      (c._score || 0) >= 0.40
    );
    const topCandidate = scored[0];

    const isConfident = topCandidate &&
      topCandidate._score >= 0.60 &&
      (topCandidate._penalty || 0) === 0 &&
      !topCandidate._penaltyWords?.includes('different_artist') &&
      !topCandidate._penaltyWords?.includes('short_preview');

    if (isConfident) {
      const fallbackUrls = cleanCandidates
        .filter(c => c.streamUrl && c.streamUrl !== topCandidate.streamUrl)
        .slice(0, 4)
        .map(c => c.streamUrl);

      topCandidate.fallbackUrls = fallbackUrls;
      if (canonicalMeta) {
        topCandidate.canonicalYouTube = canonicalMeta;
      }

      return [topCandidate, ...cleanCandidates.filter(c => c.streamUrl !== topCandidate.streamUrl).slice(0, limit - 1)];
    }

    if (cleanCandidates.length > 0) {
      const choiceList = cleanCandidates.slice(0, limit);
      return choiceList.map((c, idx) => {
        if (idx === 0) {
          return {
            ...c,
            requiresChoice: true,
            candidates: choiceList,
            canonicalYouTube: canonicalMeta,
          };
        }
        return c;
      });
    }

    return [];
  }

  return [];
}

/* ═══════════════════════════════════════════════════════════════
   SPOTIFY → YOUTUBE CANDIDATE RESOLUTION
   Finds matching YouTube version for Spotify tracks, ranking
   official/artist versions higher and penalizing remixes/slowed/reverbs.
   ═══════════════════════════════════════════════════════════════ */

function rankYouTubeCandidates(candidates, spotifyTrack) {
  if (!Array.isArray(candidates) || candidates.length === 0 || !spotifyTrack) {
    return [];
  }

  const queryMod = getRequestedModifiers(`${spotifyTrack.title} ${spotifyTrack.artist || ''}`);

  const scored = candidates.map(c => {
    // 1. Title Similarity
    const titleSim = stringSimilarity(spotifyTrack.title, c.title);

    // 2. Artist Match using calculateArtistMatch
    const artistRes = calculateArtistMatch(spotifyTrack.artist, c.artist, c.title);
    const artistMatch = artistRes.matchScore;

    // 3. Duration Score
    const durScore = durationScore(spotifyTrack.durationSec, c.durationSec);

    // 4. Modifier Penalty (slowed, reverb, remix, cover, live, mashup, etc.)
    let penalty = 0;
    const penaltyWords = [];
    const candFullText = `${c.title || ''} ${c.artist || ''}`.toLowerCase();
    for (const mod of PENALTY_MODIFIERS) {
      if (queryMod.includes(mod)) continue;
      const escaped = mod.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)', 'i').test(candFullText)) {
        penalty += 0.50;
        penaltyWords.push(mod);
      }
    }

    // 5. Different Artist Penalty (Requirements 3 & 5)
    if (artistRes.isDifferentArtist) {
      penalty += 0.75;
      penaltyWords.push('different_artist');
    }

    // 6. Preview detection & large duration discrepancy penalty
    if (spotifyTrack.durationSec > 0 && c.durationSec > 0) {
      if (spotifyTrack.durationSec >= 60 && (c.durationSec <= 45 || c.durationSec < spotifyTrack.durationSec * 0.35)) {
        penalty += 1.0;
        penaltyWords.push('short_preview');
      } else {
        const diff = Math.abs(spotifyTrack.durationSec - c.durationSec);
        if (diff > 60) {
          penalty += 0.40;
          penaltyWords.push('duration_mismatch');
        }
      }
    } else if (c.durationSec > 0 && c.durationSec <= 45 && !spotifyTrack.durationSec) {
      penalty += 1.0;
      penaltyWords.push('short_preview');
    }

    // Shorts & Teasers detection
    const candTitleLower = (c.title || '').toLowerCase();
    const candUrlLower = (c.youtubeUrl || '').toLowerCase();
    const isShortsOrTeaser = (c.durationSec > 0 && c.durationSec <= 60 && /(?:#shorts|\bshorts\b|\bteaser\b|\btrailer\b|\bsnippet\b|\bpreview\b)/i.test(`${candTitleLower} ${candUrlLower}`)) ||
      /(?:\/shorts\/|#shorts\b|\bteaser\b|\bsnippet\b|\bpreview clip\b)/i.test(`${candTitleLower} ${candUrlLower}`);
    if (isShortsOrTeaser && !penaltyWords.includes('short_preview')) {
      penalty += 1.0;
      penaltyWords.push('shorts_or_teaser');
    }

    // Lyric video check: If not requested, slight penalty so official audio/video is preferred
    if (/\b(?:lyrics?|lyric video)\b/i.test(candTitleLower) && !queryMod.includes('lyrics')) {
      penalty += 0.15;
      penaltyWords.push('lyric_video');
    }

    // 7. Official Preference Bonus
    let officialBonus = 0;
    if (/official (?:music )?(?:video|audio)/i.test(c.title)) {
      officialBonus += 0.20;
    }
    if (/vevo|topic|official/i.test(c.artist)) {
      officialBonus += 0.15;
    }

    const baseScore = spotifyTrack.durationSec > 0
      ? (titleSim * 0.40 + artistMatch * 0.35 + durScore * 0.25 + officialBonus)
      : (spotifyTrack.artist
          ? (titleSim * 0.55 + artistMatch * 0.45 + officialBonus)
          : (titleSim * 0.70 + officialBonus));

    const finalScore = Math.max(0, baseScore - penalty);

    return {
      ...c,
      finalScore: Number(finalScore.toFixed(3)),
      baseScore: Number(baseScore.toFixed(3)),
      penalty: Number(penalty.toFixed(2)),
      penaltyWords,
      titleSim: Number(titleSim.toFixed(3)),
      artistMatch: Number(artistMatch.toFixed(3)),
      durScore: Number(durScore.toFixed(3)),
      isDifferentArtist: artistRes.isDifferentArtist,
    };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

async function matchSpotifyToYouTube(spotifyTrack) {
  if (!spotifyTrack || !spotifyTrack.title) {
    return { success: false, reason: 'Invalid Spotify track metadata', bestCandidate: null };
  }

  // Build high-intent search queries that cover exact title, artist, album, and clean variations
  const queries = [
    `${spotifyTrack.title} ${spotifyTrack.artist || ''} official audio`.trim(),
    `${spotifyTrack.title} ${spotifyTrack.artist || ''}`.trim(),
    `${spotifyTrack.artist || ''} - ${spotifyTrack.title}`.trim(),
  ];

  if (spotifyTrack.album && spotifyTrack.album !== spotifyTrack.title && spotifyTrack.album !== spotifyTrack.artist) {
    queries.push(`${spotifyTrack.title} ${spotifyTrack.album}`.trim());
    queries.push(`${spotifyTrack.album} ${spotifyTrack.title}`.trim());
  }

  // Clean title without parentheses/brackets (e.g. "Enna Sona (From \"OK Jaanu\")" -> "Enna Sona")
  const cleanTitle = spotifyTrack.title.replace(/\s*[\(\[\{][^\)\]\}]+[\)\]\}]\s*/g, ' ').trim();
  if (cleanTitle && cleanTitle.toLowerCase() !== spotifyTrack.title.toLowerCase()) {
    queries.push(`${cleanTitle} ${spotifyTrack.artist || ''}`.trim());
    queries.push(`${cleanTitle} official audio`.trim());
  }

  queries.push(spotifyTrack.title.trim());

  let allCandidates = [];
  const seenUrls = new Set();
  let consecutiveZeroes = 0;

  for (const q of queries) {
    try {
      let results = [];
      try {
        const lavalinkManager = require('./lavalinkManager');
        if (lavalinkManager.isLavalinkReady()) {
          const lRes = await lavalinkManager.resolveTrack(`ytsearch:${q}`);
          if (lRes && lRes.tracks && lRes.tracks.length > 0) {
            results = lRes.tracks.map(t => ({
              title: t.info?.title || '',
              artist: t.info?.author || '',
              durationSec: Math.round((t.info?.length || 0) / 1000),
              thumbnail: `https://i.ytimg.com/vi/${t.info?.identifier}/hqdefault.jpg`,
              youtubeUrl: t.info?.uri || `https://www.youtube.com/watch?v=${t.info?.identifier}`,
              encoded: t.encoded,
              lavalinkTrack: t,
              source: 'youtube',
            }));
          }
        }
      } catch (_) {}

      if (!results || results.length === 0) {
        results = await getYouTubeMetadata(q, 5);
      }
      if (!results || results.length === 0) {
        consecutiveZeroes++;
        if (consecutiveZeroes >= 3 && allCandidates.length === 0) {
          break; // Avoid slow retries when provider or network has no results
        }
      } else {
        consecutiveZeroes = 0;
      }
      for (const r of results) {
        if (r.youtubeUrl && !seenUrls.has(r.youtubeUrl)) {
          seenUrls.add(r.youtubeUrl);
          allCandidates.push(r);
        }
      }
      if (allCandidates.length >= 10) break; // Collect at least 10 candidates across search variations
    } catch (_) {
      consecutiveZeroes++;
      if (consecutiveZeroes >= 3 && allCandidates.length === 0) break;
    }
  }

  if (allCandidates.length === 0) {
    return {
      success: false,
      reason: `No YouTube videos found matching "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}`,
      bestCandidate: null,
      candidates: [],
    };
  }

  const ranked = rankYouTubeCandidates(allCandidates, spotifyTrack);
  const best = ranked[0];

  // Requirements 3 & 4:
  // Strong agreement: high score, matching artist, matching title, zero penalties, and full length (not preview)
  const isNotPreview = !spotifyTrack.durationSec || spotifyTrack.durationSec < 60 || (best && best.durationSec > 45);
  const hasArtistMatch = !spotifyTrack.artist || (best && best.artistMatch >= 0.40 && !best.isDifferentArtist && (best.matchedArtist || best.artistMatch >= 0.70));
  const hasTitleMatch = Boolean(best && best.titleSim >= 0.50);
  const isHighConfidence = best && best.finalScore >= 0.58 && hasArtistMatch && hasTitleMatch && best.penalty === 0 && isNotPreview;

  if (isHighConfidence) {
    const fallbackUrls = ranked
      .filter(c => (c.penalty || 0) === 0 && !c.isDifferentArtist && c.youtubeUrl !== best.youtubeUrl && (c.durationSec === 0 || c.durationSec > 45))
      .slice(0, 4)
      .map(c => c.youtubeUrl);

    const fallbackCandidates = ranked
      .filter(c => (c.penalty || 0) === 0 && !c.isDifferentArtist && c.youtubeUrl !== best.youtubeUrl && (c.durationSec === 0 || c.durationSec > 45))
      .slice(0, 4);

    return {
      success: true,
      requiresChoice: false,
      bestCandidate: best,
      youtubeUrl: best.youtubeUrl,
      matchedTitle: best.title,
      matchedArtist: best.artist,
      durationSec: (best && best.durationSec > 0) ? best.durationSec : (spotifyTrack.durationSec || 0),
      spotifyExpectedDurationSec: spotifyTrack.durationSec || null,
      thumbnail: best.thumbnail || spotifyTrack.thumbnail,
      confidence: best.finalScore,
      candidates: ranked,
      fallbackUrls,
      fallbackCandidates,
    };
  }

  // Medium confidence: candidate has verified title similarity, reasonable artist match, no unrequested penalties or preview
  const cleanCandidates = ranked.filter(c =>
    (c.penalty || 0) === 0 &&
    !c.isDifferentArtist &&
    c.titleSim >= 0.45 &&
    (!spotifyTrack.artist || c.artistMatch >= 0.35 || c.matchedArtist) &&
    c.finalScore >= 0.45 &&
    (!spotifyTrack.durationSec || spotifyTrack.durationSec < 60 || c.durationSec > 45)
  );
  const isMediumConfidence = cleanCandidates.length > 0 && cleanCandidates[0].finalScore >= 0.45;

  if (isMediumConfidence) {
    return {
      success: false,
      requiresChoice: true,
      bestCandidate: cleanCandidates[0],
      candidates: cleanCandidates.slice(0, 3),
      reason: `Found multiple possible versions for "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}. Please select your preferred version below:`,
    };
  }

  // Low confidence: do not play a random song or use unrelated fallback
  return {
    success: false,
    requiresChoice: false,
    reason: best?.penaltyWords?.includes('different_artist')
      ? `No reliable YouTube version found for "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}. Found upload by "${best.artist}" which was rejected as a different artist.`
      : best?.penaltyWords?.includes('short_preview')
      ? `No reliable YouTube version found for "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}. Available version was rejected as a short preview (${best.durationSec}s).`
      : `No confident official YouTube version found for "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}. Top candidate scored ${best?.finalScore || 0}.`,
    bestCandidate: null,
    candidates: cleanCandidates,
  };
}

/* ═══════════════════════════════════════════════════════════════
   SPOTIFY / YOUTUBE-META MATCHING
   Given a track (title + artist + optional durationSec), find
   the best SoundCloud stream.
   ═══════════════════════════════════════════════════════════════ */

async function matchPlayableTrack(track) {
  if (!track?.title) return { ...track, streamUrl: null, source: 'unknown', confidence: 0 };

  // If Spotify track has not yet been resolved to YouTube, attempt resolution
  if ((track.source === 'spotify' || track.source === 'spotify_meta' || track.spotifyUrl) && !track.matchedYouTubeTitle) {
    try {
      const ytMatch = await matchSpotifyToYouTube(track);
      if (ytMatch.success) {
        track.youtubeUrl = ytMatch.youtubeUrl;
        track.matchedYouTubeTitle = ytMatch.matchedTitle;
        track.matchedYouTubeChannel = ytMatch.matchedArtist;
        track.durationSec = ytMatch.durationSec;
        track.thumbnail = ytMatch.thumbnail;
      }
    } catch (_) {}
  }

  const searchTarget = track.matchedYouTubeTitle || track.title;
  const queries = [
    `${searchTarget} ${track.artist || ''} official audio`,
    `${searchTarget} ${track.artist || ''}`,
    `${track.title} ${track.artist || ''}`,
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
      const scoring = scoreCandidate(c, `${track.title} ${track.artist || ''}`, track);
      c._score = scoring.finalScore;
      c._penalty = scoring.penalty;
      c._artistMatch = scoring.artistMatch;
      allCandidates.push(c);
      if (scoring.finalScore > bestScore) {
        bestScore = scoring.finalScore;
        bestMatch = c;
      }
    }

    if (bestScore >= 0.70) break; // Confident match found
  }

  // Strict verification: Do not silently fall back to an unrelated SoundCloud result (Requirement 6)
  const isSoundCloudReliable = bestMatch
    && bestScore >= 0.55
    && (bestMatch._penalty || 0) === 0
    && (!track.artist || (bestMatch._artistMatch || 0) >= 0.50);

  if (isSoundCloudReliable) {
    const fallbackUrls = allCandidates
      .filter(c => c.streamUrl && c.streamUrl !== bestMatch.streamUrl && (c._penalty || 0) === 0 && (!track.artist || (c._artistMatch || 0) >= 0.50))
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .slice(0, 4)
      .map(c => c.streamUrl);

    return {
      ...track,
      durationSec:  (track.durationSec && track.durationSec > 0) ? track.durationSec : (bestMatch.durationSec || 0),
      streamUrl:    bestMatch.streamUrl,
      matchedSoundCloudTitle: bestMatch.title,
      matchedSoundCloudArtist: bestMatch.artist,
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
   Handles HTTP 404 gracefully with fallback candidate URLs.
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   YOUTUBE AUDIO STREAM EXTRACTION
   Extracts direct audio streams for YouTube candidates without
   falling back or routing to SoundCloud.
   ═══════════════════════════════════════════════════════════════ */

async function streamYouTubeTrack(youtubeUrl, options = {}) {
  const { seekSeconds = 0, track = null } = options;

  if (!youtubeUrl || typeof youtubeUrl !== 'string') {
    throw new Error('Invalid YouTube URL provided for audio stream extraction.');
  }

  // 1. Check if mock/custom YouTube stream function is configured
  if (typeof _youtubeStreamFn === 'function') {
    const res = await _youtubeStreamFn(youtubeUrl, options);
    if (res?.stream) return { ...res, source: 'youtube', provider: 'youtube' };
    if (res) return { stream: res, type: StreamType.Arbitrary, seeked: seekSeconds > 0, source: 'youtube', provider: 'youtube' };
  }

  // If _streamFn was overridden in tests and no specific _youtubeStreamFn was set:
  if (_streamFn && _streamFn !== defaultStreamFn) {
    try {
      const res = await _streamFn(youtubeUrl, options);
      if (res?.stream) return { ...res, source: 'youtube', provider: 'youtube' };
      if (res) return { stream: res, type: StreamType.Arbitrary, seeked: seekSeconds > 0, source: 'youtube', provider: 'youtube' };
    } catch (err) {
      throw new Error(`Custom stream provider failed: ${err.message}`);
    }
  }

  const errors = [];

  // Provider 1: play-dl
  try {
    const streamInfo = await playdl.stream(youtubeUrl, { seek: seekSeconds > 0 ? seekSeconds : undefined });
    if (streamInfo?.stream) {
      return {
        stream: streamInfo.stream,
        type: streamInfo.type || StreamType.Arbitrary,
        seeked: seekSeconds > 0,
        source: 'youtube',
        provider: 'youtube',
        matchedTitle: track?.matchedYouTubeTitle || track?.title,
      };
    }
  } catch (err) {
    errors.push(`play-dl: ${err.message || err}`);
  }

  // Provider 2: @distube/ytdl-core
  try {
    const ytdl = require('@distube/ytdl-core');
    const ytdlStream = ytdl(youtubeUrl, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
      begin: seekSeconds > 0 ? `${seekSeconds}s` : undefined,
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const onData = () => {
        if (!settled) {
          settled = true;
          ytdlStream.removeListener('error', onError);
          resolve();
        }
      };
      const onError = (err) => {
        if (!settled) {
          settled = true;
          ytdlStream.removeListener('data', onData);
          reject(err);
        }
      };
      ytdlStream.once('data', onData);
      ytdlStream.once('error', onError);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          ytdlStream.removeListener('data', onData);
          ytdlStream.removeListener('error', onError);
          if (ytdlStream.readable) resolve();
          else reject(new Error('ytdl stream startup timeout'));
        }
      }, 3500);
    });

    let finalStream = ytdlStream;
    let streamType = StreamType.Arbitrary;
    if (seekSeconds > 0 && ffmpegPath) {
      finalStream = createSeekStream(ytdlStream, seekSeconds);
      streamType = StreamType.Raw;
    }

    return {
      stream: finalStream,
      type: streamType,
      seeked: seekSeconds > 0,
      source: 'youtube',
      provider: 'youtube',
      matchedTitle: track?.matchedYouTubeTitle || track?.title,
    };
  } catch (err) {
    errors.push(`ytdl-core: ${err.message || err}`);
  }

  // Provider 3: yt-stream
  try {
    const ytStream = require('yt-stream');
    const res = await ytStream.stream(youtubeUrl, {
      quality: 'high',
      type: 'audio',
      highWaterMark: 1048576,
    });
    if (res?.stream || res?.url) {
      const audioStream = res.stream || res.url;
      let finalStream = audioStream;
      let streamType = res.type || StreamType.Arbitrary;
      if (seekSeconds > 0 && ffmpegPath && res.stream) {
        finalStream = createSeekStream(res.stream, seekSeconds);
        streamType = StreamType.Raw;
      }
      return {
        stream: finalStream,
        type: streamType,
        seeked: seekSeconds > 0,
        source: 'youtube',
        provider: 'youtube',
        matchedTitle: track?.matchedYouTubeTitle || track?.title,
      };
    }
  } catch (err) {
    errors.push(`yt-stream: ${err.message || err}`);
  }

  const detailedErr = errors.join('; ');
  throw new Error(`All YouTube audio extraction providers failed (${detailedErr})`);
}

/* ═══════════════════════════════════════════════════════════════
   RESOLVE AUDIO STREAM — the final step before Discord playback
   Returns { stream, type, seeked, source, provider, matchedTitle? }
   ═══════════════════════════════════════════════════════════════ */

async function resolveAudioStream(track, seekSeconds = 0, retryCount = 1) {
  if (!track) {
    throw new Error('No track provided to resolveAudioStream.');
  }

  // ── Step 1: Detect Provider & Source ──────────────────────────
  const isYouTube =
    track.provider === 'youtube' ||
    Boolean(track.youtubeUrl) ||
    isYouTubeUrl(track.streamUrl) ||
    (typeof track.source === 'string' && track.source.includes('youtube'));

  const isSpotify =
    track.source === 'spotify' ||
    track.source === 'spotify_meta' ||
    Boolean(track.spotifyUrl);

  // ── Step 2: Handle YouTube / Spotify Tracks (Never route to SoundCloud!) ──
  if (isYouTube || isSpotify) {
    // If it's a Spotify track and youtubeUrl is not yet resolved, resolve to YouTube
    if (!track.youtubeUrl && isSpotify) {
      const ytMatch = await matchSpotifyToYouTube(track);
      if (!ytMatch.success || !ytMatch.youtubeUrl) {
        throw new Error(
          `No reliable YouTube match found for "${track.title}" by ${track.artist || 'Unknown'}. ` +
          (ytMatch.reason || 'The available versions did not match the original song.')
        );
      }
      track.provider = 'youtube';
      track.youtubeUrl = ytMatch.youtubeUrl;
      track.youtubeVideoId = extractVideoId(ytMatch.youtubeUrl);
      track.matchedYouTubeTitle = ytMatch.matchedTitle;
      track.matchedYouTubeChannel = ytMatch.matchedArtist;
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
    }

    const targetYtUrl = track.youtubeUrl || (isYouTubeUrl(track.streamUrl) ? track.streamUrl : null);
    if (!targetYtUrl) {
      throw new Error(`YouTube playback failed: No YouTube URL available for track "${track.title}".`);
    }

    if (isUnsafeUrl(targetYtUrl)) {
      throw new Error(`Security: Unsafe stream URL rejected for "${track.title}".`);
    }

    // Preserve provider and video ID
    track.provider = 'youtube';
    if (!track.youtubeVideoId) {
      track.youtubeVideoId = extractVideoId(targetYtUrl);
    }

    try {
      const ytStreamData = await streamYouTubeTrack(targetYtUrl, { seekSeconds, track });
      return ytStreamData;
    } catch (ytErr) {
      // Clear error identifying the actual YouTube extraction failure
      // Never route to SoundCloud or disguise as SoundCloud 404!
      throw new Error(
        `YouTube audio stream extraction failed for "${track.title}" (${targetYtUrl}): ${ytErr.message}`
      );
    }
  }

  // ── Step 3: Direct / Radio Stream ──────────────────────────────
  if (track.source === 'direct' || isDirectUrl(track.streamUrl)) {
    if (isUnsafeUrl(track.streamUrl)) {
      throw new Error(`Security: Unsafe stream URL rejected for "${track.title}".`);
    }
    track.provider = 'direct';
    if (seekSeconds > 0 && ffmpegPath) {
      const raw = createDirectSeekStream(track.streamUrl, seekSeconds);
      return { stream: raw, type: StreamType.Raw, seeked: true, source: 'direct', provider: 'direct' };
    }
    return { stream: track.streamUrl, type: StreamType.Arbitrary, isUrl: true, seeked: false, source: 'direct', provider: 'direct' };
  }

  // ── Step 4: SoundCloud Stream ───────────────────────────────────
  // (Only for tracks whose source/provider is SoundCloud)
  if (!track.streamUrl) {
    if (track.title) {
      const matched = await matchPlayableTrack(track);
      if (!matched.streamUrl) {
        throw new Error(`No playable audio found on SoundCloud for "${track.title}" by ${track.artist || 'Unknown'}.`);
      }
      track.streamUrl = matched.streamUrl;
      track.fallbackUrls = matched.fallbackUrls || [];
      track.matchedTitle = matched.matchedSoundCloudTitle || matched.title;
      track.matchedArtist = matched.matchedSoundCloudArtist || matched.artist;
      track.confidence = matched.confidence;
      if (!track.durationSec && matched.durationSec) track.durationSec = matched.durationSec;
    } else {
      throw new Error('Track has no stream URL and no title to search for.');
    }
  }

  if (isUnsafeUrl(track.streamUrl)) {
    throw new Error(`Security: Unsafe stream URL rejected for "${track.title}".`);
  }

  track.provider = 'soundcloud';

  const ready = await ensureSoundCloudReady();
  if (!ready) throw new Error('SoundCloud client failed to initialize.');

  const candidateUrls = [track.streamUrl, ...(track.fallbackUrls || [])].filter(Boolean);
  const attemptedUrls = new Set();
  let lastErr = null;

  for (const cUrl of candidateUrls) {
    if (attemptedUrls.has(cUrl)) continue;
    attemptedUrls.add(cUrl);

    try {
      const streamInfo = await _streamFn(cUrl);
      if (!streamInfo?.stream) continue;

      if (seekSeconds > 0 && ffmpegPath) {
        const raw = createSeekStream(streamInfo.stream, seekSeconds);
        return { stream: raw, type: StreamType.Raw, seeked: true, source: 'soundcloud', provider: 'soundcloud' };
      }
      return {
        stream:       streamInfo.stream,
        type:         streamInfo.type || StreamType.Arbitrary,
        seeked:       false,
        source:       'soundcloud',
        provider:     'soundcloud',
        matchedTitle: track.matchedTitle || track.title,
      };
    } catch (err) {
      lastErr = err;
      if (err.message?.includes('client_id') || err.message?.includes('401')) {
        await refreshSoundCloudClient();
      }
    }
  }

  // If initial candidate URLs all failed (e.g. 404), attempt a fresh targeted search excluding failed URLs
  if (track.title && (!track.source || track.source === 'soundcloud' || track.source === 'selection')) {
    try {
      const freshCandidates = await searchSoundCloud(`${track.title} ${track.artist || ''}`.trim(), 5);
      for (const fc of freshCandidates) {
        if (!fc.streamUrl || attemptedUrls.has(fc.streamUrl)) continue;
        attemptedUrls.add(fc.streamUrl);
        const scoring = scoreCandidate(fc, track.title);
        if (scoring.penalty > 0) continue; // Skip unrequested remixes
        try {
          const streamInfo = await _streamFn(fc.streamUrl);
          if (streamInfo?.stream) {
            track.streamUrl = fc.streamUrl;
            track.matchedTitle = fc.title;
            if (seekSeconds > 0 && ffmpegPath) {
              const raw = createSeekStream(streamInfo.stream, seekSeconds);
              return { stream: raw, type: StreamType.Raw, seeked: true, source: 'soundcloud', provider: 'soundcloud' };
            }
            return {
              stream:       streamInfo.stream,
              type:         streamInfo.type || StreamType.Arbitrary,
              seeked:       false,
              source:       'soundcloud',
              provider:     'soundcloud',
              matchedTitle: fc.title,
            };
          }
        } catch (fcErr) {
          lastErr = fcErr;
        }
      }
    } catch (_) {}
  }

  if (retryCount > 0) {
    await refreshSoundCloudClient();
    return resolveAudioStream(track, seekSeconds, retryCount - 1);
  }
  throw new Error(`SoundCloud stream failed (HTTP 404 or stream unavailable): ${lastErr?.message || 'All candidate streams failed.'}`);
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
  searchYouTubeHtml,

  // Matching & Scoring
  PENALTY_MODIFIERS,
  getRequestedModifiers,
  scoreCandidate,
  durationScore,
  matchPlayableTrack,
  stringSimilarity,
  rankYouTubeCandidates,
  matchSpotifyToYouTube,
  calculateArtistMatch,
  extractArtists,

  // Streaming
  resolveAudioStream,
  streamYouTubeTrack,
  createSeekStream,
  createDirectSeekStream,
  _setStreamFunction,
  _setYouTubeStreamFunction,
  extractVideoId,

  // Limits
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_SIZE,
};
