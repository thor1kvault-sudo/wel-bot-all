const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

// HTTP Health Check Server (Required for free hosts like Render/Koyeb to stay online)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('⚡ THOR APEX Welcome Bot is Online & Running!\n');
}).listen(PORT, () => {
  console.log(`🌐 Health check web server running on port ${PORT}`);
});

const configPath = path.join(__dirname, 'config.json');
let config = require(configPath);

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`💾 Configuration updated and saved to config.json!`);
  } catch (err) {
    console.error(`❌ Failed to save config.json:`, err);
  }
}

function formatChannelMention(channelId, fallbackName) {
  if (!channelId || channelId.startsWith('PASTE_') || !/^\d+$/.test(channelId)) {
    return `\`#${fallbackName}\``;
  }
  return `<#${channelId}>`;
}

// Custom Welcome Embed for THOR APEX ⚡
function createWelcomeEmbed(member, guild) {
  const rulesTag = formatChannelMention(config.channels.rulesChannelId, 'Rules');
  const funTag = formatChannelMention(config.channels.funChannelId, 'fun-time');
  const editingTag = formatChannelMention(config.channels.editingChannelId, 'pc-editing');
  const gamingTag = formatChannelMention(config.channels.gamingChannelId, 'gaming-text');
  const chillTag = formatChannelMention(config.channels.chillOutChannelId, 'General');

  // Resolve Logo URL safely
  let logoUrl = null;
  if (guild && guild.iconURL) {
    logoUrl = guild.iconURL({ size: 1024 });
  }
  if (!logoUrl && config.customImages && config.customImages.logoUrl) {
    logoUrl = config.customImages.logoUrl;
  }
  if (typeof logoUrl !== 'string' || !logoUrl.startsWith('http')) {
    logoUrl = undefined;
  }

  // Resolve Banner URL safely
  let bannerUrl = null;
  if (guild && guild.bannerURL) {
    bannerUrl = guild.bannerURL({ size: 1024 });
  }
  if (!bannerUrl && config.customImages && config.customImages.bannerUrl) {
    bannerUrl = config.customImages.bannerUrl;
  }
  if (typeof bannerUrl !== 'string' || !bannerUrl.startsWith('http')) {
    bannerUrl = undefined;
  }

  const userId = member && member.user ? member.user.id : (member ? member.id : '000000000000000000');
  const guildName = guild ? guild.name : (config.serverName || 'THOR APEX ⚡');

  const embed = new EmbedBuilder()
    .setColor(config.embedColor && config.embedColor.startsWith('#') ? config.embedColor : '#FF0000')
    .setDescription(
      `### ${config.messages.greetingPrefix || 'HEY BUDDY!'} <@${userId}>\n\n` +
      `**${config.messages.welcomeSubtitle || 'Welcome To THOR APEX !'}**\n` +
      `**${config.messages.rulesText || 'Get started with below:'}** ${rulesTag}\n\n\n` +
      `**${config.messages.guidelinesLabel || 'Follow The Server Guidelines:'}** ${rulesTag}\n\n` +
      `**${config.messages.funLabel || 'Fun With Us:'}** ${funTag}\n\n` +
      `**${config.messages.editingLabel || 'Editing Zone:'}** ${editingTag}\n\n` +
      `**${config.messages.gamingLabel || 'Gaming Zone:'}** ${gamingTag}\n\n` +
      `**${config.messages.chillLabel || 'Join And Chill With Us!:'}** ${chillTag}\n\n\n` +
      `### ${config.messages.outroText || 'Thanks For Joining. Hope You Have A Great Time Here!'}`
    )
    .setTimestamp();

  // Author
  const authorOptions = { name: config.welcomeTitle || `${guildName} !` };
  if (logoUrl) authorOptions.iconURL = logoUrl;
  embed.setAuthor(authorOptions);

  // Thumbnail
  if (logoUrl) embed.setThumbnail(logoUrl);

  // Banner Image
  if (bannerUrl) embed.setImage(bannerUrl);

  // Footer (Discord.js v14 expects text property)
  const footerOptions = { text: guildName };
  if (logoUrl) footerOptions.iconURL = logoUrl;
  embed.setFooter(footerOptions);

  return embed;
}

// Setup Slash Commands
async function registerSlashCommands(clientId, token) {
  const commands = [
    new SlashCommandBuilder()
      .setName('testwelcome')
      .setDescription('Preview the custom welcome embed for THOR APEX'),
    new SlashCommandBuilder()
      .setName('setwelcome')
      .setDescription('Set current channel as the Welcome channel'),
    new SlashCommandBuilder()
      .setName('helpwelcome')
      .setDescription('Show help and commands for THOR APEX Welcome Bot')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  try {
    console.log(`⏳ Registering Slash Commands (/testwelcome, /setwelcome)...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`✅ Slash Commands successfully registered!`);
  } catch (err) {
    console.error(`⚠️ Slash Commands registration warning:`, err.message);
  }
}

function startBot(withPrivilegedIntents = true) {
  const intents = withPrivilegedIntents
    ? [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    : [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
      ];

  const client = new Client({ intents });

  client.once('ready', async () => {
    console.log(`\n=======================================================`);
    console.log(`⚡ THOR APEX WELCOME BOT IS ONLINE & READY!`);
    console.log(`🤖 Logged in as: ${client.user.tag}`);
    console.log(`🛡️  Connected to ${client.guilds.cache.size} server(s):`);

    client.guilds.cache.forEach(guild => {
      console.log(`   • ${guild.name} (ID: ${guild.id})`);
    });

    if (!withPrivilegedIntents) {
      console.log(`\n⚠️  NOTE: Running with Standard Intents.`);
      console.log(`👉 Enable SERVER MEMBERS INTENT in Discord Portal for automatic join welcomes.`);
    } else {
      console.log(`\n✅ Full Privileged Intents Active! Member joins will auto-welcome.`);
    }

    console.log(`=======================================================`);
    console.log(`💡 Type /testwelcome or !testwelcome in Discord to preview!`);
    console.log(`=======================================================\n`);

    await registerSlashCommands(client.user.id, process.env.DISCORD_TOKEN);
  });

  // Member Joined Event
  client.on('guildMemberAdd', async (member) => {
    console.log(`🔔 New Member Joined: ${member.user.tag} in ${member.guild.name}`);
    let welcomeChannel = null;
    const configuredId = config.channels.welcomeChannelId;

    if (configuredId && /^\d+$/.test(configuredId)) {
      welcomeChannel = member.guild.channels.cache.get(configuredId);
    }
    if (!welcomeChannel) {
      welcomeChannel = member.guild.channels.cache.find(c =>
        c.isTextBased() && (c.name.includes('welcome') || c.name.includes('join') || c.name.includes('general'))
      );
    }
    if (!welcomeChannel) {
      welcomeChannel = member.guild.systemChannel;
    }
    if (!welcomeChannel) return;

    try {
      const welcomeEmbed = createWelcomeEmbed(member, member.guild);
      await welcomeChannel.send({
        content: `Welcome <@${member.id}> to **${member.guild.name}**! 🎉`,
        embeds: [welcomeEmbed]
      });
      console.log(`✅ Welcome embed sent for ${member.user.tag}`);
    } catch (err) {
      console.error(`❌ Error sending welcome embed on join:`, err);
    }
  });

  // Handle Slash Commands
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'testwelcome') {
      try {
        const embed = createWelcomeEmbed(interaction.member, interaction.guild);
        await interaction.reply({
          content: `**[TEST PREVIEW]** Welcome <@${interaction.user.id}> to **${interaction.guild.name}**!`,
          embeds: [embed]
        });
        console.log(`🧪 /testwelcome preview sent for ${interaction.user.tag}`);
      } catch (err) {
        console.error(`❌ Detailed Error on /testwelcome:`, err);
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `❌ Error sending embed: ${err.message}` });
        } else {
          await interaction.reply({ content: `❌ Error sending embed: ${err.message}` });
        }
      }
    }

    if (commandName === 'setwelcome') {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: `❌ Administrator permission required.` });
      }
      config.channels.welcomeChannelId = interaction.channel.id;
      saveConfig();
      return interaction.reply({ content: `✅ Successfully set ${interaction.channel} as the **Welcome Channel**!` });
    }

    if (commandName === 'helpwelcome') {
      return interaction.reply({
        content: `⚡ **THOR APEX Welcome Bot Help** ⚡\n\n` +
          `• Use \`/testwelcome\` or \`!testwelcome\` to preview\n` +
          `• Use \`/setwelcome\` or \`!setwelcome\` to set welcome channel`
      });
    }
  });

  // Handle Text Commands (!testwelcome, !setwelcome)
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const command = message.content.trim().toLowerCase();

    if (command === '!testwelcome') {
      try {
        const embed = createWelcomeEmbed(message.member, message.guild);
        await message.channel.send({
          content: `**[TEST PREVIEW]** Welcome <@${message.author.id}> to **${message.guild.name}**!`,
          embeds: [embed]
        });
        console.log(`🧪 !testwelcome preview sent for ${message.author.tag}`);
      } catch (err) {
        console.error(`❌ Detailed Error on !testwelcome:`, err);
        message.reply(`❌ Could not send embed. Error details logged.`);
      }
    }

    if (command === '!setwelcome') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
      config.channels.welcomeChannelId = message.channel.id;
      saveConfig();
      await message.reply(`✅ Successfully set ${message.channel} as the **Welcome Channel**!`);
    }
  });

  const TOKEN = process.env.DISCORD_TOKEN;
  client.login(TOKEN).catch(err => {
    if (withPrivilegedIntents && (err.message.includes('disallowed intents') || err.message.includes('Privileged intent'))) {
      console.log(`\n⚠️  Privileged intents not enabled in Discord Portal yet. Retrying with Standard Intents...`);
      startBot(false);
    } else {
      console.error(`❌ DISCORD LOGIN ERROR:`, err.message);
      process.exit(1);
    }
  });
}

startBot(true);
