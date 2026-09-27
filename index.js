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
 * Uses the guild's actual name, icon, and banner automatically.
 */
function getDefaultConfig(guild) {
  return {
    serverName: guild ? guild.name : 'Your Server',
    welcomeTitle: guild ? `Welcome to ${guild.name}!` : 'Welcome!',
    embedColor: '#5865F2',
    channels: {
      welcomeChannelId: '',
      rulesChannelId: '',
      rolesChannelId: '',
      generalChannelId: '',
    },
    messages: {
      greetingPrefix: 'HEY BUDDY!',
      welcomeSubtitle: guild ? `Welcome to ${guild.name}!` : 'Welcome to our server!',
      rulesText: 'Please read our rules:',
      outroText: 'Hope you enjoy your stay here! 🎉',
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

// ─── Welcome Embed Builder ────────────────────────────────────────────────────
function createWelcomeEmbed(member, guild) {
  const config = loadGuildConfig(guild);

  // Resolve logo: use server icon if available & allowed, else fallback to custom URL
  let logoUrl = null;
  if (config.useServerAssets !== false && guild.iconURL) {
    logoUrl = guild.iconURL({ size: 1024, dynamic: true });
  }
  if (!logoUrl && config.customImages?.logoUrl?.startsWith('http')) {
    logoUrl = config.customImages.logoUrl;
  }

  // Resolve banner: use server banner if available & allowed, else custom URL
  let bannerUrl = null;
  if (config.useServerAssets !== false && guild.bannerURL) {
    bannerUrl = guild.bannerURL({ size: 1024 });
  }
  if (!bannerUrl && config.customImages?.bannerUrl?.startsWith('http')) {
    bannerUrl = config.customImages.bannerUrl;
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

  if (config.channels?.rulesChannelId) {
    lines.push(`**${config.messages?.rulesText || 'Please read our rules:'}** ${rulesTag}\n`);
  }
  if (config.channels?.rolesChannelId) {
    lines.push(`**🎭 Get your roles here:** ${rolesTag}\n`);
  }
  if (config.channels?.generalChannelId) {
    lines.push(`**💬 Start chatting in:** ${generalTag}\n`);
  }

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
  const avatarUrl = member?.user?.displayAvatarURL({ size: 256, dynamic: true });
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  else if (logoUrl) embed.setThumbnail(logoUrl);

  // Banner image
  if (bannerUrl) embed.setImage(bannerUrl);

  // Footer
  const footerOptions = { text: guildName };
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

    // ── Auto Setup (detects channels automatically)
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Auto-setup the welcome bot for this server (detects channels automatically)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addStringOption(opt =>
        opt.setName('color')
          .setDescription('Embed color (e.g. #FF5733) — leave empty to use default blue')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt.setName('greeting')
          .setDescription('Custom greeting text (e.g. "HEY THERE!") — leave empty for default')
          .setRequired(false)
      ),

    // ── Help
    new SlashCommandBuilder()
      .setName('welcomehelp')
      .setDescription('Show all available Welcome Bot commands'),
  ].map(cmd => cmd.toJSON());
}

// ─── Register Slash Commands ───────────────────────────────────────────────────
async function registerSlashCommands(client) {
  const commands = buildSlashCommands();
  const token = process.env.DISCORD_TOKEN;
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log('⏳ Registering slash commands globally...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

    // Also register guild-level for instant appearance
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(client.user.id, guild.id),
          { body: commands }
        );
        console.log(`✅ Instant commands registered for: "${guild.name}"`);
      } catch (e) {
        console.warn(`⚠️ Could not register instant commands for ${guild.name}: ${e.message}`);
      }
    }

    console.log('✅ All slash commands registered!');
  } catch (err) {
    console.error('⚠️ Slash command registration error:', err.message);
  }
}

// ─── Also register commands when bot joins a new server ───────────────────────
async function registerCommandsForGuild(client, guild) {
  const commands = buildSlashCommands();
  const token = process.env.DISCORD_TOKEN;
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
    console.log(`✅ Commands registered for new guild: "${guild.name}"`);
  } catch (e) {
    console.warn(`⚠️ Could not register commands for new guild ${guild.name}: ${e.message}`);
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
    await registerSlashCommands(client);
  });

  // ── Bot Joins a New Server → register commands instantly
  client.on('guildCreate', async (guild) => {
    console.log(`🆕 Bot added to new server: "${guild.name}" (${guild.id})`);
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

      const embed = createWelcomeEmbed(member, member.guild);
      await welcomeChannel.send({
        content: `🎉 Welcome <@${member.id}> to **${member.guild.name}**!`,
        embeds: [embed],
      });
      console.log(`✅ Welcome sent for ${member.user.tag} in #${welcomeChannel.name}`);
    } catch (err) {
      console.error('❌ guildMemberAdd error:', err);
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

        // ── Server icon/banner auto-used
        config.useServerAssets = true;
        results.push(`✅ Server Icon → Auto (using your server's icon)`);
        if (guild.bannerURL()) {
          results.push(`✅ Server Banner → Auto (using your server's banner)`);
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
              '• Fix any ⚠️ channels above using the manual commands',
              '• Run `/welcomeconfig` to see full settings',
              '• Run `/setwelcometext` to customize messages',
            ].join('\n')
          })
          .setThumbnail(guild.iconURL({ size: 256, dynamic: true }))
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
        .setTitle('🤖 Welcome Bot — Commands')
        .setDescription('A fully customizable welcome bot. Each server gets its own independent settings.')
        .addFields(
          {
            name: '⚡ Quick Setup (Do This First!)',
            value: [
              '`/setup` — **Auto-detects all channels & sets everything up in 1 command!**',
              '   *(Optional: add a color like `/setup color:#FF5733`)*',
            ].join('\n'),
          },
          {
            name: '🛠️ Manual Setup (Admin Only)',
            value: [
              '`/setwelcome [channel]` — Set the welcome channel *(defaults to current)*',
              '`/setrules <channel>` — Set the rules channel shown in welcome',
              '`/setroles <channel>` — Set the roles channel shown in welcome',
              '`/setgeneral <channel>` — Set the general/chat channel shown in welcome',
              '`/setwelcomecolor <#hex>` — Change the embed color',
              '`/setwelcometext` — Customize greeting, subtitle, and outro text',
              '`/resetwelcome` — Reset all settings to default *(Admin only)*',
            ].join('\n'),
          },
          {
            name: '👁️ View & Test',
            value: [
              '`/welcomeconfig` — View current configuration for this server',
              '`/testwelcome` — Preview the welcome message',
              '`/welcomehelp` — Show this help menu',
            ].join('\n'),
          },
          {
            name: '✅ Quick Start Guide',
            value: [
              '1️⃣ Run `/setup` — auto-detects everything!',
              '2️⃣ Run `/testwelcome` to preview',
              '3️⃣ Fix any missed channels manually if needed',
              '4️⃣ Done! 🎉 Bot will now welcome every new member',
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
