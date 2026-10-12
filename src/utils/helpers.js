/**
 * Utility helpers: secret redaction, safe formatting, time parsing, and hierarchy checks.
 */

function redactSecrets(str) {
  if (typeof str !== 'string') return str;
  let cleaned = str;
  const secrets = [
    process.env.DISCORD_TOKEN,
    process.env.SPOTIFY_CLIENT_SECRET,
    process.env.SPOTIFY_CLIENT_ID,
    process.env.OWNER_ID,
  ].filter(Boolean);
  for (const s of secrets) {
    if (s && s.length > 3) cleaned = cleaned.replaceAll(s, '[REDACTED]');
  }
  cleaned = cleaned.replace(/(?:sk_live_|MTA|NDE|OTA|MTB|NzE)[a-zA-Z0-9_\-\.|]{20,}/g, '[REDACTED]');
  return cleaned;
}

function parseDuration(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const match = str.toString().trim().match(/^(\d+)\s*(s|sec|m|min|h|hour|d|day|w|week)?$/i);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();
  switch (unit) {
    case 's': case 'sec': return val * 1000;
    case 'm': case 'min': return val * 60 * 1000;
    case 'h': case 'hour': return val * 60 * 60 * 1000;
    case 'd': case 'day': return val * 24 * 60 * 60 * 1000;
    case 'w': case 'week': return val * 7 * 24 * 60 * 60 * 1000;
    default: return val * 60 * 1000;
  }
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hrs = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hrs > 0) parts.push(`${hrs}h`);
  if (min > 0) parts.push(`${min}m`);
  if (sec > 0 || parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

function isHex(s) {
  return typeof s === 'string' && /^#[0-9A-Fa-f]{6}$/.test(s.trim());
}

async function safeReply(interaction, content, ephemeral = true) {
  try {
    const payload = typeof content === 'string' ? { content, ephemeral } : { ...content, ephemeral };
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(payload);
    } else {
      return await interaction.reply(payload);
    }
  } catch (err) {
    console.error('safeReply failed:', err.message);
  }
}

function countEmojis(str) {
  if (!str) return 0;
  const custom = (str.match(/<a?:[a-zA-Z0-9_]+:[0-9]+>/g) || []).length;
  const unicode = (str.match(/(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g) || []).length;
  return custom + unicode;
}

module.exports = {
  redactSecrets,
  parseDuration,
  formatDuration,
  isHex,
  safeReply,
  countEmojis,
};
