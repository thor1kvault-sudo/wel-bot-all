const https = require('https');

let spotifyAccessToken = null;
let spotifyTokenExpiry = 0;

/**
 * Obtains an authorized Spotify Web API token using Client Credentials if configured in environment.
 */
async function getSpotifyToken() {
  const cid = process.env.SPOTIFY_CLIENT_ID;
  const csec = process.env.SPOTIFY_CLIENT_SECRET;
  if (!cid || !csec) return null;
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiry) return spotifyAccessToken;

  try {
    const creds = Buffer.from(`${cid}:${csec}`).toString('base64');
    const res = await new Promise((resolve) => {
      const req = https.request('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 5000,
      }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve(body));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write('grant_type=client_credentials');
      req.end();
    });

    const parsed = JSON.parse(res);
    if (parsed.access_token) {
      spotifyAccessToken = parsed.access_token;
      spotifyTokenExpiry = Date.now() + ((parsed.expires_in || 3600) - 60) * 1000;
      return spotifyAccessToken;
    }
  } catch (_) {}
  return null;
}

/**
 * Generic HTTPS JSON fetcher with error isolation
 */
function fetchHttpsJson(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null))
      .on('timeout', function() { this.destroy(); resolve(null); });
  });
}

/**
 * Generic HTTPS HTML fetcher with error isolation
 */
function fetchHttpsHtml(url) {
  return new Promise((resolve) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''))
      .on('timeout', function() { this.destroy(); resolve(''); });
  });
}

/**
 * Checks if a string is a Spotify URL
 */
function isSpotifyUrl(url) {
  if (typeof url !== 'string') return false;
  return /^(https?:\/\/)?(open\.)?spotify\.com\/(track|album|playlist|artist)\/[a-zA-Z0-9]+(\?.*)?$/i.test(url.trim());
}

/**
 * Parses a Spotify URL to extract type and clean identifier
 */
function parseSpotifyUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.trim();
  const match = clean.match(/spotify\.com\/(track|album|playlist|artist)\/([a-zA-Z0-9]+)/i);
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    id: match[2],
    cleanUrl: `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`,
  };
}

/**
 * Resolves metadata for Spotify tracks, albums, or playlists.
 * Tries official Web API first (if credentials configured), then falls back to public oEmbed + embed HTML.
 */
async function resolveSpotify(spotifyUrl, maxTracks = 50) {
  const parsed = parseSpotifyUrl(spotifyUrl);
  if (!parsed) return null;

  const { type, id, cleanUrl } = parsed;
  const token = await getSpotifyToken();

  // ── 1. AUTHORIZED WEB API PATH (If credentials configured) ──
  if (token) {
    try {
      if (type === 'track') {
        const data = await fetchHttpsJson(`https://api.spotify.com/v1/tracks/${id}`, { 'Authorization': `Bearer ${token}` });
        if (data && data.name) {
          const artistName = data.artists?.map(a => a.name).join(', ') || 'Unknown Artist';
          return {
            type: 'track',
            name: data.name,
            totalTracks: 1,
            tracks: [{
              title: data.name,
              artist: artistName,
              album: data.album?.name || '',
              durationSec: Math.round((data.duration_ms || 0) / 1000),
              thumbnail: data.album?.images?.[0]?.url || null,
              query: `${data.name} ${artistName}`.trim(),
              spotifyUrl: cleanUrl,
              isrc: data.external_ids?.isrc || null,
            }],
          };
        }
      }

      if (type === 'album') {
        const data = await fetchHttpsJson(`https://api.spotify.com/v1/albums/${id}`, { 'Authorization': `Bearer ${token}` });
        if (data && data.tracks?.items) {
          const albumThumb = data.images?.[0]?.url || null;
          const items = data.tracks.items.slice(0, maxTracks);
          const tracks = items.map(t => {
            const artistName = t.artists?.map(a => a.name).join(', ') || data.artists?.[0]?.name || 'Unknown Artist';
            return {
              title: t.name,
              artist: artistName,
              album: data.name,
              durationSec: Math.round((t.duration_ms || 0) / 1000),
              thumbnail: albumThumb,
              query: `${t.name} ${artistName}`.trim(),
              spotifyUrl: `https://open.spotify.com/track/${t.id}`,
            };
          });
          return {
            type: 'album',
            name: data.name,
            totalTracks: data.tracks.total || tracks.length,
            tracks,
          };
        }
      }

      if (type === 'playlist') {
        const data = await fetchHttpsJson(`https://api.spotify.com/v1/playlists/${id}?fields=name,images,tracks.total,tracks.items(track(id,name,duration_ms,artists(name),album(name,images)))`, { 'Authorization': `Bearer ${token}` });
        if (data && data.tracks?.items) {
          const playThumb = data.images?.[0]?.url || null;
          const items = data.tracks.items.slice(0, maxTracks).filter(i => i.track && i.track.name);
          const tracks = items.map(i => {
            const t = i.track;
            const artistName = t.artists?.map(a => a.name).join(', ') || 'Unknown Artist';
            return {
              title: t.name,
              artist: artistName,
              album: t.album?.name || '',
              durationSec: Math.round((t.duration_ms || 0) / 1000),
              thumbnail: t.album?.images?.[0]?.url || playThumb,
              query: `${t.name} ${artistName}`.trim(),
              spotifyUrl: t.id ? `https://open.spotify.com/track/${t.id}` : cleanUrl,
            };
          });
          return {
            type: 'playlist',
            name: data.name || 'Spotify Playlist',
            totalTracks: data.tracks.total || tracks.length,
            tracks,
          };
        }
      }
    } catch (_) {}
  }

  // ── 2. ZERO-CONFIG PUBLIC FALLBACK (Open Embed Scrape + oEmbed) ──
  if (type === 'track') {
    try {
      // 2A. Primary: Scrape Spotify Embed HTML for exact title, artist list, duration, and cover
      const embedHtml = await fetchHttpsHtml(`https://open.spotify.com/embed/track/${id}`);
      const match = embedHtml.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
      if (match) {
        const parsedData = JSON.parse(match[1]);
        const entity = parsedData?.props?.pageProps?.state?.data?.entity;
        if (entity && (entity.title || entity.name)) {
          const trackTitle = entity.title || entity.name;
          let trackArtist = '';
          if (Array.isArray(entity.artists) && entity.artists.length > 0) {
            trackArtist = entity.artists.map(a => a.name).filter(Boolean).join(', ');
          } else if (entity.subtitle) {
            trackArtist = entity.subtitle;
          }

          const durSec = Math.round((entity.duration || 0) / 1000);
          const thumb = entity.visualIdentity?.image?.[0]?.url || entity.coverArt?.sources?.[0]?.url || null;

          return {
            type: 'track',
            name: trackTitle,
            totalTracks: 1,
            tracks: [{
              title: trackTitle,
              artist: trackArtist || 'Unknown Artist',
              album: entity.album?.name || '',
              durationSec: durSec,
              thumbnail: thumb,
              query: `${trackTitle} ${trackArtist}`.trim(),
              spotifyUrl: cleanUrl,
            }],
          };
        }
      }

      // 2B. Secondary: Public oEmbed API
      const oembed = await fetchHttpsJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
      if (oembed && oembed.title) {
        let title = oembed.title;
        let artist = oembed.author_name || '';

        // Only split on ' - ' if author_name was not provided
        if (!artist && title.includes(' - ')) {
          const parts = title.split(' - ');
          artist = parts[0].trim();
          title = parts.slice(1).join(' - ').trim();
        }

        return {
          type: 'track',
          name: title,
          totalTracks: 1,
          tracks: [{
            title,
            artist: artist || 'Unknown Artist',
            album: '',
            durationSec: 0,
            thumbnail: oembed.thumbnail_url || null,
            query: `${title} ${artist}`.trim(),
            spotifyUrl: cleanUrl,
          }],
        };
      }
    } catch (_) {}
  }

  if (type === 'album' || type === 'playlist') {
    try {
      const embedHtml = await fetchHttpsHtml(`https://open.spotify.com/embed/${type}/${id}`);
      const match = embedHtml.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
      if (match) {
        const parsedData = JSON.parse(match[1]);
        const entity = parsedData?.props?.pageProps?.state?.data?.entity;
        if (entity && Array.isArray(entity.trackList)) {
          const coverArt = entity.coverArt?.sources?.[0]?.url || null;
          const rawTracks = entity.trackList.slice(0, maxTracks);
          const tracks = rawTracks.map(t => {
            const title = t.title || 'Unknown Track';
            const artist = t.subtitle || entity.subtitle || 'Artist';
            return {
              title,
              artist,
              album: entity.name || '',
              durationSec: Math.round((t.duration || 0) / 1000),
              thumbnail: coverArt,
              query: `${title} ${artist}`.trim(),
              spotifyUrl: t.uri ? `https://open.spotify.com/track/${t.uri.split(':').pop()}` : cleanUrl,
            };
          });
          return {
            type,
            name: entity.name || `Spotify ${type}`,
            totalTracks: entity.trackList.length,
            tracks,
          };
        }
      }

      // Secondary fallback via oEmbed if embed HTML is guarded
      const oembed = await fetchHttpsJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
      if (oembed && oembed.title) {
        return {
          type,
          name: oembed.title,
          totalTracks: 1,
          tracks: [{
            title: oembed.title,
            artist: oembed.author_name || 'Spotify',
            album: oembed.title,
            durationSec: 0,
            thumbnail: oembed.thumbnail_url || null,
            query: oembed.title,
            spotifyUrl: cleanUrl,
          }],
        };
      }
    } catch (_) {}
  }

  return null;
}

module.exports = {
  isSpotifyUrl,
  parseSpotifyUrl,
  resolveSpotify,
  getSpotifyToken,
};
