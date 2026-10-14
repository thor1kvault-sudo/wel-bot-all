/**
 * deploy.js — Deploys slash commands to Discord API
 *
 * Prevents duplicate command registrations in the Discord command picker by cleanly
 * deploying global application commands and pruning any stale guild-scoped commands.
 *
 * Usage:
 *   node deploy.js              (Global deployment + clear stale guild commands)
 *   node deploy.js --guild-only (Guild-scoped deployment only)
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
const isGuildOnly = process.argv.includes('--guild-only');

(async () => {
  try {
    console.log('📡 Fetching bot application details...');
    const user = await rest.get(Routes.user('@me'));
    console.log(`🤖 Authenticated as: ${user.username} (ID: ${user.id})`);

    console.log('📡 Fetching connected guilds...');
    const guilds = await rest.get(Routes.userGuilds());
    console.log(`📍 Found ${guilds.length} connected server(s): ${guilds.map(g => `"${g.name}"`).join(', ')}`);

    if (isGuildOnly) {
      console.log(`⚡ Deploying ${commands.length} guild-scoped commands...`);
      for (const guild of guilds) {
        await rest.put(Routes.applicationGuildCommands(user.id, guild.id), { body: commands });
        console.log(`✅ Guild "${guild.name}" (${guild.id}) updated.`);
      }
    } else {
      // Clean up stale guild-scoped commands to prevent duplicate entries in Discord command picker
      console.log('🧹 Clearing stale guild-scoped commands to prevent duplicate command entries...');
      for (const guild of guilds) {
        try {
          await rest.put(Routes.applicationGuildCommands(user.id, guild.id), { body: [] });
        } catch (_) {}
      }

      console.log(`🌐 Registering ${commands.length} application commands globally (Discord limit: 100)...`);
      const registered = await rest.put(Routes.applicationCommands(user.id), { body: commands });
      console.log(`🎉 Successfully registered ${registered?.length || commands.length} global commands across all connected servers.`);
    }
  } catch (err) {
    console.error('❌ Command deployment failed:', err.message);
    if (err.rawError) {
      console.error('Detailed Discord API response:', JSON.stringify(err.rawError, null, 2));
    }
    process.exit(1);
  }
})();
