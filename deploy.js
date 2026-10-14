/**
 * deploy.js — Deploys slash commands to Discord API
 *
 * Strict deployment safety:
 *  - Validates payload against Discord API v10 constraints before sending.
 *  - Deploys canonical global application commands.
 *  - Never bulk-deletes commands across unrelated servers. Only prunes stale guild
 *    commands on the explicitly configured target guild (via GUILD_ID in .env or --guild-id=<id>).
 *
 * Usage:
 *   node deploy.js                          (Global deployment)
 *   node deploy.js --guild-id=<id>          (Global deployment + clear target guild stale commands)
 *   node deploy.js --guild-only --guild-id=<id> (Guild-scoped deployment to target guild only)
 */
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { buildApplicationCommands, validateCommandPayload } = require('./src/commands/commandRegistry');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN is missing in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);
const commands = buildApplicationCommands();
const payload = commands.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));

// 1. Pre-deployment Validation against Discord API Rules
console.log(`🔍 Validating ${payload.length} commands against Discord API v10 rules...`);
const validation = validateCommandPayload(payload);
if (!validation.valid) {
  console.error('❌ Command payload validation failed:');
  for (const err of validation.errors) {
    console.error(`  • ${err}`);
  }
  process.exit(1);
}
console.log(`✅ Payload validation passed (${payload.length}/100 commands valid).`);

const isGuildOnly = process.argv.includes('--guild-only');
const targetGuildId = process.env.GUILD_ID || process.argv.find(a => a.startsWith('--guild-id='))?.split('=')[1];

(async () => {
  try {
    console.log('📡 Fetching bot application details...');
    const user = await rest.get(Routes.user('@me'));
    console.log(`🤖 Authenticated as: ${user.username} (ID: ${user.id})`);

    if (isGuildOnly) {
      if (!targetGuildId) {
        console.error('❌ Guild-only deployment requires GUILD_ID in .env or --guild-id=<id> CLI flag.');
        console.error('   Aborting to prevent deploying commands across arbitrary servers.');
        process.exit(1);
      }
      console.log(`⚡ Deploying ${payload.length} guild-scoped commands to target guild: ${targetGuildId}...`);
      await rest.put(Routes.applicationGuildCommands(user.id, targetGuildId), { body: payload });
      console.log(`✅ Guild ${targetGuildId} commands successfully deployed.`);
    } else {
      // Clean up stale guild-scoped commands ONLY for the explicitly configured target guild
      if (targetGuildId) {
        console.log(`🧹 Clearing stale guild-scoped commands for explicitly configured target guild ${targetGuildId}...`);
        try {
          await rest.put(Routes.applicationGuildCommands(user.id, targetGuildId), { body: [] });
          console.log(`✅ Stale guild commands cleared for target guild ${targetGuildId}.`);
        } catch (cleanErr) {
          console.warn(`⚠️ Could not clear guild commands for ${targetGuildId}: ${cleanErr.message}`);
        }
      } else {
        console.log('ℹ️ No target GUILD_ID configured; skipping guild-scoped purge to protect unrelated servers.');
      }

      console.log(`🌐 Registering ${payload.length} application commands globally (Discord limit: 100)...`);
      const registered = await rest.put(Routes.applicationCommands(user.id), { body: payload });
      console.log(`🎉 Successfully registered ${registered?.length || payload.length} global commands across all connected servers.`);
    }
  } catch (err) {
    console.error('❌ Command deployment failed:', err.message);
    if (err.rawError) {
      console.error('Detailed Discord API response:', JSON.stringify(err.rawError, null, 2));
    }
    process.exit(1);
  }
})();
