'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

/**
 * Formats seconds into MM:SS or HH:MM:SS
 */
function formatTime(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Generates an interactive visual progress bar
 */
function renderProgressBar(currentSec, totalSec, barLength = 14) {
  if (!totalSec || totalSec <= 0) return '🔴 LIVE STREAM';
  const progress = Math.min(1, Math.max(0, currentSec / totalSec));
  const progressIndex = Math.round(progress * barLength);
  const line = '▬'.repeat(barLength).split('');
  line[Math.min(barLength - 1, progressIndex)] = '🔘';
  return line.join('');
}

/**
 * Generates the Premium THOR APEX Discord Music Control Panel
 * Conforms to compact dark appearance, section labels, aligned buttons, and verified actions.
 *
 * @param {object} session Guild music session
 * @param {object} [options]
 * @param {boolean} [options.compact=false] When true, renders compact 2-row layout
 */
function renderPlayerCard(session, { compact = false } = {}) {
  const track = session?.currentTrack || {
    title: 'Nothing Playing',
    artist: 'Queue is currently empty',
    durationSec: 0,
    thumbnail: null,
    requestedBy: null,
    source: 'idle',
    url: null,
  };

  const isPlaying = Boolean(session?.isPlaying && !session?.isPaused);
  const isPaused = Boolean(session?.isPaused);
  const elapsedSec = session?.getPlaybackSeconds ? session.getPlaybackSeconds() : 0;
  const durationSec = (track.durationSec && track.durationSec > 0)
    ? track.durationSec
    : (track.lavalinkTrack?.info?.length ? Math.round(track.lavalinkTrack.info.length / 1000) : 0);
  const progressBar = renderProgressBar(elapsedSec, durationSec);

  const loopLabels = { off: 'Off', track: '🔂 Track', queue: '🔁 Queue' };
  const loopStr = loopLabels[session?.loopMode] || 'Off';

  const sourceLabels = {
    lavalink: '🟣 Lavalink 4.2.2 (High-Fidelity)',
    soundcloud: '🟠 SoundCloud (Direct Audio)',
    spotify: '🟢 Spotify (Original Match)',
    youtube: '🔴 YouTube (Direct Audio)',
    youtube_meta: '🔴 YouTube (Original Match)',
    direct: '🌐 Direct Stream',
    idle: '⚪ None',
  };
  const sourceStr = sourceLabels[track.source] || (track.source ? `🌐 ${track.source}` : '⚪ Auto');

  // Embed Color: Yellow for paused, Dark sleek blurple for playing, Dark charcoal for idle
  let embedColor = '#2B2D31';
  if (isPaused) embedColor = '#FEE75C';
  else if (isPlaying) embedColor = '#5865F2';

  const voiceState = session?.voiceAssistant?.enabled ? '🟢 Active ("Hey Apex")' : '⚪ Disabled';

  // Actual YouTube source link
  const ytSourceUrl = track.youtubeUrl || track.lavalinkTrack?.info?.uri || null;
  const titleLink = ytSourceUrl || track.spotifyUrl || track.streamUrl || null;
  const titleDisplay = titleLink ? `[${track.title.slice(0, 180)}](${titleLink})` : track.title.slice(0, 200);

  const engineStatus = session?.lavalinkPlayer
    ? '🟣 Lavalink 4.2.2 (Connected / Ready)'
    : (session?.connection?.state?.status === 'ready' ? '🟢 Direct Audio (Active)' : '⚪ Initializing');

  let matchedDisplay = '';
  if (track.matchedTitle && (track.matchedTitle !== track.title || (track.matchedArtist && track.matchedArtist !== track.artist))) {
    const artistPart = track.matchedArtist ? ` by **${track.matchedArtist}**` : '';
    const matchPct = track.confidence ? ` (${Math.round(track.confidence * 100)}% match)` : '';
    matchedDisplay = `• **Matched Track:** "${track.matchedTitle}"${artistPart}${matchPct}\n`;
  }

  const ytDisplay = ytSourceUrl ? `• **YouTube Source:** [Watch Original Full Song](${ytSourceUrl})\n` : '';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setAuthor({
      name: isPaused
        ? '⏸️ THOR APEX — Playback Paused'
        : isPlaying
          ? '▶️ THOR APEX — Now Playing'
          : '⏹️ THOR APEX — Music Control Centre',
      iconURL: 'https://cdn.discordapp.com/emojis/1042456078726582322.webp?size=96',
    })
    .setTitle(titleDisplay)
    .setDescription(
      `👤 **Artist / Uploader:** **${track.artist || 'Unknown'}**\n` +
      `⏱️ \`${formatTime(elapsedSec)}\` ${progressBar} \`${formatTime(durationSec)}\`\n\n` +
      `**📊 Current Session**\n` +
      `• **Status:** \`${isPaused ? 'Paused' : isPlaying ? 'Playing' : 'Idle'}\` | **Volume:** \`${session?.volume || 100}%\` | **Loop:** \`${loopStr}\`\n` +
      `• **Engine:** \`${engineStatus}\`\n` +
      `• **Queue:** \`${session?.queue?.length || 0} track(s)\` | **Voice Assistant:** \`${voiceState}\`\n` +
      `• **Source:** ${sourceStr}\n` +
      ytDisplay +
      matchedDisplay +
      `• **Requested by:** ${track.requestedBy ? `<@${track.requestedBy}>` : 'System'}`
    )
    .setFooter({
      text: `THOR APEX Music Engine • ${session?.guildName || 'Server'} • Use buttons below to control playback`,
    })
    .setTimestamp();

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  // ── COMPACT 2-ROW MODE (for backward compatibility and minimal cards) ──
  if (compact) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_m_prev')
        .setLabel('Prev')
        .setEmoji('⏮️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!session?.history || session.history.length === 0),
      new ButtonBuilder()
        .setCustomId('btn_m_play_pause')
        .setLabel(isPaused ? 'Resume' : 'Pause')
        .setEmoji(isPaused ? '▶️' : '⏸️')
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_m_skip')
        .setLabel('Skip')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!session?.queue || session.queue.length === 0),
      new ButtonBuilder()
        .setCustomId('btn_m_stop')
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_m_loop')
        .setLabel(`Loop: ${(session?.loopMode || 'off').toUpperCase()}`)
        .setEmoji('🔁')
        .setStyle(session?.loopMode && session.loopMode !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('btn_m_shuffle')
        .setLabel('Shuffle')
        .setEmoji('🔀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!session?.queue || session.queue.length <= 1),
      new ButtonBuilder()
        .setCustomId('btn_m_queue')
        .setLabel('Queue')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  // ── PREMIUM 4-ROW CONTROL CENTRE (matching Section 3) ──

  // Section 1: Playback Controls (Previous, Play/Pause, Next, Stop, Disconnect)
  const rowPlayback = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_prev')
      .setLabel('Prev')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.history || session.history.length === 0),
    new ButtonBuilder()
      .setCustomId('btn_m_play_pause')
      .setLabel(isPaused ? 'Resume' : 'Pause')
      .setEmoji(isPaused ? '▶️' : '⏸️')
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_m_skip')
      .setLabel('Next')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.queue || session.queue.length === 0),
    new ButtonBuilder()
      .setCustomId('btn_m_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('btn_m_disconnect')
      .setLabel('Leave')
      .setEmoji('⏏️')
      .setStyle(ButtonStyle.Secondary),
  );

  // Section 2: Music Controls (Queue, Search, Shuffle, Clear)
  const rowMusic = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_queue')
      .setLabel('Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_search')
      .setLabel('Search')
      .setEmoji('🔍')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.queue || session.queue.length <= 1),
    new ButtonBuilder()
      .setCustomId('btn_m_clear')
      .setLabel('Clear')
      .setEmoji('🧹')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.queue || session.queue.length === 0),
  );

  // Section 3: Playback Controls (Volume, Loop, Favorite, Hey Apex Voice)
  const isLoopActive = session?.loopMode && session.loopMode !== 'off';
  const rowControls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_volume')
      .setLabel(`Vol: ${session?.volume || 100}%`)
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_loop')
      .setLabel(`Loop: ${(session?.loopMode || 'off').toUpperCase()}`)
      .setEmoji('🔁')
      .setStyle(isLoopActive ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_fav')
      .setLabel('Favorite')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_voice')
      .setLabel(session?.voiceAssistant?.enabled ? 'Voice: ON' : 'Voice: OFF')
      .setEmoji('🎙️')
      .setStyle(session?.voiceAssistant?.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // Section 4: Library Section (Favorites, History)
  const rowLibrary = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_favorites')
      .setLabel('My Favorites')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_history')
      .setLabel('History')
      .setEmoji('🕒')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session?.history || session.history.length === 0),
  );

  return {
    embeds: [embed],
    components: [rowPlayback, rowMusic, rowControls, rowLibrary],
  };
}

module.exports = {
  formatTime,
  renderProgressBar,
  renderPlayerCard,
  renderMusicPanel: renderPlayerCard,
};
