const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── Global Error Handlers ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

// ─── HTTP Health Check Server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: 'Multi-Server Welcome Bot',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  }));
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check server running on port ${PORT}`);
});

// ─── Per-Server Config Storage ────────────────────────────────────────────────
// Each server (guild) gets its own config file stored in ./guild_configs/<guildId>.json
const GUILD_CONFIGS_DIR = path.join(__dirname, 'guild_configs');
if (!fs.existsSync(GUILD_CONFIGS_DIR)) {
  fs.mkdirSync(GUILD_CONFIGS_DIR, { recursive: true });
}

/**
 * Returns the default config structure for a new server.
 * Preserves exact THOR APEX welcome text for THOR APEX server,
 * while automatically adapting to any other public server.
 */
function getDefaultConfig(guild) {
  const isThorApex = guild?.name?.toLowerCase()?.includes('thor apex') || guild?.name?.toLowerCase()?.includes('thor');
  const serverName = guild ? guild.name : 'Your Server';

  // Auto-detect channel IDs if guild channels are cached
  let welcomeId = '', rulesId = '', rolesId = '', generalId = '', leaveId = '';
  if (guild?.channels?.cache) {
    const channels = guild.channels.cache;
    welcomeId = channels.find(c => c.isTextBased?.() && /welcome|join|greet/i.test(c.name))?.id || '';
    rulesId = channels.find(c => c.isTextBased?.() && /rule|guideline/i.test(c.name))?.id || '';
    rolesId = channels.find(c => c.isTextBased?.() && /role/i.test(c.name))?.id || '';
    generalId = channels.find(c => c.isTextBased?.() && /general|chat|main/i.test(c.name))?.id || '';
    leaveId = channels.find(c => c.isTextBased?.() && /leave|goodbye|farewell|bye|exit/i.test(c.name))?.id || '';
  }

  return {
    serverName: serverName,
    welcomeTitle: isThorApex ? 'WELCOME TO THOR APEX !' : `Welcome to ${serverName}!`,
    embedColor: '#5865F2',
    channels: {
      welcomeChannelId: welcomeId,
      leaveChannelId: leaveId,
      rulesChannelId: rulesId,
      rolesChannelId: rolesId,
      generalChannelId: generalId,
    },
    messages: {
      greetingPrefix: 'HEY BUDDY!',
      welcomeSubtitle: isThorApex ? 'Welcome to THOR APEX !' : `Welcome to ${serverName}!`,
      rulesText: 'Please read our rules:',
      outroText: isThorApex ? 'Hope you enjoy your stay in THOR APEX! 🎉' : 'Hope you enjoy your stay here! 🎉',
      leaveText: 'Goodbye {username}! We are sad to see you go. We now have **{count}** members.',
    },
    // If false, uses Discord CDN URLs set by admin; if true, auto-uses server icon/banner
    useServerAssets: true,
    customImages: {
      logoUrl: '',
      bannerUrl: '',
    }
  };
}

/** Load config for a specific guild. Returns default config if none exists yet. */
function loadGuildConfig(guild) {
  const filePath = path.join(GUILD_CONFIGS_DIR, `${guild.id}.json`);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`⚠️ Could not parse config for guild ${guild.id}, using defaults.`);
    }
  }
  return getDefaultConfig(guild);
}

/** Save config for a specific guild. */
function saveGuildConfig(guildId, config) {
  const filePath = path.join(GUILD_CONFIGS_DIR, `${guildId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    console.log(`💾 Config saved for guild: ${guildId}`);
  } catch (err) {
    console.error(`❌ Failed to save config for guild ${guildId}:`, err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatChannelMention(channelId, fallbackName) {
  if (!channelId || !/^\d+$/.test(channelId)) return `\`#${fallbackName}\``;
  return `<#${channelId}>`;
}

function isValidHexColor(str) {
  return /^#[0-9A-Fa-f]{6}$/.test(str);
}

// ─── Invite Tracking Cache ───────────────────────────────────────────────────
const guildInvitesCache = new Map(); // guildId => Map(inviteCode => usesCount)

async function cacheGuildInvites(guild) {
  try {
    if (!guild || !guild.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return;
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;
    const inviteMap = new Map();
    invites.forEach(inv => inviteMap.set(inv.code, inv.uses || 0));
    guildInvitesCache.set(guild.id, inviteMap);
  } catch (e) {
    // ignore missing permissions
  }
}

async function findInviter(guild) {
  try {
    if (!guild || !guild.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return null;
    const cachedInvites = guildInvitesCache.get(guild.id) || new Map();
    const newInvites = await guild.invites.fetch().catch(() => null);

    if (!newInvites) return null;

    let usedInvite = null;
    newInvites.forEach(inv => {
      const prevUses = cachedInvites.get(inv.code) || 0;
      if (inv.uses > prevUses && !usedInvite) {
        usedInvite = inv;
      }
    });

    // Update cache
    const updatedMap = new Map();
    newInvites.forEach(inv => updatedMap.set(inv.code, inv.uses || 0));
    guildInvitesCache.set(guild.id, updatedMap);

    if (usedInvite && usedInvite.inviter) {
      let totalUses = 0;
      newInvites.forEach(inv => {
        if (inv.inviter?.id === usedInvite.inviter.id) {
          totalUses += (inv.uses || 0);
        }
      });
      return {
        inviterId: usedInvite.inviter.id,
        inviterTag: usedInvite.inviter.tag,
        uses: totalUses,
        code: usedInvite.code,
      };
    }
  } catch (e) {
    console.warn('⚠️ Invite tracking note:', e.message);
  }
  return null;
}

// ─── Welcome Embed Builder ────────────────────────────────────────────────────
function createWelcomeEmbed(member, guild, inviterData = null) {
  const config = loadGuildConfig(guild);

  // Resolve logo: custom URL first, then auto-detect server icon from Discord
  let logoUrl = config.customImages?.logoUrl?.startsWith('http') ? config.customImages.logoUrl : null;
  if (!logoUrl && guild?.iconURL) {
    logoUrl = guild.iconURL({ size: 1024, forceStatic: false });
  }

  // Resolve banner: custom URL first, then auto-detect server banner from Discord
  let bannerUrl = config.customImages?.bannerUrl?.startsWith('http') ? config.customImages.bannerUrl : null;
  if (!bannerUrl && guild?.bannerURL) {
    bannerUrl = guild.bannerURL({ size: 1024 });
  }

  const userId = member?.user?.id ?? member?.id ?? '000000000000000000';
  const guildName = guild.name || config.serverName || 'Your Server';

  // Build channel mentions
  const rulesTag = formatChannelMention(config.channels?.rulesChannelId, 'rules');
  const rolesTag = formatChannelMention(config.channels?.rolesChannelId, 'roles');
  const generalTag = formatChannelMention(config.channels?.generalChannelId, 'general');

  // Build embed description dynamically
  const lines = [];
  lines.push(`### ${config.messages?.greetingPrefix || 'HEY BUDDY!'} <@${userId}>\n`);
  lines.push(`**${config.messages?.welcomeSubtitle || `Welcome to ${guildName}!`}**\n`);

  // Inviter Info
  if (inviterData && inviterData.inviterId) {
    lines.push(`**📩 Invited by:** <@${inviterData.inviterId}> (Total Invites: **${inviterData.uses}**)\n`);
  } else {
    lines.push(`**📩 Invited by:** Direct Link / Unknown\n`);
  }

  lines.push(`**${config.messages?.rulesText || 'Please read our rules:'}** ${rulesTag}\n`);
  lines.push(`**🎭 Get your roles here:** ${rolesTag}\n`);
  lines.push(`**💬 Start chatting in:** ${generalTag}\n`);
  lines.push(`\n### ${config.messages?.outroText || 'Hope you enjoy your stay here! 🎉'}`);

  const embedColor = isValidHexColor(config.embedColor) ? config.embedColor : '#5865F2';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setDescription(lines.join('\n'))
    .setTimestamp();

  // Author
  const authorOptions = { name: config.welcomeTitle || `Welcome to ${guildName}!` };
  if (logoUrl) authorOptions.iconURL = logoUrl;
  embed.setAuthor(authorOptions);

  // Thumbnail (member avatar > server icon)
  const avatarUrl = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  else if (logoUrl) embed.setThumbnail(logoUrl);

  // Banner image
  if (bannerUrl) embed.setImage(bannerUrl);

  // Footer
  const footerOptions = { text: `${guildName} • Member #${guild.memberCount || '1'}` };
  if (logoUrl) footerOptions.iconURL = logoUrl;
  embed.setFooter(footerOptions);

  return embed;
}

// ─── Leave Embed Builder ─────────────────────────────────────────────────────
function createLeaveEmbed(member, guild) {
  const config = loadGuildConfig(guild);
  const guildName = guild.name || config.serverName || 'Server';
  const username = member.user?.tag || member.user?.username || 'Member';

  let logoUrl = config.customImages?.logoUrl?.startsWith('http') ? config.customImages.logoUrl : null;
  if (!logoUrl && guild?.iconURL) {
    logoUrl = guild.iconURL({ size: 1024, forceStatic: false });
  }

  const rawMsg = config.messages?.leaveText || 'Goodbye **{username}**! We are sad to see you go. We now have **{count}** members.';
  const formattedMsg = rawMsg
    .replace(/{user}/g, `<@${member.id}>`)
    .replace(/{username}/g, username)
    .replace(/{server}/g, guildName)
    .replace(/{count}/g, guild.memberCount || 0);

  const embedColor = isValidHexColor(config.embedColor) ? config.embedColor : '#ED4245';

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(`👋 Member Left — ${guildName}`)
    .setDescription(`### ${formattedMsg}`)
    .setTimestamp();

  const avatarUrl = member?.user?.displayAvatarURL({ size: 256, forceStatic: false });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  else if (logoUrl) embed.setThumbnail(logoUrl);

  const footerOptions = { text: `${guildName} • Total Members: ${guild.memberCount || 0}` };
  if (logoUrl) footerOptions.iconURL = logoUrl;
  embed.setFooter(footerOptions);

  return embed;
}

// ─── Slash Commands Definition ─────────────────────────────────────────────────
function buildSlashCommands() {
  return [
    // ── Setup: Welcome Channel
    new SlashCommandBuilder()
      .setName('setwelcome')
      .setDescription('Set the welcome channel for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('The channel where welcome messages will be sent')
          .setRequired(false)
      ),

    // ── Setup: Rules Channel
    new SlashCommandBuilder()
      .setName('setrules')
      .setDescription('Set the rules channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Rules channel').setRequired(true)
      ),

    // ── Setup: Roles Channel
    new SlashCommandBuilder()
      .setName('setroles')
      .setDescription('Set the roles channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('Roles channel').setRequired(true)
      ),

    // ── Setup: General Channel
    new SlashCommandBuilder()
      .setName('setgeneral')
      .setDescription('Set the general channel shown in welcome messages')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('General channel').setRequired(true)
      ),

    // ── Customize: Embed Color
    new SlashCommandBuilder()
      .setName('setwelcomecolor')
      .setDescription('Set the embed color for welcome messages (e.g. #FF5733)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Hex color code, e.g. #FF5733')
          .setRequired(true)
      ),

    // ── Customize: Greeting text
    new SlashCommandBuilder()
      .setName('setwelcometext')
      .setDescription('Customize the welcome message text')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('greeting')
          .setDescription('Opening greeting (e.g. "HELLO THERE!")')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('subtitle')
          .setDescription('Welcome subtitle (e.g. "Welcome to Our Server!")')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('outro')
          .setDescription('Closing line of the welcome message')
          .setRequired(false)
      ),

    // ── View current setup
    new SlashCommandBuilder()
      .setName('welcomeconfig')
      .setDescription('View the current welcome bot configuration for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    // ── Test welcome
    new SlashCommandBuilder()
      .setName('testwelcome')
      .setDescription('Preview the welcome message for this server'),

    // ── Reset config
    new SlashCommandBuilder()
      .setName('resetwelcome')
      .setDescription('Reset all welcome settings for this server back to defaults')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // ── Setup: Leave Channel
    new SlashCommandBuilder()
      .setName('setleave')
      .setDescription('Set the leave/goodbye channel for this server')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('The channel where leave/goodbye messages will be sent')
          .setRequired(true)
      ),

    // ── Customize: Leave Message Text
    new SlashCommandBuilder()
      .setName('setleavetext')
      .setDescription('Customize the member leave message text')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('message')
          .setDescription('Message text (use {username}, {user}, {server}, {count})')
          .setRequired(true)
      ),

    // ── Test Leave
    new SlashCommandBuilder()
      .setName('testleave')
      .setDescription('Preview the leave/goodbye message for this server'),

    // ── Check Invites
    new SlashCommandBuilder()
      .setName('myinvites')
      .setDescription('Check how many members you have invited to this server'),

    // ── Auto Setup (detects channels, logo, banner automatically)
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Auto-setup the welcome bot for this server (detects channels, logo, banner)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(opt =>
        opt.setName('logo_file')
          .setDescription('Upload a custom logo image file from your PC/phone')
          .setRequired(false)
      )
      .addAttachmentOption(opt =>
        opt.setName('banner_file')
          .setDescription('Upload a custom banner image file from your PC/phone')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Embed color (e.g. #FF5733) — leave empty for default')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('greeting')
          .setDescription('Custom greeting text (e.g. "HEY THERE!") — leave empty for default')
          .setRequired(false)
      ),

    // ── Customize Logo & Banner
    new SlashCommandBuilder()
      .setName('setimages')
      .setDescription('Set custom logo or banner image for welcome messages (Upload file or paste URL)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption(opt =>
        opt.setName('logo_file')
          .setDescription('Upload custom logo image file')
          .setRequired(false)
      )
      .addAttachmentOption(opt =>
        opt.setName('banner_file')
          .setDescription('Upload custom banner image file')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('logo_url')
          .setDescription('Or paste logo image link URL')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('banner_url')
          .setDescription('Or paste banner image link URL')
          .setRequired(false)
      ),

    // ── Help
    new SlashCommandBuilder()
      .setName('welcomehelp')
      .setDescription('Show all available Welcome Bot commands'),
  ].map(cmd => cmd.toJSON());
}

// ─── Register Slash Commands (Global - No Duplicates) ──────────────────────────
async function registerSlashCommands(client) {
  const commands = buildSlashCommands();
  const token = process.env.DISCORD_TOKEN;
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('⏳ Registering global slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    // Clean up any old guild-level duplicate commands so commands appear only ONCE
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, guild.id),
          { body: [] }
        );
      } catch (e) {
        // ignore cleanup errors if missing scope/permission
      }
    }

    console.log('✅ Global slash commands registered (1 for 1, no duplicates)!');
  } catch (err) {
    console.error('⚠️ Slash command registration error:', err.message);
  }
}

// ─── Clean up guild-level overrides when joining a new server ─────────────────
async function registerCommandsForGuild(client, guild) {
  const token = process.env.DISCORD_TOKEN;
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    // Clear any guild command overrides so global commands are used cleanly without duplicates
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: [] }
    );
  } catch (e) {
    // ignore
  }
}

// ─── Main Bot ──────────────────────────────────────────────────────────────────
function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildInvites,
    ],
    partials: [
      Partials.GuildMember,
      Partials.User,
      Partials.Channel,
      Partials.Message,
    ],
  });

  // ── Bot Ready
  client.once('clientReady', async () => {
    console.log('\n=======================================================');
    console.log('🤖 Multi-Server Welcome Bot is ONLINE!');
    console.log(`🏷️  Logged in as: ${client.user.tag}`);
    console.log(`🛡️  Connected to ${client.guilds.cache.size} server(s):`);
    client.guilds.cache.forEach(g => console.log(`   • ${g.name} (${g.id})`));
    console.log('=======================================================\n');

    // Cache invites for all guilds
    for (const g of client.guilds.cache.values()) {
      await cacheGuildInvites(g);
    }

    await registerSlashCommands(client);
  });

  // ── Bot Joins a New Server → register commands & cache invites
  client.on('guildCreate', async (guild) => {
    console.log(`🆕 Bot added to new server: "${guild.name}" (${guild.id})`);
    await cacheGuildInvites(guild);
    await registerCommandsForGuild(client, guild);
  });

  // ── New Member Joined
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.partial) {
        member = await member.fetch().catch(() => null);
        if (!member) return;
      }

      console.log(`🔔 New member: ${member.user.tag} in "${member.guild.name}"`);

      // Track who invited this member
      const inviterData = await findInviter(member.guild);

      const config = loadGuildConfig(member.guild);
      let welcomeChannel = null;

      // 1. Try the configured welcome channel ID
      if (config.channels?.welcomeChannelId && /^\d+$/.test(config.channels.welcomeChannelId)) {
        welcomeChannel = member.guild.channels.cache.get(config.channels.welcomeChannelId)
          || await member.guild.channels.fetch(config.channels.welcomeChannelId).catch(() => null);
      }

      // 2. Fallback: search by name
      if (!welcomeChannel) {
        welcomeChannel = member.guild.channels.cache.find(c =>
          c.isTextBased() && ['welcome', 'join', 'arrivals', 'greet'].some(kw => c.name.includes(kw))
        );
      }

      // 3. Fallback: system channel
      if (!welcomeChannel) welcomeChannel = member.guild.systemChannel;

      if (!welcomeChannel) {
        console.error(`❌ No welcome channel found in "${member.guild.name}". Use /setwelcome to configure.`);
        return;
      }

      // Check permissions
      const botMember = member.guild.members.me;
      if (botMember) {
        const perms = welcomeChannel.permissionsFor(botMember);
        if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
          console.error(`❌ Missing SendMessages in #${welcomeChannel.name}`);
          return;
        }
        if (!perms?.has(PermissionsBitField.Flags.EmbedLinks)) {
          console.error(`❌ Missing EmbedLinks in #${welcomeChannel.name}`);
          return;
        }
      }

      const embed = createWelcomeEmbed(member, member.guild, inviterData);
      await welcomeChannel.send({
        content: `🎉 Welcome <@${member.id}> to **${member.guild.name}**!`,
        embeds: [embed],
      });
      console.log(`✅ Welcome sent for ${member.user.tag} in #${welcomeChannel.name}`);
    } catch (err) {
      console.error('❌ guildMemberAdd error:', err);
    }
  });

  // ── Member Left (Goodbye Message)
  client.on('guildMemberRemove', async (member) => {
    try {
      if (member.partial) {
        member = await member.fetch().catch(() => null);
        if (!member) return;
      }

      console.log(`👋 Member left: ${member.user?.tag || member.id} from "${member.guild.name}"`);

      const config = loadGuildConfig(member.guild);
      let leaveChannel = null;

      if (config.channels?.leaveChannelId && /^\d+$/.test(config.channels.leaveChannelId)) {
        leaveChannel = member.guild.channels.cache.get(config.channels.leaveChannelId)
          || await member.guild.channels.fetch(config.channels.leaveChannelId).catch(() => null);
      }

      if (!leaveChannel && member.guild.channels?.cache) {
        leaveChannel = member.guild.channels.cache.find(c =>
          c.isTextBased?.() && ['leave', 'goodbye', 'farewell', 'bye', 'exit', 'left'].some(k => c.name.toLowerCase().includes(k))
        );
      }

      if (!leaveChannel) return; // No leave channel configured or found

      const leaveEmbed = createLeaveEmbed(member, member.guild);
      await leaveChannel.send({ embeds: [leaveEmbed] });
      console.log(`✅ Leave message sent for ${member.user?.tag || member.id} in #${leaveChannel.name}`);
    } catch (err) {
      console.error('❌ Error handling member leave:', err);
    }
  });

  // ── Slash Command Handler
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild } = interaction;

    // ── /setup (Auto-detects everything!)
    if (commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const config = loadGuildConfig(guild);
        const channels = guild.channels.cache;
        const results = [];

        // ── Auto-detect Welcome Channel
        const welcomeCh = channels.find(c =>
          c.isTextBased() && ['welcome', 'welcomes', 'join', 'arrivals', 'greet', 'joined'].some(k => c.name.toLowerCase().includes(k))
        );
        if (welcomeCh) {
          config.channels.welcomeChannelId = welcomeCh.id;
          results.push(`✅ Welcome Channel → <#${welcomeCh.id}>`);
        } else {
          results.push(`⚠️ Welcome Channel → Not found (use /setwelcome manually)`);
        }

        // ── Auto-detect Rules Channel
        const rulesCh = channels.find(c =>
          c.isTextBased() && ['rule', 'rules', 'guidelines', 'tos', 'terms'].some(k => c.name.toLowerCase().includes(k))
        );
        if (rulesCh) {
          config.channels.rulesChannelId = rulesCh.id;
          results.push(`✅ Rules Channel → <#${rulesCh.id}>`);
        } else {
          results.push(`⚠️ Rules Channel → Not found (use /setrules manually)`);
        }

        // ── Auto-detect Roles Channel
        const rolesCh = channels.find(c =>
          c.isTextBased() && ['role', 'roles', 'self-role', 'selfrole', 'pick-role', 'get-role', 'colour', 'color'].some(k => c.name.toLowerCase().includes(k))
        );
        if (rolesCh) {
          config.channels.rolesChannelId = rolesCh.id;
          results.push(`✅ Roles Channel → <#${rolesCh.id}>`);
        } else {
          results.push(`⚠️ Roles Channel → Not found (use /setroles manually)`);
        }

        // ── Auto-detect General Channel
        const generalCh = channels.find(c =>
          c.isTextBased() && ['general', 'chat', 'lounge', 'talk', 'main', 'lobby', 'hangout'].some(k => c.name.toLowerCase().includes(k))
        );
        if (generalCh) {
          config.channels.generalChannelId = generalCh.id;
          results.push(`✅ General Channel → <#${generalCh.id}>`);
        } else {
          results.push(`⚠️ General Channel → Not found (use /setgeneral manually)`);
        }

        // ── Auto-detect or set custom Banner & Logo (File Attachment or Link URL)
        const logoFile = interaction.options.getAttachment('logo_file');
        const bannerFile = interaction.options.getAttachment('banner_file');
        const customLogo = logoFile ? logoFile.url : interaction.options.getString('logo_url');
        const customBanner = bannerFile ? bannerFile.url : interaction.options.getString('banner_url');

        if (customLogo && customLogo.startsWith('http')) {
          config.customImages = config.customImages || {};
          config.customImages.logoUrl = customLogo;
          results.push(`✅ Server Logo → ${logoFile ? 'Uploaded File set' : 'Custom Link set'}`);
        } else if (guild.iconURL({ size: 1024 })) {
          results.push(`✅ Server Logo → Auto-detected from Server Icon`);
        } else {
          results.push(`ℹ️ Server Logo → No icon on Discord (use /setimages logo_file:<upload>)`);
        }

        if (customBanner && customBanner.startsWith('http')) {
          config.customImages = config.customImages || {};
          config.customImages.bannerUrl = customBanner;
          results.push(`✅ Server Banner → ${bannerFile ? 'Uploaded File set' : 'Custom Link set'}`);
        } else if (guild.bannerURL({ size: 1024 })) {
          results.push(`✅ Server Banner → Auto-detected from Server Banner`);
        } else {
          results.push(`ℹ️ Server Banner → No banner on Discord (use /setimages banner_file:<upload>)`);
        }

        // ── Set welcome messages using server name
        config.serverName = guild.name;
        config.welcomeTitle = `Welcome to ${guild.name}!`;
        config.messages.welcomeSubtitle = `Welcome to ${guild.name}!`;
        results.push(`✅ Server Name → ${guild.name}`);

        // ── Custom color (if provided)
        const colorInput = interaction.options.getString('color');
        if (colorInput && isValidHexColor(colorInput.trim())) {
          config.embedColor = colorInput.trim();
          results.push(`✅ Embed Color → ${colorInput.trim()}`);
        } else {
          config.embedColor = '#5865F2';
          results.push(`✅ Embed Color → #5865F2 (default Discord blue)`);
        }

        // ── Custom greeting (if provided)
        const greetingInput = interaction.options.getString('greeting');
        if (greetingInput) {
          config.messages.greetingPrefix = greetingInput;
          results.push(`✅ Greeting → "${greetingInput}"`);
        }

        // ── Save everything
        saveGuildConfig(guild.id, config);

        // ── Build result embed
        const setupEmbed = new EmbedBuilder()
          .setColor(config.embedColor)
          .setTitle(`⚡ Auto-Setup Complete — ${guild.name}`)
          .setDescription(results.join('\n'))
          .addFields({
            name: '📌 Next Steps',
            value: [
              '• Run `/testwelcome` to preview your welcome message',
              '• Run `/testleave` to preview your member left message',
              '• Run `/welcomeconfig` to see full settings',
            ].join('\n')
          })
          .setThumbnail(guild.iconURL({ size: 256, forceStatic: false }))
          .setFooter({ text: 'Use /welcomehelp to see all commands' })
          .setTimestamp();

        await interaction.editReply({ embeds: [setupEmbed] });
        console.log(`⚡ /setup completed for "${guild.name}" (${guild.id})`);
      } catch (err) {
        console.error('❌ /setup error:', err);
        await interaction.editReply({ content: `❌ Setup failed: ${err.message}` });
      }
      return;
    }

    // ── /testwelcome
    if (commandName === 'testwelcome') {
      try {
        const embed = createWelcomeEmbed(interaction.member, guild);
        await interaction.reply({
          content: `**[TEST PREVIEW]** 🎉 Welcome <@${interaction.user.id}> to **${guild.name}**!`,
          embeds: [embed],
        });
      } catch (err) {
        await safeReply(interaction, `❌ Error: ${err.message}`);
      }
      return;
    }

    // ── /testleave
    if (commandName === 'testleave') {
      try {
        const embed = createLeaveEmbed(interaction.member, guild);
        await interaction.reply({
          content: `**[TEST LEAVE PREVIEW]** 👋 Goodbye <@${interaction.user.id}>!`,
          embeds: [embed],
        });
      } catch (err) {
        await safeReply(interaction, `❌ Error: ${err.message}`);
      }
      return;
    }

    // ── /myinvites
    if (commandName === 'myinvites') {
      try {
        const invites = await guild.invites.fetch().catch(() => null);
        let totalCount = 0;
        if (invites) {
          invites.forEach(inv => {
            if (inv.inviter?.id === interaction.user.id) {
              totalCount += (inv.uses || 0);
            }
          });
        }
        await interaction.reply({
          content: `📩 <@${interaction.user.id}>, you have **${totalCount}** total invites in **${guild.name}**!`,
          ephemeral: true,
        });
      } catch (err) {
        await safeReply(interaction, `❌ Could not fetch invite stats.`);
      }
      return;
    }

    // ── /setwelcome
    if (commandName === 'setwelcome') {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const config = loadGuildConfig(guild);
      config.channels.welcomeChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({
        content: `✅ Welcome channel set to ${channel}!`,
        ephemeral: true,
      });
      return;
    }

    // ── /setleave
    if (commandName === 'setleave') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.leaveChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Leave/Goodbye channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setleavetext
    if (commandName === 'setleavetext') {
      const message = interaction.options.getString('message');
      const config = loadGuildConfig(guild);
      config.messages.leaveText = message;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Member leave message updated!\nPreview: "${message}"`, ephemeral: true });
      return;
    }

    // ── /setrules
    if (commandName === 'setrules') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.rulesChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Rules channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setroles
    if (commandName === 'setroles') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.rolesChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Roles channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setgeneral
    if (commandName === 'setgeneral') {
      const channel = interaction.options.getChannel('channel');
      const config = loadGuildConfig(guild);
      config.channels.generalChannelId = channel.id;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ General channel set to ${channel}!`, ephemeral: true });
      return;
    }

    // ── /setwelcomecolor
    if (commandName === 'setwelcomecolor') {
      const color = interaction.options.getString('color').trim();
      if (!isValidHexColor(color)) {
        await interaction.reply({ content: `❌ Invalid hex color! Use format: \`#RRGGBB\` (e.g. \`#FF5733\`)`, ephemeral: true });
        return;
      }
      const config = loadGuildConfig(guild);
      config.embedColor = color;
      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: `✅ Embed color updated to **${color}**!`, ephemeral: true });
      return;
    }

    // ── /setwelcometext
    if (commandName === 'setwelcometext') {
      const greeting = interaction.options.getString('greeting');
      const subtitle = interaction.options.getString('subtitle');
      const outro = interaction.options.getString('outro');

      if (!greeting && !subtitle && !outro) {
        await interaction.reply({ content: `❌ Please provide at least one option (greeting, subtitle, or outro).`, ephemeral: true });
        return;
      }

      const config = loadGuildConfig(guild);
      if (greeting) config.messages.greetingPrefix = greeting;
      if (subtitle) config.messages.welcomeSubtitle = subtitle;
      if (outro) config.messages.outroText = outro;
      saveGuildConfig(guild.id, config);

      const updated = [greeting && `greeting`, subtitle && `subtitle`, outro && `outro`].filter(Boolean).join(', ');
      await interaction.reply({ content: `✅ Updated welcome text: **${updated}**`, ephemeral: true });
      return;
    }

    // ── /setimages (Supports Uploaded Files & Link URLs)
    if (commandName === 'setimages') {
      const bannerFile = interaction.options.getAttachment('banner_file');
      const logoFile = interaction.options.getAttachment('logo_file');
      const bannerUrl = bannerFile ? bannerFile.url : interaction.options.getString('banner_url');
      const logoUrl = logoFile ? logoFile.url : interaction.options.getString('logo_url');

      const config = loadGuildConfig(guild);
      if (!config.customImages) config.customImages = { logoUrl: '', bannerUrl: '' };

      const updates = [];
      if (bannerUrl) {
        config.customImages.bannerUrl = bannerUrl;
        updates.push(`✅ Custom Banner image set (${bannerFile ? 'Uploaded File' : 'URL Link'})`);
      }
      if (logoUrl) {
        config.customImages.logoUrl = logoUrl;
        updates.push(`✅ Custom Logo image set (${logoFile ? 'Uploaded File' : 'URL Link'})`);
      }

      if (updates.length === 0) {
        await interaction.reply({ content: `⚠️ Please upload an image file or provide an image URL link!`, ephemeral: true });
        return;
      }

      saveGuildConfig(guild.id, config);
      await interaction.reply({ content: updates.join('\n') + `\nRun \`/testwelcome\` to preview!`, ephemeral: true });
      return;
    }

    // ── /welcomeconfig
    if (commandName === 'welcomeconfig') {
      const config = loadGuildConfig(guild);
      const ch = config.channels;
      const msg = config.messages;

      const embed = new EmbedBuilder()
        .setColor(isValidHexColor(config.embedColor) ? config.embedColor : '#5865F2')
        .setTitle(`⚙️ Welcome Bot Config — ${guild.name}`)
        .addFields(
          {
            name: '📢 Channels',
            value: [
              `**Welcome:** ${ch.welcomeChannelId ? `<#${ch.welcomeChannelId}>` : '❌ Not set — use `/setwelcome`'}`,
              `**Rules:** ${ch.rulesChannelId ? `<#${ch.rulesChannelId}>` : '❌ Not set — use `/setrules`'}`,
              `**Roles:** ${ch.rolesChannelId ? `<#${ch.rolesChannelId}>` : '❌ Not set — use `/setroles`'}`,
              `**General:** ${ch.generalChannelId ? `<#${ch.generalChannelId}>` : '❌ Not set — use `/setgeneral`'}`,
            ].join('\n'),
          },
          {
            name: '💬 Messages',
            value: [
              `**Greeting:** ${msg.greetingPrefix || '(default)'}`,
              `**Subtitle:** ${msg.welcomeSubtitle || '(default)'}`,
              `**Outro:** ${msg.outroText || '(default)'}`,
            ].join('\n'),
          },
          {
            name: '🎨 Appearance',
            value: `**Color:** ${config.embedColor || '#5865F2'}\n**Server Assets:** ${config.useServerAssets !== false ? 'Enabled ✅' : 'Disabled ❌'}`,
          }
        )
        .setFooter({ text: 'Use /welcomehelp to see all commands' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ── /resetwelcome
    if (commandName === 'resetwelcome') {
      const defaultCfg = getDefaultConfig(guild);
      saveGuildConfig(guild.id, defaultCfg);
      await interaction.reply({ content: `✅ Welcome configuration has been reset to defaults for **${guild.name}**.`, ephemeral: true });
      return;
    }

    // ── /welcomehelp
    if (commandName === 'welcomehelp') {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🤖 Welcome & Goodbye Bot — Commands')
        .setDescription('A fully customizable welcome & inviter bot. Each server gets its own independent settings.')
        .addFields(
          {
            name: '⚡ Quick Setup (Do This First!)',
            value: [
              '`/setup` — **Auto-detects all channels & sets everything up in 1 command!**',
              '   *(Supports image upload for logo & banner, custom color, greeting)*',
            ].join('\n'),
          },
          {
            name: '🛠️ Channel & Image Setup (Admin Only)',
            value: [
              '`/setwelcome [channel]` — Set welcome channel',
              '`/setleave <channel>` — Set member leave/goodbye channel',
              '`/setrules <channel>` — Set rules channel',
              '`/setroles <channel>` — Set roles channel',
              '`/setgeneral <channel>` — Set general channel',
              '`/setimages` — Upload logo/banner image files or URLs',
              '`/setwelcomecolor <#hex>` — Change embed color',
              '`/setwelcometext` — Customize greeting, subtitle, and outro text',
              '`/setleavetext <msg>` — Customize member left message',
              '`/resetwelcome` — Reset all settings to default',
            ].join('\n'),
          },
          {
            name: '👁️ Invites & Previews',
            value: [
              '`/myinvites` — Check your total invited members',
              '`/testwelcome` — Preview the welcome message',
              '`/testleave` — Preview the member left message',
              '`/welcomeconfig` — View current server settings',
              '`/welcomehelp` — Show this help menu',
            ].join('\n'),
          }
        )
        .setFooter({ text: 'Each server has independent settings — this bot is fully public!' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }
  });

  // ── Legacy Text Commands (still supported for backward compat)
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const cmd = message.content.trim().toLowerCase();

    if (cmd === '!testwelcome') {
      try {
        const embed = createWelcomeEmbed(message.member, message.guild);
        await message.channel.send({
          content: `**[TEST PREVIEW]** 🎉 Welcome <@${message.author.id}> to **${message.guild.name}**!`,
          embeds: [embed],
        });
      } catch (err) {
        message.reply(`❌ Error: ${err.message}`);
      }
    }

    if (cmd === '!setwelcome') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply('❌ You need the **Manage Server** permission to do this.');
      }
      const config = loadGuildConfig(message.guild);
      config.channels.welcomeChannelId = message.channel.id;
      saveGuildConfig(message.guild.id, config);
      await message.reply(`✅ Welcome channel set to ${message.channel}!`);
    }
  });

  // ── Login
  const TOKEN = process.env.DISCORD_TOKEN;
  if (!TOKEN || TOKEN === 'your_bot_token_here') {
    console.error('\n❌ DISCORD_TOKEN is missing in your .env file!');
    process.exit(1);
  }

  client.login(TOKEN).catch(err => {
    if (err.message.includes('disallowed intents') || err.message.includes('Privileged intent')) {
      console.error('\n❌ PRIVILEGED INTENTS ERROR!');
      console.error('👉 Enable "SERVER MEMBERS INTENT" in the Discord Developer Portal:');
      console.error('   https://discord.com/developers/applications → Bot → Privileged Gateway Intents');
      process.exit(1);
    } else {
      console.error('❌ Login error:', err.message);
      process.exit(1);
    }
  });
}

// ── Utility: safe reply helper
async function safeReply(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (_) {}
}

startBot();
