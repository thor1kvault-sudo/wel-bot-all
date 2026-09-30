const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionsBitField, REST, Routes, SlashCommandBuilder, AuditLogEvent,
} = require('discord.js');
require('dotenv').config();
const fs2   = require('fs');
const path2 = require('path');
const http  = require('http');

try { const ff = require('ffmpeg-static'); if (ff) process.env.FFMPEG_PATH = ff; } catch (_) {}

process.on('unhandledRejection', r => console.error('Unhandled Rejection:', r));
process.on('uncaughtException',  e => console.error('Uncaught Exception:', e));

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', bot: 'THOR APEX All-in-One Bot', uptime: Math.floor(process.uptime()) }));
}).listen(PORT, '0.0.0.0', () => console.log('Health server on port ' + PORT));

const BOT_OWNER_ID = process.env.OWNER_ID || '';
const DATA_DIR = path2.join(__dirname, 'data');
if (!fs2.existsSync(DATA_DIR)) fs2.mkdirSync(DATA_DIR, { recursive: true });

function loadData(f) {
  const p = path2.join(DATA_DIR, f);
  if (fs2.existsSync(p)) { try { return JSON.parse(fs2.readFileSync(p, 'utf8')); } catch (_) {} }
  return {};
}
function saveData(f, d) { try { fs2.writeFileSync(path2.join(DATA_DIR, f), JSON.stringify(d, null, 2)); } catch (e) { console.error('Save error:', e.message); } }

let config     = loadData('config.json');
let warnings   = loadData('warnings.json');
let inviteData = loadData('invites.json');
const saveConfig     = () => saveData('config.json',   config);
const saveWarnings   = () => saveData('warnings.json', warnings);
const saveInviteData = () => saveData('invites.json',  inviteData);

const DEFSEC = {
  antiRaid: false, antiSpam: true, antiLink: true, antiAds: true,
  wordFilter: true, altDetection: true, altMinDays: 7, antiNuke: true,
  lockdown: false,
  blacklistedWords: ['nigga','nigger','fuck','shit','bitch','asshole','retard'],
  allowedLinks: [], raidThreshold: 10, spamThreshold: 5, spamWindow: 5000, nukeThreshold: 5,
};

if (!config.embedColor) {
  config = {
    welcomeChannelId: '', leaveChannelId: '', rulesChannelId: '', rolesChannelId: '',
    generalChannelId: '', logChannelId: '', muteRoleId: '', autoRoleId: '',
    embedColor: '#5865F2', welcomeTitle: 'WELCOME TO THOR APEX!',
    greetingPrefix: 'HEY BUDDY!', welcomeSubtitle: 'Welcome to THOR APEX!',
    outroText: 'Hope you enjoy your stay in THOR APEX!',
    leaveText: 'Goodbye **{username}**! We now have **{count}** members.',
    security: DEFSEC, ...config,
  };
  if (!config.security) config.security = { ...DEFSEC };
  saveConfig();
}

// ── Voice / Music
let voiceLib = null; try { voiceLib = require('@discordjs/voice'); } catch (e) { console.log('Voice:', e.message); }
let playdl   = null; try { playdl   = require('play-dl');          } catch (e) { console.log('play-dl:', e.message); }
let isPlayDlReady = false;
async function ensurePlayDlReady() {
  if (!playdl || isPlayDlReady) return;
  try { const c = await playdl.getFreeClientID(); if (c) { await playdl.setToken({ soundcloud: { client_id: c } }); isPlayDlReady = true; } } catch (_) {}
}

const musicQueues = new Map();
function getQ(gid) {
  if (!musicQueues.has(gid)) musicQueues.set(gid, { connection: null, player: null, queue: [], isPlaying: false });
  return musicQueues.get(gid);
}
async function playTrack(gid) {
  if (!voiceLib) return;
  const q = getQ(gid); if (!q || !q.connection) return;
  await ensurePlayDlReady();
  if (!q.player) {
    try {
      q.player = voiceLib.createAudioPlayer({ behaviors: { noSubscriber: voiceLib.NoSubscriberBehavior.Play, maxMissedFrames: Math.round(5000/20) } });
      q.connection.subscribe(q.player);
      q.player.on(voiceLib.AudioPlayerStatus.Idle, old => {
        if (old.status === voiceLib.AudioPlayerStatus.Playing || old.status === voiceLib.AudioPlayerStatus.Buffering) {
          q.queue.shift(); if (q.queue.length > 0) playTrack(gid); else q.isPlaying = false;
        }
      });
      q.player.on('error', () => { q.queue.shift(); if (q.queue.length > 0) playTrack(gid); else q.isPlaying = false; });
    } catch (_) { return; }
  } else if (q.connection) { try { q.connection.subscribe(q.player); } catch (_) {} }
  const track = q.queue[0]; if (!track) { q.isPlaying = false; return; }
  try {
    let so = null;
    if (playdl) {
      const sr = await playdl.search(track.title || track.query, { source: { soundcloud: 'tracks' }, limit: 1 });
      if (sr && sr[0] && sr[0].url) { const r = await playdl.stream(sr[0].url); if (r && r.stream) so = r; }
    }
    if (!so) { q.queue.shift(); if (q.queue.length > 0) playTrack(gid); return; }
    const res = voiceLib.createAudioResource(so.stream, { inputType: so.type });
    q.isPlaying = true; q.player.play(res);
  } catch (_) { q.queue.shift(); if (q.queue.length > 0) playTrack(gid); else q.isPlaying = false; }
}
function addToQ(guild, vc, user, query) {
  const q = getQ(guild.id); let title = query, isUrl = false;
  try { new URL(query); isUrl = true; title = 'Song Link'; } catch (_) {}
  const track = { title, query, url: isUrl ? query : '', requestedBy: user.id };
  q.queue.push(track);
  if (voiceLib && vc) {
    if (!q.connection) { try { q.connection = voiceLib.joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false }); } catch (_) {} }
    if (!q.isPlaying) playTrack(guild.id);
  }
  return { track, position: q.queue.length };
}

// ── Invite Tracking
const invCache = new Map();
async function cacheInvites(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return;
    const inv = await guild.invites.fetch().catch(() => null);
    if (!inv) return;
    const m = new Map(); inv.forEach(i => m.set(i.code, i.uses || 0));
    invCache.set(guild.id, m);
  } catch (_) {}
}
async function findInviter(guild) {
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return null;
    const cached = invCache.get(guild.id) || new Map();
    const ni = await guild.invites.fetch().catch(() => null);
    if (!ni) return null;
    let used = null; ni.forEach(i => { if (i.uses > (cached.get(i.code) || 0) && !used) used = i; });
    const upd = new Map(); ni.forEach(i => upd.set(i.code, i.uses || 0)); invCache.set(guild.id, upd);
    if (used && used.inviter) {
      let total = 0; ni.forEach(i => { if (i.inviter && i.inviter.id === used.inviter.id) total += (i.uses || 0); });
      const uid = used.inviter.id;
      if (!inviteData[uid]) inviteData[uid] = { uses: 0 };
      inviteData[uid].uses = total; saveInviteData();
      return { inviterId: uid, inviterTag: used.inviter.tag, uses: total };
    }
  } catch (_) {}
  return null;
}

// ── Security Helpers
const spamMap = new Map();
function isSpamming(uid) {
  const now = Date.now(), thr = config.security?.spamThreshold || 5, win = config.security?.spamWindow || 5000;
  if (!spamMap.has(uid)) spamMap.set(uid, []);
  const t = spamMap.get(uid).filter(x => now - x < win); t.push(now); spamMap.set(uid, t);
  return t.length >= thr;
}
const recentJoins = [];
function isRaiding() {
  const now = Date.now(), thr = config.security?.raidThreshold || 10;
  const r = recentJoins.filter(t => now - t < 10000); r.push(now); recentJoins.length = 0; recentJoins.push(...r);
  return r.length >= thr;
}
const nukeMap = new Map();
function isNuking(uid) {
  const now = Date.now(), thr = config.security?.nukeThreshold || 5;
  if (!nukeMap.has(uid)) nukeMap.set(uid, []);
  const t = nukeMap.get(uid).filter(x => now - x < 10000); t.push(now); nukeMap.set(uid, t);
  return t.length >= thr;
}

function isHex(s) { return /^#[0-9A-Fa-f]{6}$/.test(s); }
async function sendLog(guild, embed) {
  if (!config.logChannelId) return;
  try { const ch = guild.channels.cache.get(config.logChannelId); if (ch?.isTextBased()) await ch.send({ embeds: [embed] }); } catch (_) {}
}
async function safeReply(i, content, eph = true) {
  try { if (i.replied || i.deferred) await i.followUp({ content, ephemeral: eph }); else await i.reply({ content, ephemeral: eph }); } catch (_) {}
}
async function getMuteRole(guild) {
  if (config.muteRoleId) { const r = guild.roles.cache.get(config.muteRoleId); if (r) return r; }
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'muted');
  if (role) return role;
  try {
    role = await guild.roles.create({ name: 'Muted', color: '#818386', reason: 'THOR APEX Security' });
    for (const [, ch] of guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.create(role, { SendMessages: false, AddReactions: false }).catch(() => {});
    config.muteRoleId = role.id; saveConfig(); return role;
  } catch (_) { return null; }
}

// ── Embed Builders
function mkWelcomeEmbed(member, guild, inviterData) {
  const chs = guild?.channels?.cache;
  const rCh   = (config.rulesChannelId && chs?.get(config.rulesChannelId)) || chs?.find(c => /rule/i.test(c.name));
  const funCh  = chs?.find(c => /fun/i.test(c.name));
  const editCh = chs?.find(c => /edit/i.test(c.name));
  const gameCh = chs?.find(c => /gaming|game/i.test(c.name));
  const genCh  = (config.generalChannelId && chs?.get(config.generalChannelId)) || chs?.find(c => /general|chat/i.test(c.name));
  const rolCh  = (config.rolesChannelId && chs?.get(config.rolesChannelId)) || chs?.find(c => /role/i.test(c.name));
  const tag = (ch, fb) => ch ? ('<#' + (typeof ch === 'string' ? ch : ch.id) + '>') : ('`#' + fb + '`');
  const uid = member?.user?.id || member?.id || '0';
  const lines = [
    '### ' + (config.greetingPrefix || 'HEY BUDDY!') + ' <@' + uid + '>\n',
    '**' + (config.welcomeSubtitle || 'Welcome to THOR APEX!') + '**\n',
  ];
  if (inviterData?.inviterId) lines.push('**Invited by:** <@' + inviterData.inviterId + '> (Total Invites: **' + inviterData.uses + '**)\n');
  else lines.push('**Invited by:** Direct Link / Unknown\n');
  lines.push('**Get Started:** ' + tag(rCh, 'rules') + '\n', '**Rules:** ' + tag(rCh, 'rules') + '\n');
  if (funCh)  lines.push('**Fun Zone:** ' + tag(funCh, 'fun') + '\n');
  if (editCh) lines.push('**Editing:** ' + tag(editCh, 'editing') + '\n');
  if (gameCh) lines.push('**Gaming:** ' + tag(gameCh, 'gaming') + '\n');
  lines.push('**Chill Here:** ' + tag(genCh, 'general') + '\n');
  if (rolCh)  lines.push('**Get Roles:** ' + tag(rolCh, 'roles') + '\n');
  lines.push('\n### ' + (config.outroText || 'Thanks For Joining!'));
  const logo   = guild.iconURL({ size: 1024, forceStatic: false });
  const banner = guild.bannerURL({ size: 1024 });
  const avatar = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
  const embed  = new EmbedBuilder().setColor(isHex(config.embedColor) ? config.embedColor : '#5865F2').setDescription(lines.join('\n')).setTimestamp();
  if (logo) embed.setAuthor({ name: config.welcomeTitle || 'WELCOME TO THOR APEX!', iconURL: logo }); else embed.setAuthor({ name: config.welcomeTitle || 'WELCOME TO THOR APEX!' });
  if (avatar) embed.setThumbnail(avatar); else if (logo) embed.setThumbnail(logo);
  if (banner) embed.setImage(banner);
  embed.setFooter({ text: 'THOR APEX Member #' + guild.memberCount, iconURL: logo || undefined });
  return embed;
}
function mkLeaveEmbed(member, guild) {
  const username = member.user?.tag || member.user?.username || 'Member';
  const logo = guild.iconURL({ size: 1024, forceStatic: false });
  const msg  = (config.leaveText || 'Goodbye **{username}**! We now have **{count}** members.').replace(/{user}/g, '<@' + member.id + '>').replace(/{username}/g, username).replace(/{server}/g, guild.name).replace(/{count}/g, guild.memberCount || 0);
  const embed = new EmbedBuilder().setColor('#ED4245').setTitle('Member Left - ' + guild.name).setDescription('### ' + msg).setTimestamp();
  const av = member?.user?.displayAvatarURL({ size: 256, forceStatic: false }); if (av) embed.setThumbnail(av);
  embed.setFooter({ text: 'THOR APEX Total Members: ' + (guild.memberCount || 0), iconURL: logo || undefined });
  return embed;
}

// ── Slash Commands Builder
function buildCmds() {
  return [
    new SlashCommandBuilder().setName('setup').setDescription('Auto-setup the bot').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName('setwelcome').setDescription('Set welcome channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(false)),
    new SlashCommandBuilder().setName('setleave').setDescription('Set leave channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setrules').setDescription('Set rules channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setroles').setDescription('Set roles channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setgeneral').setDescription('Set general channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setlog').setDescription('Set mod log channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)),
    new SlashCommandBuilder().setName('setwelcomecolor').setDescription('Set embed color').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('color').setDescription('Hex e.g. #FF5733').setRequired(true)),
    new SlashCommandBuilder().setName('setwelcometext').setDescription('Customize welcome text').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('greeting').setDescription('Greeting prefix').setRequired(false)).addStringOption(o => o.setName('subtitle').setDescription('Welcome subtitle').setRequired(false)).addStringOption(o => o.setName('outro').setDescription('Closing line').setRequired(false)),
    new SlashCommandBuilder().setName('setleavetext').setDescription('Customize leave text').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('message').setDescription('Use {username} {user} {count}').setRequired(true)),
    new SlashCommandBuilder().setName('setautorole').setDescription('Set auto-role for new members').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)),
    new SlashCommandBuilder().setName('welcomeconfig').setDescription('View bot config').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder().setName('testwelcome').setDescription('Preview welcome message'),
    new SlashCommandBuilder().setName('testleave').setDescription('Preview leave message'),
    new SlashCommandBuilder().setName('security').setDescription('View security settings').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder().setName('antispam').setDescription('Toggle anti-spam').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antilink').setDescription('Toggle anti-link/ads').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antiraid').setDescription('Toggle anti-raid').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('antinuke').setDescription('Toggle anti-nuke').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('altdetection').setDescription('Toggle alt account detection').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })).addIntegerOption(o => o.setName('mindays').setDescription('Min account age in days').setRequired(false)),
    new SlashCommandBuilder().setName('wordfilter').setDescription('Toggle word filter').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('addword').setDescription('Add word to blacklist').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('word').setDescription('Word').setRequired(true)),
    new SlashCommandBuilder().setName('removeword').setDescription('Remove word from blacklist').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('word').setDescription('Word').setRequired(true)),
    new SlashCommandBuilder().setName('lockdown').setDescription('Toggle server lockdown').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('toggle').setDescription('on or off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('warnings').setDescription('View warnings for a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('clearwarns').setDescription('Clear all warnings for a user').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('mute').setDescription('Mute a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),
    new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID').setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers).addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true)),
    new SlashCommandBuilder().setName('purge').setDescription('Delete messages in bulk').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages).addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName('myinvites').setDescription('Check your total invites'),
    new SlashCommandBuilder().setName('invites').setDescription('Check invites for a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(false)),
    new SlashCommandBuilder().setName('invitetop').setDescription('Top inviters leaderboard'),
    new SlashCommandBuilder().setName('play').setDescription('Play a song').addStringOption(o => o.setName('song').setDescription('Song name or link').setRequired(true)),
    new SlashCommandBuilder().setName('pause').setDescription('Pause music'),
    new SlashCommandBuilder().setName('resume').setDescription('Resume music'),
    new SlashCommandBuilder().setName('skip').setDescription('Skip current song'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop music and leave voice'),
    new SlashCommandBuilder().setName('queue').setDescription('View or add to music queue').addStringOption(o => o.setName('song').setDescription('Song to add').setRequired(false)),
    new SlashCommandBuilder().setName('nowplaying').setDescription('Show currently playing song'),
    new SlashCommandBuilder().setName('radio').setDescription('Play 24/7 radio stream').addStringOption(o => o.setName('genre').setDescription('Genre').setRequired(false).addChoices({ name: 'Lofi Chill', value: 'lofi' }, { name: 'Gaming Beats', value: 'gaming' }, { name: 'Pop Hits', value: 'pop' }, { name: 'Chill Hop', value: 'chill' })),
    new SlashCommandBuilder().setName('automod').setDescription('Manage Discord native AutoMod rules').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild).addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true).addChoices({ name: 'enable', value: 'enable' }, { name: 'disable', value: 'disable' }, { name: 'status', value: 'status' })),
    new SlashCommandBuilder().setName('help').setDescription('Show all bot commands'),
  ].map(c => c.toJSON());
}

const RADIO_STREAMS = {
  lofi:   { name: 'Lofi Chill 24/7',   url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
  gaming: { name: 'Gaming Beats 24/7', url: 'https://stream.zeno.fm/0r0xa792kwzuv' },
  pop:    { name: 'Pop Hits 24/7',     url: 'https://stream.zeno.fm/z52x2szx0h8uv' },
  chill:  { name: 'Chill Hop 24/7',    url: 'https://stream.zeno.fm/f3wvbbqmdg8uv' },
};

// ── Main Bot
async function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildModeration,
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Channel, Partials.Message],
  });

  client.once('clientReady', async () => {
    console.log('=======================================================');
    console.log('THOR APEX All-in-One Bot is ONLINE!');
    console.log('Logged in as: ' + client.user.tag);
    console.log('Servers: ' + client.guilds.cache.size);
    client.guilds.cache.forEach(g => console.log('  ' + g.name + ' (' + g.id + ')'));
    console.log('=======================================================');
    for (const g of client.guilds.cache.values()) await cacheInvites(g);
    await regCmds(client);
  });

  async function regCmds(c) {
    const token = process.env.DISCORD_TOKEN; if (!token) return;
    const rest  = new REST({ version: '10' }).setToken(token);
    const cmds  = buildCmds();
    try {
      for (const guild of c.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(c.user.id, guild.id), { body: cmds });
        console.log('Commands registered: ' + guild.name);
      }
      await rest.put(Routes.applicationCommands(c.user.id), { body: cmds });
      console.log('Global commands updated!');
    } catch (err) { console.error('Command registration error:', err.message); }
  }

  client.on('guildCreate', async (guild) => {
    console.log('Joined: ' + guild.name);
    await cacheInvites(guild);
    const token = process.env.DISCORD_TOKEN;
    if (token) { const rest = new REST({ version: '10' }).setToken(token); await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: buildCmds() }).catch(() => {}); }
  });

  // ── Member Joined
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.partial) { member = await member.fetch().catch(() => null); if (!member) return; }
      const guild = member.guild; const sec = config.security || {};
      console.log('Joined: ' + member.user.tag + ' in ' + guild.name);

      // Alt Detection
      if (sec.altDetection) {
        const minDays = sec.altMinDays || 7;
        const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
        if (ageDays < minDays) {
          try { await member.kick('Alt account - ' + ageDays + ' days old, min ' + minDays); } catch (_) {}
          await sendLog(guild, new EmbedBuilder().setColor('#FF0000').setTitle('Alt Account Kicked').addFields({ name: 'User', value: member.user.tag + ' (' + member.id + ')' }, { name: 'Account Age', value: ageDays + ' days' }, { name: 'Minimum', value: minDays + ' days' }).setTimestamp());
          return;
        }
      }
      // Anti-Raid
      if (sec.antiRaid && isRaiding()) {
        config.security.lockdown = true; saveConfig();
        try { await member.kick('Anti-Raid: raid detected'); } catch (_) {}
        await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('RAID DETECTED - Lockdown Activated!').setTimestamp());
        return;
      }
      // Lockdown
      if (sec.lockdown) { try { await member.kick('Server is in lockdown.'); } catch (_) {} return; }

      const inviterData = await findInviter(guild);

      // Welcome
      let wCh = null;
      if (config.welcomeChannelId) wCh = guild.channels.cache.get(config.welcomeChannelId) || await guild.channels.fetch(config.welcomeChannelId).catch(() => null);
      if (!wCh) wCh = guild.channels.cache.find(c => c.isTextBased() && /welcome|join|arrivals/i.test(c.name));
      if (!wCh) wCh = guild.systemChannel;
      if (wCh) { await wCh.send({ content: 'Welcome <@' + member.id + '> to **' + guild.name + '**!', embeds: [mkWelcomeEmbed(member, guild, inviterData)] }); console.log('Welcome sent for ' + member.user.tag); }

      // Auto-Role
      if (config.autoRoleId) { try { const role = guild.roles.cache.get(config.autoRoleId); if (role) await member.roles.add(role, 'Auto-Role'); } catch (_) {} }
    } catch (err) { console.error('guildMemberAdd error:', err); }
  });

  // ── Member Left
  client.on('guildMemberRemove', async (member) => {
    try {
      if (member.partial) { member = await member.fetch().catch(() => null); if (!member) return; }
      let lCh = null;
      if (config.leaveChannelId) lCh = member.guild.channels.cache.get(config.leaveChannelId);
      if (!lCh) lCh = member.guild.channels.cache.find(c => c.isTextBased() && /leave|goodbye|farewell/i.test(c.name));
      if (!lCh) return;
      await lCh.send({ embeds: [mkLeaveEmbed(member, member.guild)] });
    } catch (err) { console.error('guildMemberRemove error:', err); }
  });

  // ── Messages
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const member  = message.member;
    const isAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const isMod   = member?.permissions?.has(PermissionsBitField.Flags.ModerateMembers);
    const sec = config.security || {};

    if (!isAdmin && !isMod) {
      // Anti-Spam
      if (sec.antiSpam && isSpamming(message.author.id)) {
        await message.delete().catch(() => {});
        const mr = await getMuteRole(message.guild);
        if (mr && member) {
          try {
            await member.roles.add(mr, 'Auto-muted: Spamming');
            await message.channel.send({ content: '<@' + message.author.id + '> muted for spamming!' });
            setTimeout(async () => { try { await member.roles.remove(mr); } catch (_) {} }, 5 * 60 * 1000);
          } catch (_) {}
        }
        await sendLog(message.guild, new EmbedBuilder().setColor('#FF6600').setTitle('Anti-Spam - User Muted').addFields({ name: 'User', value: message.author.tag }, { name: 'Channel', value: '<#' + message.channel.id + '>' }).setTimestamp());
        return;
      }
      // Anti-Link
      if (sec.antiLink) {
        const hasInv = /discord\.gg\/|discord\.com\/invite\//i.test(message.content);
        const hasExt = sec.antiAds && /https?:\/\/(?!discord\.com)/i.test(message.content);
        if (hasInv || hasExt) {
          const ok = (sec.allowedLinks || []).some(d => message.content.includes(d));
          if (!ok) {
            await message.delete().catch(() => {});
            try { await message.channel.send({ content: '<@' + message.author.id + '> Links/ads are not allowed here!' }); } catch (_) {}
            await sendLog(message.guild, new EmbedBuilder().setColor('#FF6600').setTitle('Anti-Link - Link Blocked').addFields({ name: 'User', value: message.author.tag }, { name: 'Type', value: hasInv ? 'Discord Invite' : 'External Link' }).setTimestamp());
            return;
          }
        }
      }
      // Word Filter
      if (sec.wordFilter) {
        const lower = message.content.toLowerCase();
        const bad = (sec.blacklistedWords || []).find(w => lower.includes(w.toLowerCase()));
        if (bad) {
          await message.delete().catch(() => {});
          try { await message.channel.send({ content: '<@' + message.author.id + '> Watch your language!' }); } catch (_) {}
          await sendLog(message.guild, new EmbedBuilder().setColor('#FF6600').setTitle('Word Filter - Message Deleted').addFields({ name: 'User', value: message.author.tag }).setTimestamp());
          return;
        }
      }
    }

    const content = message.content.trim();
    if (!content.startsWith('!')) return;
    const args = content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();

    if (cmd === 'play' || cmd === 'p') { const inp = args.join(' '); const vc = message.member?.voice?.channel; if (!vc) return message.reply('Join a Voice Channel first!'); if (!inp) return message.reply('Provide a song name or link!'); const r = addToQ(message.guild, vc, message.author, inp); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(r.position === 1 ? 'Now Playing' : 'Added to Queue').setDescription('**' + r.track.title + '**').setTimestamp()] }); }
    if (cmd === 'stop') { const q = getQ(message.guild.id); q.queue = []; q.isPlaying = false; if (q.connection) { try { q.connection.destroy(); } catch (_) {} q.connection = null; } return message.reply('Stopped.'); }
    if (cmd === 'skip' || cmd === 's') { const q = getQ(message.guild.id); if (q.queue.length > 0) { const s = q.queue.shift(); return message.reply('Skipped: **' + (s?.title || 'Song') + '**'); } return message.reply('Queue empty!'); }
    if (cmd === 'pause') return message.reply('Paused.');
    if (cmd === 'resume') return message.reply('Resumed.');
    if (cmd === 'queue' || cmd === 'q') { const inp = args.join(' '); const vc = message.member?.voice?.channel; if (inp) { if (!vc) return message.reply('Join Voice first!'); const r = addToQ(message.guild, vc, message.author, inp); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Added to Queue').setDescription('**' + r.track.title + '**').setTimestamp()] }); } const q = getQ(message.guild.id); if (q.queue.length === 0) return message.reply('Queue empty! Use !play'); const list = q.queue.slice(0, 10).map((t, i) => (i + 1) + '. **' + t.title + '**').join('\n'); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Music Queue').setDescription(list).setFooter({ text: 'Total: ' + q.queue.length }).setTimestamp()] }); }
    if (cmd === 'np' || cmd === 'nowplaying') { const q = getQ(message.guild.id); const t = q.queue[0]; if (!t) return message.reply('Nothing playing!'); return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Now Playing').setDescription('**' + t.title + '**').setTimestamp()] }); }
    if (cmd === 'radio') { const vc = message.member?.voice?.channel; if (!vc) return message.reply('Join Voice first!'); const genre = args[0]?.toLowerCase() || 'lofi'; const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi; const q = getQ(message.guild.id); if (voiceLib) { if (!q.connection) { try { q.connection = voiceLib.joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: false }); } catch (_) {} } if (!q.player) { q.player = voiceLib.createAudioPlayer(); q.connection?.subscribe(q.player); } try { q.player.play(voiceLib.createAudioResource(sel.url, { inputType: voiceLib.StreamType.Arbitrary })); } catch (_) {} } return message.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Radio: ' + sel.name).setDescription('Playing in <#' + vc.id + '>!').setTimestamp()] }); }
    if (cmd === 'testwelcome') return message.reply({ content: '[TEST] Welcome <@' + message.author.id + '>!', embeds: [mkWelcomeEmbed(message.member, message.guild)] });
    if (cmd === 'warn' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !warn @user [reason]'); if (!warnings[uid]) warnings[uid] = []; warnings[uid].push({ reason, mod: message.author.tag, ts: Date.now() }); saveWarnings(); return message.reply('<@' + uid + '> warned. Reason: **' + reason + '** (Total: ' + warnings[uid].length + ')'); }
    if (cmd === 'mute' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !mute @user'); try { const t = await message.guild.members.fetch(uid); const mr = await getMuteRole(message.guild); if (mr) { await t.roles.add(mr, reason); return message.reply('<@' + uid + '> muted.'); } } catch (_) { return message.reply('Could not mute.'); } }
    if (cmd === 'unmute' && isMod) { const uid = args[0]?.replace(/[<@!>]/g, ''); if (!uid) return message.reply('Usage: !unmute @user'); try { const t = await message.guild.members.fetch(uid); const mr = await getMuteRole(message.guild); if (mr) { await t.roles.remove(mr); return message.reply('<@' + uid + '> unmuted.'); } } catch (_) { return message.reply('Could not unmute.'); } }
    if (cmd === 'kick' && member?.permissions?.has(PermissionsBitField.Flags.KickMembers)) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !kick @user'); try { const t = await message.guild.members.fetch(uid); await t.kick(reason); return message.reply('<@' + uid + '> kicked.'); } catch (_) { return message.reply('Could not kick.'); } }
    if (cmd === 'ban' && member?.permissions?.has(PermissionsBitField.Flags.BanMembers)) { const uid = args[0]?.replace(/[<@!>]/g, ''); const reason = args.slice(1).join(' ') || 'No reason'; if (!uid) return message.reply('Usage: !ban @user'); try { await message.guild.members.ban(uid, { reason }); return message.reply('<@' + uid + '> banned.'); } catch (_) { return message.reply('Could not ban.'); } }
    if (cmd === 'lockdown' && isAdmin) { config.security.lockdown = !config.security.lockdown; saveConfig(); if (config.security.lockdown) { for (const [, ch] of message.guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.create(message.guild.roles.everyone, { SendMessages: false }).catch(() => {}); return message.reply('LOCKDOWN ACTIVATED!'); } else { for (const [, ch] of message.guild.channels.cache) if (ch.isTextBased()) await ch.permissionOverwrites.delete(message.guild.roles.everyone).catch(() => {}); return message.reply('Lockdown lifted!'); } }
  });

  // ── Anti-Nuke Events
  client.on('channelDelete', async (channel) => {
    if (!config.security?.antiNuke) return;
    try {
      const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
      const entry = logs.entries.first(); if (!entry) return;
      const executor = entry.executor; if (executor.id === client.user.id || executor.id === BOT_OWNER_ID) return;
      if (isNuking(executor.id)) {
        const m = channel.guild.members.cache.get(executor.id);
        try { if (m) { const roles = m.roles.cache.filter(r => r.id !== channel.guild.roles.everyone.id); await m.roles.remove(roles, 'Anti-Nuke'); } await channel.guild.bans.create(executor.id, { reason: 'Anti-Nuke: Mass channel deletion' }); await sendLog(channel.guild, new EmbedBuilder().setColor('#FF0000').setTitle('ANTI-NUKE - User Banned!').setDescription(executor.tag + ' was mass-deleting channels!').setTimestamp()); } catch (_) {}
      }
    } catch (_) {}
  });
  client.on('roleDelete', async (role) => {
    if (!config.security?.antiNuke) return;
    try {
      const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
      const entry = logs.entries.first(); if (!entry) return;
      const executor = entry.executor; if (executor.id === client.user.id || executor.id === BOT_OWNER_ID) return;
      if (isNuking(executor.id)) {
        const m = role.guild.members.cache.get(executor.id);
        try { if (m) { const roles = m.roles.cache.filter(r => r.id !== role.guild.roles.everyone.id); await m.roles.remove(roles); } await role.guild.bans.create(executor.id, { reason: 'Anti-Nuke: Mass role deletion' }); await sendLog(role.guild, new EmbedBuilder().setColor('#FF0000').setTitle('ANTI-NUKE - Mass Role Deletion!').addFields({ name: 'Executor', value: executor.tag }).setTimestamp()); } catch (_) {}
      }
    } catch (_) {}
  });
  client.on('guildBanAdd', async (ban) => {
    if (!config.security?.antiNuke) return;
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 1 });
      const entry = logs.entries.first(); if (!entry) return;
      const executor = entry.executor; if (executor.id === client.user.id || executor.id === BOT_OWNER_ID) return;
      if (isNuking(executor.id)) { try { await ban.guild.bans.create(executor.id, { reason: 'Anti-Nuke: Mass banning' }); await sendLog(ban.guild, new EmbedBuilder().setColor('#FF0000').setTitle('ANTI-NUKE - Mass Ban Detected!').addFields({ name: 'Executor', value: executor.tag }).setTimestamp()); } catch (_) {} }
    } catch (_) {}
  });

  client.on('inviteCreate', async (inv) => { await cacheInvites(inv.guild).catch(() => {}); });
  client.on('inviteDelete', async (inv) => { await cacheInvites(inv.guild).catch(() => {}); });

  // ── Discord Native AutoMod Setup
  async function setupAutoMod(guild, logChannelId) {
    const results = [];
    try {
      // Fetch existing rules so we don't duplicate
      const existing = await guild.autoModerationRules.fetch().catch(() => null);
      const existingNames = existing ? [...existing.values()].map(r => r.name) : [];

      const actions = [{ type: 1 }]; // Block message
      if (logChannelId) actions.push({ type: 2, metadata: { channelId: logChannelId } }); // Send alert

      // Rule 1: Block bad words / profanity
      if (!existingNames.includes('THOR APEX - Word Filter')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Word Filter',
          eventType: 1,
          triggerType: 1, // Keyword
          triggerMetadata: {
            keywordFilter: ['nigga','nigger','fuck','shit','bitch','asshole','retard','cunt','whore','faggot'],
            regexPatterns: [],
          },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Word Filter',
        }).then(() => results.push('Word Filter rule created')).catch(e => results.push('Word Filter: ' + e.message));
      } else { results.push('Word Filter rule already exists'); }

      // Rule 2: Block Discord invite links
      if (!existingNames.includes('THOR APEX - Block Invites')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Block Invites',
          eventType: 1,
          triggerType: 3, // Keyword preset
          triggerMetadata: { presets: [3] }, // 3 = Slurs (discord.js preset - invites are handled via keyword)
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Invites',
        }).catch(() => {});
        // Use keyword rule for invite links instead (more reliable)
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Block Invites',
          eventType: 1,
          triggerType: 1,
          triggerMetadata: {
            keywordFilter: ['discord.gg/', 'discord.com/invite/', 'dsc.gg/', 'invite.gg/'],
            regexPatterns: [],
          },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Discord Invites',
        }).then(() => results.push('Block Invites rule created')).catch(e => results.push('Block Invites: ' + e.message));
      } else { results.push('Block Invites rule already exists'); }

      // Rule 3: Anti-Spam (mention spam)
      if (!existingNames.includes('THOR APEX - Anti Mention Spam')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Anti Mention Spam',
          eventType: 1,
          triggerType: 5, // Mention spam
          triggerMetadata: { mentionTotalLimit: 5 },
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Anti Mention Spam',
        }).then(() => results.push('Anti Mention Spam rule created')).catch(e => results.push('Anti Mention Spam: ' + e.message));
      } else { results.push('Anti Mention Spam rule already exists'); }

      // Rule 4: Block spam content (built-in preset)
      if (!existingNames.includes('THOR APEX - Anti Spam Content')) {
        await guild.autoModerationRules.create({
          name: 'THOR APEX - Anti Spam Content',
          eventType: 1,
          triggerType: 3, // Keyword preset
          triggerMetadata: { presets: [1, 2] }, // 1=Profanity, 2=Sexual
          actions,
          enabled: true,
          reason: 'THOR APEX AutoMod: Block Spam/Sexual Content',
        }).then(() => results.push('Anti Spam Content rule created')).catch(e => results.push('Anti Spam Content: ' + e.message));
      } else { results.push('Anti Spam Content rule already exists'); }

    } catch (err) { results.push('AutoMod setup error: ' + err.message); }
    return results;
  }

  async function disableAutoMod(guild) {
    const results = [];
    try {
      const rules = await guild.autoModerationRules.fetch().catch(() => null);
      if (!rules || rules.size === 0) return ['No AutoMod rules found'];
      const thorRules = rules.filter(r => r.name.startsWith('THOR APEX'));
      for (const [, rule] of thorRules) {
        await rule.edit({ enabled: false }).then(() => results.push('Disabled: ' + rule.name)).catch(e => results.push('Failed: ' + rule.name + ' - ' + e.message));
      }
      if (results.length === 0) results.push('No THOR APEX AutoMod rules found');
    } catch (err) { results.push('Error: ' + err.message); }
    return results;
  }

  // ── Slash Command Handler
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, guild } = interaction;

    if (commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      const channels = guild.channels.cache; const results = [];
      const detect = kws => channels.find(c => c.isTextBased() && kws.some(k => c.name.toLowerCase().includes(k)));
      const wCh = detect(['welcome','join','arrivals']), lCh = detect(['leave','goodbye','farewell','bye']),
            rCh = detect(['rule','rules','guidelines']), rolCh = detect(['role','roles','selfrole']),
            gCh = detect(['general','chat','lounge','main']), logCh = detect(['log','logs','mod-log','modlog','audit']);
      if (wCh)   { config.welcomeChannelId = wCh.id;   results.push('✅ Welcome: <#' + wCh.id + '>'); }   else results.push('⚠️ Welcome channel not found - use /setwelcome');
      if (lCh)   { config.leaveChannelId   = lCh.id;   results.push('✅ Leave: <#' + lCh.id + '>'); }
      if (rCh)   { config.rulesChannelId   = rCh.id;   results.push('✅ Rules: <#' + rCh.id + '>'); }
      if (rolCh) { config.rolesChannelId   = rolCh.id; results.push('✅ Roles: <#' + rolCh.id + '>'); }
      if (gCh)   { config.generalChannelId = gCh.id;   results.push('✅ General: <#' + gCh.id + '>'); }
      if (logCh) { config.logChannelId     = logCh.id; results.push('✅ Log: <#' + logCh.id + '>'); }
      results.push('🛡️ Security: Anti-Spam ON | Anti-Link ON | Word Filter ON | Alt Detection ON | Anti-Nuke ON');
      saveConfig();
      // Auto-setup Discord Native AutoMod
      results.push('');
      results.push('**Discord AutoMod Rules:**');
      const autoModResults = await setupAutoMod(guild, config.logChannelId);
      autoModResults.forEach(r => results.push('🤖 ' + r));
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('✅ Auto-Setup Complete!').setDescription(results.join('\n')).addFields({ name: 'Next Steps', value: 'Run /testwelcome to preview\nRun /security to view security settings\nRun /automod status to check AutoMod rules\nRun /help for all commands' }).setThumbnail(guild.iconURL({ size: 256 })).setTimestamp()] });
      return;
    }

    if (commandName === 'automod') {
      const action = interaction.options.getString('action');
      await interaction.deferReply({ ephemeral: true });
      if (action === 'enable') {
        const amResults = await setupAutoMod(guild, config.logChannelId);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle('🤖 Discord AutoMod Enabled!').setDescription(amResults.join('\n')).addFields({ name: 'What This Does', value: '• Blocks bad words at Discord level\n• Blocks Discord invite links\n• Blocks mention spam (5+ mentions)\n• Blocks spam/sexual content presets\n• Faster than bot-based filtering!' }).setTimestamp()] }); return;
      }
      if (action === 'disable') {
        const amResults = await disableAutoMod(guild);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('🤖 Discord AutoMod Disabled').setDescription(amResults.join('\n')).setTimestamp()] }); return;
      }
      if (action === 'status') {
        try {
          const rules = await guild.autoModerationRules.fetch().catch(() => null);
          if (!rules || rules.size === 0) { await interaction.editReply({ content: 'No AutoMod rules found. Run `/automod enable` to set them up!' }); return; }
          const desc = [...rules.values()].map(r => (r.enabled ? '🟢' : '🔴') + ' **' + r.name + '** (ID: ' + r.id + ')').join('\n');
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🤖 AutoMod Rules - ' + guild.name).setDescription(desc).setFooter({ text: 'Total: ' + rules.size + ' rules | 🟢 Enabled | 🔴 Disabled' }).setTimestamp()] }); return;
        } catch (e) { await interaction.editReply({ content: 'Could not fetch AutoMod rules: ' + e.message }); return; }
      }
    }

    if (commandName === 'setwelcome')    { const ch = interaction.options.getChannel('channel') || interaction.channel; config.welcomeChannelId = ch.id; saveConfig(); return safeReply(interaction, 'Welcome channel set!'); }
    if (commandName === 'setleave')      { config.leaveChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Leave channel set!'); }
    if (commandName === 'setrules')      { config.rulesChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Rules channel set!'); }
    if (commandName === 'setroles')      { config.rolesChannelId   = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Roles channel set!'); }
    if (commandName === 'setgeneral')    { config.generalChannelId = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'General channel set!'); }
    if (commandName === 'setlog')        { config.logChannelId     = interaction.options.getChannel('channel').id; saveConfig(); return safeReply(interaction, 'Log channel set!'); }
    if (commandName === 'setautorole')   { config.autoRoleId = interaction.options.getRole('role').id; saveConfig(); return safeReply(interaction, 'Auto-role set to **' + interaction.options.getRole('role').name + '**!'); }
    if (commandName === 'setwelcomecolor') { const color = interaction.options.getString('color').trim(); if (!isHex(color)) return safeReply(interaction, 'Invalid hex color! Use #RRGGBB'); config.embedColor = color; saveConfig(); return safeReply(interaction, 'Color set to **' + color + '**!'); }
    if (commandName === 'setwelcometext') { const g = interaction.options.getString('greeting'), s = interaction.options.getString('subtitle'), o = interaction.options.getString('outro'); if (!g && !s && !o) return safeReply(interaction, 'Provide at least one option!'); if (g) config.greetingPrefix = g; if (s) config.welcomeSubtitle = s; if (o) config.outroText = o; saveConfig(); return safeReply(interaction, 'Welcome text updated!'); }
    if (commandName === 'setleavetext')  { config.leaveText = interaction.options.getString('message'); saveConfig(); return safeReply(interaction, 'Leave text updated!'); }
    if (commandName === 'testwelcome')   { await interaction.reply({ content: '[TEST] Welcome <@' + interaction.user.id + '>!', embeds: [mkWelcomeEmbed(interaction.member, guild)] }); return; }
    if (commandName === 'testleave')     { await interaction.reply({ content: '[TEST] Goodbye <@' + interaction.user.id + '>!', embeds: [mkLeaveEmbed(interaction.member, guild)] }); return; }
    if (commandName === 'welcomeconfig') {
      const c = config;
      await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(isHex(c.embedColor) ? c.embedColor : '#5865F2').setTitle('THOR APEX Bot Config').addFields(
        { name: 'Channels', value: ['Welcome: ' + (c.welcomeChannelId ? '<#' + c.welcomeChannelId + '>' : 'Not set'), 'Leave: ' + (c.leaveChannelId ? '<#' + c.leaveChannelId + '>' : 'Not set'), 'Rules: ' + (c.rulesChannelId ? '<#' + c.rulesChannelId + '>' : 'Not set'), 'Roles: ' + (c.rolesChannelId ? '<#' + c.rolesChannelId + '>' : 'Not set'), 'General: ' + (c.generalChannelId ? '<#' + c.generalChannelId + '>' : 'Not set'), 'Log: ' + (c.logChannelId ? '<#' + c.logChannelId + '>' : 'Not set')].join('\n') },
        { name: 'Settings', value: 'Color: ' + c.embedColor + '\nAuto-Role: ' + (c.autoRoleId ? '<@&' + c.autoRoleId + '>' : 'Not set') },
      ).setTimestamp()] });
      return;
    }
    if (commandName === 'security') {
      const s = config.security || {}; const ic = v => v ? 'YES' : 'NO';
      await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('THOR APEX Security Settings').addFields({ name: 'Modules', value: ['Anti-Raid: ' + ic(s.antiRaid) + ' (threshold: ' + (s.raidThreshold || 10) + ' joins/10s)', 'Anti-Spam: ' + ic(s.antiSpam) + ' (threshold: ' + (s.spamThreshold || 5) + ' msgs/' + ((s.spamWindow || 5000) / 1000) + 's)', 'Anti-Link/Ads: ' + ic(s.antiLink), 'Word Filter: ' + ic(s.wordFilter) + ' (' + (s.blacklistedWords ? s.blacklistedWords.length : 0) + ' words)', 'Alt Detection: ' + ic(s.altDetection) + ' (min: ' + (s.altMinDays || 7) + ' days)', 'Anti-Nuke: ' + ic(s.antiNuke), 'Lockdown: ' + (s.lockdown ? 'ACTIVE' : 'OFF')].join('\n') }).setFooter({ text: 'Use /antispam /antilink /antinuke /lockdown to toggle' }).setTimestamp()] });
      return;
    }
    const togMap = { antispam: 'antiSpam', antilink: 'antiLink', antiraid: 'antiRaid', antinuke: 'antiNuke' };
    if (togMap[commandName]) { config.security[togMap[commandName]] = interaction.options.getString('toggle') === 'on'; saveConfig(); return safeReply(interaction, commandName + ' is now ' + (config.security[togMap[commandName]] ? 'ON' : 'OFF')); }
    if (commandName === 'altdetection') { config.security.altDetection = interaction.options.getString('toggle') === 'on'; const d = interaction.options.getInteger('mindays'); if (d) config.security.altMinDays = d; saveConfig(); return safeReply(interaction, 'Alt Detection is now ' + (config.security.altDetection ? 'ON' : 'OFF') + ' (min: ' + config.security.altMinDays + ' days)'); }
    if (commandName === 'wordfilter')   { config.security.wordFilter = interaction.options.getString('toggle') === 'on'; saveConfig(); return safeReply(interaction, 'Word Filter is now ' + (config.security.wordFilter ? 'ON' : 'OFF')); }
    if (commandName === 'addword')      { const word = interaction.options.getString('word').toLowerCase(); if (!config.security.blacklistedWords.includes(word)) config.security.blacklistedWords.push(word); saveConfig(); return safeReply(interaction, 'Word added! (Total: ' + config.security.blacklistedWords.length + ')'); }
    if (commandName === 'removeword')   { const word = interaction.options.getString('word').toLowerCase(); config.security.blacklistedWords = config.security.blacklistedWords.filter(w => w !== word); saveConfig(); return safeReply(interaction, 'Word removed!'); }
    if (commandName === 'lockdown') {
      const enable = interaction.options.getString('toggle') === 'on'; config.security.lockdown = enable; saveConfig();
      await interaction.deferReply({ ephemeral: false });
      for (const [, ch] of guild.channels.cache) if (ch.isTextBased()) { if (enable) await ch.permissionOverwrites.create(guild.roles.everyone, { SendMessages: false }).catch(() => {}); else await ch.permissionOverwrites.delete(guild.roles.everyone).catch(() => {}); }
      await interaction.editReply({ content: enable ? 'LOCKDOWN ACTIVATED! No one can send messages.' : 'Lockdown lifted! Server is back to normal.' }); return;
    }
    if (commandName === 'warn') {
      const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason';
      if (!warnings[target.id]) warnings[target.id] = [];
      warnings[target.id].push({ reason, mod: interaction.user.tag, ts: Date.now() }); saveWarnings();
      try { await target.send('You were warned in **' + guild.name + '**. Reason: ' + reason); } catch (_) {}
      await sendLog(guild, new EmbedBuilder().setColor('#FEE75C').setTitle('Member Warned').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }, { name: 'Total', value: '' + warnings[target.id].length, inline: true }).setTimestamp());
      return safeReply(interaction, '<@' + target.id + '> warned. Reason: **' + reason + '** (Total: ' + warnings[target.id].length + ')');
    }
    if (commandName === 'warnings') { const target = interaction.options.getUser('user'); const list = warnings[target.id] || []; if (list.length === 0) return safeReply(interaction, '<@' + target.id + '> has no warnings!'); const desc = list.map((w, i) => (i + 1) + '. ' + w.reason + ' - by ' + w.mod).join('\n'); await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor('#FEE75C').setTitle('Warnings for ' + target.tag).setDescription(desc).setFooter({ text: 'Total: ' + list.length }).setTimestamp()] }); return; }
    if (commandName === 'clearwarns') { const target = interaction.options.getUser('user'); delete warnings[target.id]; saveWarnings(); return safeReply(interaction, 'All warnings cleared for <@' + target.id + '>!'); }
    if (commandName === 'mute') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); const mr = await getMuteRole(guild); if (!mr) return interaction.editReply('Could not find/create Muted role.'); await m.roles.add(mr, reason); await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('Member Muted').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('<@' + target.id + '> muted.'); } catch (_) { await interaction.editReply('Could not mute that user.'); } return; }
    if (commandName === 'unmute') { const target = interaction.options.getUser('user'); await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); const mr = await getMuteRole(guild); if (mr) await m.roles.remove(mr); await interaction.editReply('<@' + target.id + '> unmuted.'); } catch (_) { await interaction.editReply('Could not unmute.'); } return; }
    if (commandName === 'kick') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { const m = await guild.members.fetch(target.id); await m.kick(reason); await sendLog(guild, new EmbedBuilder().setColor('#FF6600').setTitle('Member Kicked').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('**' + target.tag + '** kicked.'); } catch (_) { await interaction.editReply('Could not kick.'); } return; }
    if (commandName === 'ban') { const target = interaction.options.getUser('user'), reason = interaction.options.getString('reason') || 'No reason'; await interaction.deferReply({ ephemeral: true }); try { await guild.members.ban(target.id, { reason }); await sendLog(guild, new EmbedBuilder().setColor('#ED4245').setTitle('Member Banned').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Mod', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setTimestamp()); await interaction.editReply('**' + target.tag + '** banned.'); } catch (_) { await interaction.editReply('Could not ban.'); } return; }
    if (commandName === 'unban') { const uid = interaction.options.getString('userid'); await interaction.deferReply({ ephemeral: true }); try { await guild.bans.remove(uid, 'Unbanned by mod'); await interaction.editReply('User **' + uid + '** unbanned.'); } catch (_) { await interaction.editReply('Could not unban. Check the ID.'); } return; }
    if (commandName === 'purge') { const amount = interaction.options.getInteger('amount'); await interaction.deferReply({ ephemeral: true }); try { const deleted = await interaction.channel.bulkDelete(amount, true); await interaction.editReply('Deleted **' + deleted.size + '** messages.'); } catch (_) { await interaction.editReply('Could not delete messages. They may be older than 14 days.'); } return; }
    if (commandName === 'myinvites') { try { const inv = await guild.invites.fetch().catch(() => null); let total = 0; if (inv) inv.forEach(i => { if (i.inviter && i.inviter.id === interaction.user.id) total += (i.uses || 0); }); await interaction.reply({ ephemeral: true, content: 'You have **' + total + '** total invites in **' + guild.name + '**!' }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'invites') { const target = interaction.options.getUser('user') || interaction.user; try { const inv = await guild.invites.fetch().catch(() => null); let total = 0; if (inv) inv.forEach(i => { if (i.inviter && i.inviter.id === target.id) total += (i.uses || 0); }); await interaction.reply({ ephemeral: true, content: '**' + target.tag + '** has **' + total + '** total invites!' }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'invitetop') { try { const inv = await guild.invites.fetch().catch(() => null); if (!inv || inv.size === 0) return safeReply(interaction, 'No invites found!'); const totals = new Map(); inv.forEach(i => { if (!i.inviter) return; totals.set(i.inviter.id, (totals.get(i.inviter.id) || 0) + (i.uses || 0)); }); const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10); const desc = sorted.map((e, i) => (i + 1) + '. <@' + e[0] + '> - **' + e[1] + '** invites').join('\n'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Top Inviters - ' + guild.name).setDescription(desc || 'No data').setTimestamp()] }); } catch (_) { await safeReply(interaction, 'Could not fetch invite data.'); } return; }
    if (commandName === 'play') { const vc = interaction.member?.voice?.channel; if (!vc) return safeReply(interaction, 'Join a Voice Channel first!'); const r = addToQ(guild, vc, interaction.user, interaction.options.getString('song')); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(r.position === 1 ? 'Now Playing' : 'Added to Queue').setDescription('**' + r.track.title + '**').addFields({ name: 'Voice', value: '<#' + vc.id + '>', inline: true }, { name: 'By', value: '<@' + interaction.user.id + '>', inline: true }).setTimestamp()] }); return; }
    if (commandName === 'pause')  { return safeReply(interaction, 'Paused.', false); }
    if (commandName === 'resume') { return safeReply(interaction, 'Resumed.', false); }
    if (commandName === 'skip')   { const q = getQ(guild.id); if (q.queue.length > 0) { const s = q.queue.shift(); return safeReply(interaction, 'Skipped: **' + (s?.title || 'Song') + '**', false); } return safeReply(interaction, 'Queue is empty!'); }
    if (commandName === 'stop')   { const q = getQ(guild.id); q.queue = []; q.isPlaying = false; if (q.connection) { try { q.connection.destroy(); } catch (_) {} q.connection = null; } return safeReply(interaction, 'Stopped and left voice channel.', false); }
    if (commandName === 'queue')  { const vc = interaction.member?.voice?.channel; const sp = interaction.options.getString('song'); if (sp) { if (!vc) return safeReply(interaction, 'Join Voice first!'); const r = addToQ(guild, vc, interaction.user, sp); return interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Added to Queue').setDescription('**' + r.track.title + '**').addFields({ name: 'Position', value: '#' + r.position }).setTimestamp()] }); } const q = getQ(guild.id); if (q.queue.length === 0) return safeReply(interaction, 'Queue empty! Use /play'); const list = q.queue.slice(0, 10).map((t, i) => (i + 1) + '. **' + t.title + '** (<@' + t.requestedBy + '>)').join('\n'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Music Queue').setDescription(list).setFooter({ text: 'Total: ' + q.queue.length }).setTimestamp()] }); return; }
    if (commandName === 'nowplaying') { const t = getQ(guild.id).queue[0]; if (!t) return safeReply(interaction, 'Nothing playing! Use /play'); await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Now Playing').setDescription('**' + t.title + '**').addFields({ name: 'By', value: '<@' + t.requestedBy + '>' }).setTimestamp()] }); return; }
    if (commandName === 'radio') { const vc = interaction.member?.voice?.channel; if (!vc) return safeReply(interaction, 'Join a Voice Channel first!'); const genre = interaction.options.getString('genre') || 'lofi'; const sel = RADIO_STREAMS[genre] || RADIO_STREAMS.lofi; const q = getQ(guild.id); if (voiceLib) { if (!q.connection) { try { q.connection = voiceLib.joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false }); } catch (_) {} } if (!q.player) { q.player = voiceLib.createAudioPlayer(); q.connection?.subscribe(q.player); } try { q.player.play(voiceLib.createAudioResource(sel.url, { inputType: voiceLib.StreamType.Arbitrary })); } catch (_) {} } await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Radio: ' + sel.name).setDescription('Playing in <#' + vc.id + '>!').setTimestamp()] }); return; }
    if (commandName === 'help') {
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('THOR APEX - All-in-One Bot Commands').setThumbnail(guild.iconURL({ size: 256 })).addFields(
        { name: '⚙️ Setup', value: '/setup /setwelcome /setleave /setrules /setroles /setgeneral /setlog /setautorole' },
        { name: '🎉 Welcome Customize', value: '/setwelcomecolor /setwelcometext /setleavetext /testwelcome /testleave /welcomeconfig' },
        { name: '🛡️ Security', value: '/security /antispam /antilink /antiraid /antinuke /altdetection /wordfilter /addword /removeword /lockdown' },
        { name: '🤖 AutoMod (Discord Native)', value: '/automod enable — Setup Discord AutoMod rules\n/automod disable — Disable AutoMod rules\n/automod status — View all AutoMod rules' },
        { name: '⚔️ Moderation', value: '/warn /warnings /clearwarns /mute /unmute /kick /ban /unban /purge\nAlso: !warn !mute !kick !ban !lockdown' },
        { name: '📩 Inviter', value: '/myinvites /invites [@user] /invitetop' },
        { name: '🎵 Music', value: '/play /pause /resume /skip /stop /queue /nowplaying /radio\nAlso: !play !skip !stop !queue !np' },
      ).setFooter({ text: 'THOR APEX - Made exclusively for this server' }).setTimestamp()] }); return;
    }
  });

  const TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN || TOKEN === 'your_bot_token_here') { console.error('DISCORD_TOKEN is missing!'); process.exit(1); }
  client.login(TOKEN).catch(err => {
    if (err.message.includes('disallowed intents') || err.message.includes('Privileged intent')) {
      console.error('PRIVILEGED INTENTS ERROR! Enable SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT at: https://discord.com/developers/applications');
      process.exit(1);
    } else { console.error('Login error:', err.message); process.exit(1); }
  });
}
startBot();
