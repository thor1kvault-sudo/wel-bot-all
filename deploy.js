/**
 * deploy.js — Deploys slash commands to Discord API
 * Deploys directly to connected guilds for INSTANT (0s) visibility in Discord,
 * plus globally for cross-server support.
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { buildApplicationCommands } = require('./src/commands/commandRegistry');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const commands = buildApplicationCommands();

(async () => {
  try {
    console.log('📡 Fetching bot application details...');
    const user = await rest.get(Routes.user('@me'));
    console.log(`🤖 Authenticated as: ${user.username} (ID: ${user.id})`);

    console.log('📡 Fetching connected guilds...');
    const guilds = await rest.get(Routes.userGuilds());
    console.log(`📍 Found ${guilds.length} connected server(s): ${guilds.map(g => `"${g.name}"`).join(', ')}`);

    for (const guild of guilds) {
      console.log(`⚡ Deploying ${commands.length} commands to guild "${guild.name}" (${guild.id})...`);
      await rest.put(Routes.applicationGuildCommands(user.id, guild.id), { body: commands });
      console.log(`✅ Guild "${guild.name}" updated! Commands available INSTANTLY.`);
    }

    console.log(`🌐 Registering ${commands.length} commands globally...`);
    await rest.put(Routes.applicationCommands(user.id), { body: commands });
    console.log(`🎉 Success! All commands deployed to Discord.`);
  } catch (err) {
    console.error('❌ Command deployment failed:', err);
    process.exit(1);
  }
})();
