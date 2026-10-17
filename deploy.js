/**
 * deploy.js — Deploys slash commands to Discord API
 *
 * Strict deployment safety:
 *  - Canonical Scope: Global Application Commands (exactly 100 commands).
 *  - Validates payload against Discord API v10 constraints before sending.
 *  - Automatically scans and purges redundant guild-scoped commands across all connected guilds
 *    to prevent duplicate slash commands from appearing in Discord's command picker.
 *  - Verifies registration response directly via Discord REST API GET applicationCommands.
 *
 * Usage:
 *   node deploy.js                          (Global deployment + automatic guild duplicate purge + verification)
 *   node deploy.js --clean-only             (Purge guild duplicates without redeploying global payload)
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

const cleanOnly = process.argv.includes('--clean-only');

(async () => {
  try {
    console.log('📡 Fetching bot application details...');
    const user = await rest.get(Routes.user('@me'));
    console.log(`🤖 Authenticated as: ${user.username} (ID: ${user.id})`);

    // 2. Global Application Command Registration
    if (!cleanOnly) {
      console.log(`🌐 Registering ${payload.length} application commands globally (Discord limit: 100)...`);
      const registered = await rest.put(Routes.applicationCommands(user.id), { body: payload });
      console.log(`🎉 Successfully registered ${registered?.length || payload.length} global commands across all connected servers.`);
    }

    // 3. Redundant Guild Command Purge (Prevents Duplicate Slash Commands in Discord UI)
    console.log('🧹 Scanning connected guilds for redundant guild-scoped commands...');
    const guilds = await rest.get(Routes.userGuilds());
    let totalPurgedGuilds = 0;
    let totalGuildCommandsPurged = 0;

    for (const g of guilds) {
      try {
        const guildCmds = await rest.get(Routes.applicationGuildCommands(user.id, g.id));
        if (guildCmds && guildCmds.length > 0) {
          await rest.put(Routes.applicationGuildCommands(user.id, g.id), { body: [] });
          console.log(`  ✅ Purged ${guildCmds.length} duplicate guild commands from guild "${g.name}" (${g.id})`);
          totalPurgedGuilds++;
          totalGuildCommandsPurged += guildCmds.length;
        } else {
          console.log(`  ✓ Guild "${g.name}" (${g.id}) has 0 guild commands (Clean)`);
        }
      } catch (gErr) {
        console.warn(`  ⚠️ Could not check/prune guild ${g.id}: ${gErr.message}`);
      }
    }
    console.log(`✨ Guild command audit complete: ${totalGuildCommandsPurged} duplicate commands purged across ${totalPurgedGuilds} guilds.`);

    // 4. Verification: Fetch back commands directly from Discord API
    console.log('🔎 Verifying registered commands directly from Discord API...');
    const verifiedCmds = await rest.get(Routes.applicationCommands(user.id));
    console.log(`📊 Verified Global Commands Count: ${verifiedCmds.length}`);

    const perfCmd = verifiedCmds.find(c => c.name === 'performance');
    if (perfCmd) {
      console.log(`✅ CONFIRMED: /performance exists on Discord API! (Command ID: ${perfCmd.id})`);
    } else {
      console.error('❌ VERIFICATION FAILED: /performance was not returned by Discord API.');
      process.exit(1);
    }

    // Verify 0 guild commands remain
    let remainingGuildDuplicates = 0;
    for (const g of guilds) {
      const remaining = await rest.get(Routes.applicationGuildCommands(user.id, g.id));
      if (remaining.length > 0) {
        remainingGuildDuplicates += remaining.length;
        console.error(`❌ Duplicate commands still exist in guild ${g.id}: ${remaining.length}`);
      }
    }

    if (remainingGuildDuplicates === 0) {
      console.log('🎯 ZERO DUPLICATES CONFIRMED: All connected guilds have 0 guild-scoped commands.');
      console.log('🌟 Discord client will display exactly 1 copy of each slash command.');
    } else {
      console.error(`❌ FAILED: ${remainingGuildDuplicates} guild commands remain on Discord.`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Command deployment failed:', err.message);
    if (err.rawError) {
      console.error('Detailed Discord API response:', JSON.stringify(err.rawError, null, 2));
    }
    process.exit(1);
  }
})();
