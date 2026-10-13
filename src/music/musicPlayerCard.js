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
 * Generates a Rythm-style rich music player card
 */
function renderPlayerCard(session) {
  const track = session.currentTrack || {
    title: 'Nothing Playing',
    artist: 'Queue is empty',
    durationSec: 0,
    thumbnail: null,
    requestedBy: null,
  };

  const isPlaying = session.isPlaying && !session.isPaused;
  const isPaused = session.isPaused;
  const elapsedSec = session.getPlaybackSeconds ? session.getPlaybackSeconds() : 0;
  const durationSec = track.durationSec || 0;
  const progressBar = renderProgressBar(elapsedSec, durationSec);

  const loopLabels = { off: 'Off', track: '🔂 Track', queue: '🔁 Queue' };
  const loopStr = loopLabels[session.loopMode] || 'Off';

  const embed = new EmbedBuilder()
    .setColor(isPaused ? '#FEE75C' : '#5865F2')
    .setAuthor({
      name: isPaused ? '⏸️ THOR APEX — Playback Paused' : '▶️ THOR APEX — Now Playing',
      iconURL: 'https://cdn.discordapp.com/emojis/1042456078726582322.webp?size=96',
    })
    .setTitle(track.title.slice(0, 250))
    .setDescription(
      `By **${track.artist || 'Unknown Artist'}**\n\n` +
      `\`${formatTime(elapsedSec)}\` ${progressBar} \`${formatTime(durationSec)}\`\n\n` +
      `• **Requested by:** ${track.requestedBy ? `<@${track.requestedBy}>` : 'AutoQueue'}\n` +
      `• **Queue remaining:** \`${session.queue?.length || 0} track(s)\`\n` +
      `• **Loop:** \`${loopStr}\` | **Volume:** \`${session.volume}%\``
    )
    .setFooter({
      text: `Server Session • ${session.guildName || 'THOR APEX Music'} • Inspired by Rythm`,
    })
    .setTimestamp();

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  // Row 1: Primary Playback Controls
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_prev')
      .setLabel('Prev')
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session.history || session.history.length === 0),
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
      .setDisabled(!session.queue || session.queue.length === 0),
    new ButtonBuilder()
      .setCustomId('btn_m_stop')
      .setLabel('Stop')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
  );

  // Row 2: Secondary Modes & Queue
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_m_loop')
      .setLabel(`Loop: ${session.loopMode.toUpperCase()}`)
      .setEmoji('🔁')
      .setStyle(session.loopMode !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_m_shuffle')
      .setLabel('Shuffle')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session.queue || session.queue.length <= 1),
    new ButtonBuilder()
      .setCustomId('btn_m_queue')
      .setLabel('Queue')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = {
  formatTime,
  renderProgressBar,
  renderPlayerCard,
};
