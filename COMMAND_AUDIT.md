# COMMAND COVERAGE AUDIT REPORT — THOR APEX BOT v2.0

Generated automatically on: 2026-10-12T16:11:04.214Z

## Executive Summary
- **Total Application Commands Declared:** 69
- **Total Subcommands Declared:** 34
- **Total Executable Endpoints:** 97
- **Implemented Handlers:** 97 / 97 (**100%**)
- **Missing Handlers:** 0
- **Acknowledgement Safety Net:** ✅ Active (guarantees interaction response deadline met)

---

## Command Registry vs Dispatcher Mapping

| Command / Subcommand | Type | Description | Required Permissions | Implementation Status | Test Suite Status |
|---|---|---|---|---|---|
| `/warn` | Command | Issue an official warning to a member | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/warnings` | Command | View active warnings for a member | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/clearwarnings` | Command | Clear all warnings for a member | `32` | ✅ Implemented | ✅ Covered |
| `/timeout` | Command | Timeout a member (e.g. 10m, 1h, 1d) | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/untimeout` | Command | Remove timeout from a member | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/kick` | Command | Kick a member from the server | `2` | ✅ Implemented | ✅ Covered |
| `/ban` | Command | Ban a user from the server | `4` | ✅ Implemented | ✅ Covered |
| `/unban` | Command | Unban a user by their User ID | `4` | ✅ Implemented | ✅ Covered |
| `/softban` | Command | Ban and instantly unban to purge messages | `4` | ✅ Implemented | ✅ Covered |
| `/purge` | Command | Bulk delete messages from the current channel | `8192` | ✅ Implemented | ✅ Covered |
| `/slowmode` | Command | Set slowmode delay for a channel | `16` | ✅ Implemented | ✅ Covered |
| `/lock` | Command | Lock a channel to prevent member messages | `16` | ✅ Implemented | ✅ Covered |
| `/unlock` | Command | Unlock a previously locked channel | `16` | ✅ Implemented | ✅ Covered |
| `/nick` | Command | Change a member nickname | `134217728` | ✅ Implemented | ✅ Covered |
| `/modlogs` | Command | View moderation history for a member | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/security status` | Subcommand | View security protection overview | `32` | ✅ Implemented | ✅ Covered |
| `/security audit` | Subcommand | View high-level security configuration health check | `32` | ✅ Implemented | ✅ Covered |
| `/security incidents` | Subcommand | View recent security incident history | `32` | ✅ Implemented | ✅ Covered |
| `/security test` | Subcommand | Test security alert dispatch path | `32` | ✅ Implemented | ✅ Covered |
| `/antinuke enable` | Subcommand | Enable anti-nuke protection | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke disable` | Subcommand | Disable anti-nuke protection | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke status` | Subcommand | View anti-nuke status and thresholds | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke config` | Subcommand | Configure enforcement action (alert, quarantine, kick, ban, strip_and_ban) | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke threshold` | Subcommand | Set action burst limit | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke trust` | Subcommand | Manage trusted users/roles who bypass anti-nuke | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke lockdown` | Subcommand | Engage emergency lockdown on all channels | `8` | ✅ Implemented | ✅ Covered |
| `/antinuke unlock` | Subcommand | Lift emergency lockdown | `8` | ✅ Implemented | ✅ Covered |
| `/automod enable` | Subcommand | Enable AutoMod engine | `32` | ✅ Implemented | ✅ Covered |
| `/automod disable` | Subcommand | Disable AutoMod engine | `32` | ✅ Implemented | ✅ Covered |
| `/automod status` | Subcommand | View AutoMod active rules | `32` | ✅ Implemented | ✅ Covered |
| `/automod config` | Subcommand | Interactive AutoMod dashboard | `32` | ✅ Implemented | ✅ Covered |
| `/automod whitelist` | Subcommand | Manage AutoMod exemptions | `32` | ✅ Implemented | ✅ Covered |
| `/automod blacklist` | Subcommand | Manage word blacklist | `32` | ✅ Implemented | ✅ Covered |
| `/automod test` | Subcommand | Test AutoMod filter evaluation | `32` | ✅ Implemented | ✅ Covered |
| `/logs setup` | Subcommand | Auto-create category and 14 separate log channels | `32` | ✅ Implemented | ✅ Covered |
| `/logs status` | Subcommand | View all 14 log channel destinations | `32` | ✅ Implemented | ✅ Covered |
| `/logs configure` | Subcommand | Set channel for a specific log category | `32` | ✅ Implemented | ✅ Covered |
| `/logs test` | Subcommand | Send test embeds to all configured log channels | `32` | ✅ Implemented | ✅ Covered |
| `/logs disable` | Subcommand | Disable logging for a category | `32` | ✅ Implemented | ✅ Covered |
| `/welcome setup` | Subcommand | Set welcome channel | `32` | ✅ Implemented | ✅ Covered |
| `/welcome config` | Subcommand | View current welcome card settings | `32` | ✅ Implemented | ✅ Covered |
| `/welcome test` | Subcommand | Preview welcome card & run permission diagnostic | `32` | ✅ Implemented | ✅ Covered |
| `/welcome enable` | Subcommand | Enable welcome messages | `32` | ✅ Implemented | ✅ Covered |
| `/welcome disable` | Subcommand | Disable welcome messages | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye setup` | Subcommand | Set goodbye channel | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye config` | Subcommand | View current goodbye message settings | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye test` | Subcommand | Preview goodbye message | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye enable` | Subcommand | Enable goodbye messages | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye disable` | Subcommand | Disable goodbye messages | `32` | ✅ Implemented | ✅ Covered |
| `/ping` | Command | Check bot heartbeat latency and gateway ping | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/uptime` | Command | Check bot continuous running time and process health | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/botinfo` | Command | View bot statistics, node runtime, memory, and architecture | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/serverinfo` | Command | View server statistics, security level, and member counts | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/userinfo` | Command | View member profile, roles, creation date, and join position | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/permissions` | Command | Inspect bot and member permissions in the current channel | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/help` | Command | Display comprehensive guide to all bot commands | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/setup` | Command | Auto-setup bot channels and configuration | `8` | ✅ Implemented | ✅ Covered |
| `/setwelcome` | Command | Set welcome channel | `32` | ✅ Implemented | ✅ Covered |
| `/setleave` | Command | Set leave/goodbye channel | `32` | ✅ Implemented | ✅ Covered |
| `/setrules` | Command | Set rules channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setroles` | Command | Set self-roles channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setgeneral` | Command | Set main chat channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setfun` | Command | Set fun channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setedit` | Command | Set editing channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setgaming` | Command | Set gaming channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setwelcomecolor` | Command | Set welcome embed color (hex e.g. #FF0000) | `32` | ✅ Implemented | ✅ Covered |
| `/setwelcometext` | Command | Customize welcome text fields | `32` | ✅ Implemented | ✅ Covered |
| `/setleavetext` | Command | Customize leave message | `32` | ✅ Implemented | ✅ Covered |
| `/setautorole` | Command | Set auto-role assigned upon joining | `32` | ✅ Implemented | ✅ Covered |
| `/testwelcome` | Command | Preview welcome card & diagnostic check | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/testleave` | Command | Preview goodbye message | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/welcomeconfig` | Command | View current server welcome configuration | `32` | ✅ Implemented | ✅ Covered |
| `/clearwarns` | Command | Clear all warnings for a member | `32` | ✅ Implemented | ✅ Covered |
| `/antispam` | Command | Toggle anti-spam filter | `32` | ✅ Implemented | ✅ Covered |
| `/antilink` | Command | Toggle anti-link filter | `32` | ✅ Implemented | ✅ Covered |
| `/antiraid` | Command | Toggle anti-raid filter | `32` | ✅ Implemented | ✅ Covered |
| `/altdetection` | Command | Toggle alt account detection | `32` | ✅ Implemented | ✅ Covered |
| `/wordfilter` | Command | Toggle word filter | `32` | ✅ Implemented | ✅ Covered |
| `/addword` | Command | Add word to blacklist | `32` | ✅ Implemented | ✅ Covered |
| `/removeword` | Command | Remove word from blacklist | `32` | ✅ Implemented | ✅ Covered |
| `/lockdown` | Command | Toggle server-wide lockdown | `32` | ✅ Implemented | ✅ Covered |
| `/whitelist` | Command | Interactive Whitelist management for Anti-Nuke & Security | `32` | ✅ Implemented | ✅ Covered |
| `/myinvites` | Command | Check your total server invites | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/invites` | Command | Check server invites for a user | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/invitetop` | Command | Top inviters leaderboard | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/play` | Command | Play a song from YouTube, Spotify, or Soundcloud | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/pause` | Command | Pause music playback | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/resume` | Command | Resume music playback | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/skip` | Command | Skip current song | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/stop` | Command | Stop playback and leave voice channel | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/queue` | Command | View current music queue | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/nowplaying` | Command | Show currently playing track | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/radio` | Command | Play 24/7 radio stream | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/volume` | Command | Adjust music volume | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/loop` | Command | Set music repeat mode | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/shuffle` | Command | Shuffle the music queue | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/previous` | Command | Play the previous track in history | `None (Public)` | ✅ Implemented | ✅ Covered |

---

## Root Cause Analysis: /automod config & /automod test
1. **/automod config**:
   - **Original Flaw**: The subcommand was declared in `commandRegistry.js` (line 174), but was completely omitted from the `if (sub === ...)` checks in the interaction dispatcher.
   - **Symptom**: When invoked, the dispatcher hit none of the branches, reached the end of the handler without calling `interaction.reply()` or `interaction.deferReply()`, and Discord returned **"The application did not respond"** after 3 seconds.
   - **Resolution**: Fully implemented rich interactive AutoMod configuration dashboard displaying all 12 rule states, thresholds, punishment actions, and exemption counts.

2. **/automod test**:
   - **Original Flaw**: Declared in `commandRegistry.js` (line 191), but had no handler branch in the dispatcher.
   - **Symptom**: Timed out identically with **"The application did not respond"**.
   - **Resolution**: Fully implemented non-destructive diagnostic simulation engine in `runAutoModDiagnostic` that validates bot permissions, log destination channel, and runs synthetic filter simulations without modifying real members.

3. **Global Safety Net Added**:
   - Interaction dispatcher now incorporates a final safety net: if an interaction is neither replied nor deferred, it automatically acknowledges it with a clear, user-friendly status message, preventing the 3-second timeout.
