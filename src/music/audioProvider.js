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
let _streamFn = (...args) => playdl.stream(...args);
function _setStreamFunction(fn) {
  _streamFn = fn || ((...args) => playdl.stream(...args));
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
  const diff = Math.abs(expectedSec - actualSec);
  if (diff <= 3)  return 1.0;
  if (diff <= 10) return 0.85;
  if (diff <= 30) return 0.6;
  return 0.2;
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

function searchYouTubeHtml(query, limit = 5) {
  return new Promise((resolve) => {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 4500,
    }, (res) => {
      let html = '';
      res.on('data', c => html += c);
      res.on('end', () => {
        const match = html.match(/var ytInitialData\s*=\s*({.+?});<\/script>/);
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
    throw new Error('Unable to retrieve metadata for this YouTube link. The video may be private, deleted, or unavailable.');
  }

  // ── 4. Text search: SoundCloud primary with canonical reference scoring ──
  let canonicalMeta = null;
  try {
    const ytResults = await getYouTubeMetadata(q, 3);
    if (ytResults && ytResults.length > 0) {
      canonicalMeta = ytResults[0];
    }
  } catch (_) {}

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

    // Sort descending by finalScore
    scored.sort((a, b) => (b._score || 0) - (a._score || 0));

    // Clean candidates have no unrequested modifier penalties
    const cleanCandidates = scored.filter(c => (c._penalty || 0) === 0);
    const topCandidate = scored[0];

    // Check confident original match: score >= 0.60 and no unrequested modifier penalties
    const isConfident = topCandidate && topCandidate._score >= 0.60 && (topCandidate._penalty || 0) === 0;

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

    // No confident original match available:
    // Surface candidate list and set requiresChoice to let user choose rather than silently playing remix
    const choiceList = (cleanCandidates.length > 0 ? cleanCandidates : scored).slice(0, limit);
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

  // ── 5. Fallback: parse YouTube metadata and surface as info-only ─
  const ytMeta = canonicalMeta ? [canonicalMeta] : await getYouTubeMetadata(q, limit);
  if (ytMeta.length > 0) {
    return ytMeta.map(m => ({
      ...m, streamUrl: null, youtubeBlocked: true, confidence: 0.7,
    }));
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

    // 6. Large duration discrepancy penalty (> 60s)
    if (spotifyTrack.durationSec > 0 && c.durationSec > 0) {
      const diff = Math.abs(spotifyTrack.durationSec - c.durationSec);
      if (diff > 60) {
        penalty += 0.40;
        penaltyWords.push('duration_mismatch');
      }
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
      : (titleSim * 0.55 + artistMatch * 0.45 + officialBonus);

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

  for (const q of queries) {
    try {
      const results = await getYouTubeMetadata(q, 5);
      for (const r of results) {
        if (r.youtubeUrl && !seenUrls.has(r.youtubeUrl)) {
          seenUrls.add(r.youtubeUrl);
          allCandidates.push(r);
        }
      }
      if (allCandidates.length >= 10) break; // Collect at least 10 candidates across search variations
    } catch (_) {}
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
  // Strong agreement: high score, matching artist or containment, zero penalties
  const hasArtistMatch = !spotifyTrack.artist || (best.artistMatch >= 0.40);
  const isHighConfidence = best && best.finalScore >= 0.58 && hasArtistMatch && best.penalty === 0;

  if (isHighConfidence) {
    return {
      success: true,
      requiresChoice: false,
      bestCandidate: best,
      youtubeUrl: best.youtubeUrl,
      matchedTitle: best.title,
      matchedArtist: best.artist,
      durationSec: (spotifyTrack.durationSec && spotifyTrack.durationSec > 0) ? spotifyTrack.durationSec : best.durationSec,
      thumbnail: best.thumbnail || spotifyTrack.thumbnail,
      confidence: best.finalScore,
      candidates: ranked,
    };
  }

  // Medium confidence: candidate has reasonable match without different-artist penalty (show best 3 for user choice)
  const cleanCandidates = ranked.filter(c => (c.penalty || 0) === 0 && !c.isDifferentArtist);
  const isMediumConfidence = best && best.finalScore >= 0.40 && (best.penalty || 0) === 0 && cleanCandidates.length > 0;

  if (isMediumConfidence) {
    return {
      success: false,
      requiresChoice: true,
      bestCandidate: best,
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
      : `No confident official YouTube version found for "${spotifyTrack.title}" by ${spotifyTrack.artist || 'Unknown'}. Top candidate scored ${best?.finalScore || 0}.`,
    bestCandidate: best || null,
    candidates: ranked,
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

async function resolveAudioStream(track, seekSeconds = 0, retryCount = 1) {
  // ── Step 1: Resolve streamUrl if not already present ──────────
  if (!track.streamUrl) {
    if (track.source === 'spotify' || track.youtubeBlocked || track.source === 'youtube_meta') {
      const matched = await matchPlayableTrack(track);
      if (!matched.streamUrl) {
        throw new Error(
          `No reliable audio match found for "${track.title}" by ${track.artist || 'Unknown'}. ` +
          `The available versions did not match the original song.`
        );
      }
      track.streamUrl = matched.streamUrl;
      track.fallbackUrls = matched.fallbackUrls || [];
      track.matchedTitle = matched.matchedSoundCloudTitle || matched.matchedYouTubeTitle || matched.title;
      track.matchedArtist = matched.matchedSoundCloudArtist || matched.matchedYouTubeChannel || matched.artist;
      track.confidence = matched.confidence;
      if (!track.durationSec && matched.durationSec) track.durationSec = matched.durationSec;
    } else if (track.title) {
      const matched = await matchPlayableTrack(track);
      if (!matched.streamUrl) {
        throw new Error(`No playable audio found for "${track.title}" by ${track.artist || 'Unknown'}.`);
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
        return { stream: raw, type: StreamType.Raw, seeked: true, source: 'soundcloud' };
      }
      return {
        stream:       streamInfo.stream,
        type:         streamInfo.type || StreamType.Arbitrary,
        seeked:       false,
        source:       'soundcloud',
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
              return { stream: raw, type: StreamType.Raw, seeked: true, source: 'soundcloud' };
            }
            return {
              stream:       streamInfo.stream,
              type:         streamInfo.type || StreamType.Arbitrary,
              seeked:       false,
              source:       'soundcloud',
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
  createSeekStream,
  createDirectSeekStream,
  _setStreamFunction,

  // Limits
  MAX_PLAYLIST_TRACKS,
  MAX_QUEUE_SIZE,
};
