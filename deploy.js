/**
 * deploy.js — Deploys slash commands to Discord API
 *
 * Strict deployment safety:
 *  - Validates payload against Discord API v10 constraints before sending.
 *  - Deploys canonical global application commands.
 *  - Never bulk-deletes commands across unrelated servers. Only prunes stale guild
 *    commands on the explicitly configured target guild (via GUILD_ID in .env or --guild-id=<id>).
 *  - Supports --sync-guilds for instant slash command suggestion update across connected guilds.
 *  - Verifies registration response directly via Discord REST API GET applicationCommands.
 *
 * Usage:
 *   node deploy.js                          (Global deployment + verification)
 *   node deploy.js --sync-guilds            (Global + instant connected guilds deployment)
 *   node deploy.js --guild-id=<id>          (Global deployment + target guild sync)
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
const syncGuilds = process.argv.includes('--sync-guilds') || process.argv.includes('--all-guilds');
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
      console.log(`🌐 Registering ${payload.length} application commands globally (Discord limit: 100)...`);
      const registered = await rest.put(Routes.applicationCommands(user.id), { body: payload });
      console.log(`🎉 Successfully registered ${registered?.length || payload.length} global commands across all connected servers.`);

      // Instant guild deployment for connected guilds if requested or if targetGuildId specified
      if (syncGuilds) {
        console.log('⚡ Instant-Sync: Deploying commands to connected guilds for 0-delay slash suggestions...');
        const guilds = await rest.get(Routes.userGuilds());
        for (const g of guilds) {
          try {
            await rest.put(Routes.applicationGuildCommands(user.id, g.id), { body: payload });
            console.log(`  • Instantly synced ${payload.length} commands to guild "${g.name}" (${g.id})`);
          } catch (gErr) {
            console.warn(`  ⚠️ Could not sync guild ${g.id}: ${gErr.message}`);
          }
        }
      } else if (targetGuildId) {
        console.log(`⚡ Instant-Sync: Deploying commands to target guild ${targetGuildId}...`);
        await rest.put(Routes.applicationGuildCommands(user.id, targetGuildId), { body: payload });
        console.log(`✅ Target guild ${targetGuildId} commands successfully synced.`);
      }

      // Verification: Fetch back the registered global commands directly from Discord API
      console.log('🔎 Verifying registered global commands directly from Discord API...');
      const verifiedCmds = await rest.get(Routes.applicationCommands(user.id));
      const perfCmd = verifiedCmds.find(c => c.name === 'performance');
      if (perfCmd) {
        console.log(`✅ CONFIRMED: /performance exists on Discord API! (Command ID: ${perfCmd.id})`);
      } else {
        console.error('❌ VERIFICATION FAILED: /performance was not returned by Discord API.');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('❌ Command deployment failed:', err.message);
    if (err.rawError) {
      console.error('Detailed Discord API response:', JSON.stringify(err.rawError, null, 2));
    }
    process.exit(1);
  }
})();
