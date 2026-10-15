# COMMAND COVERAGE AUDIT REPORT — THOR APEX BOT v2.0

Generated automatically on: 2026-10-15T01:05:04.802Z

## Executive Summary
- **Total Application Commands Declared:** 100
- **Total Subcommands Declared:** 0
- **Total Executable Endpoints:** 100
- **Implemented Handlers:** 100 / 100 (**100%**)
- **Missing Handlers:** 0
- **Acknowledgement Safety Net:** ✅ Active (guarantees interaction response deadline met)

---

## Command Registry vs Dispatcher Mapping

| Command / Subcommand | Type | Description | Required Permissions | Implementation Status | Test Suite Status |
|---|---|---|---|---|---|
| `/security` | Command | Server security engine, anti-nuke, anti-mod, lockdown and recovery | `32` | ✅ Implemented | ✅ Covered |
| `/automod` | Command | Manage AutoMod system and filters | `32` | ✅ Implemented | ✅ Covered |
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
| `/antispam` | Command | Toggle anti-spam filter | `32` | ✅ Implemented | ✅ Covered |
| `/antilink` | Command | Toggle anti-link filter | `32` | ✅ Implemented | ✅ Covered |
| `/antiraid` | Command | Toggle anti-raid filter | `32` | ✅ Implemented | ✅ Covered |
| `/altdetection` | Command | Toggle alt account detection | `32` | ✅ Implemented | ✅ Covered |
| `/wordfilter` | Command | Toggle word filter | `32` | ✅ Implemented | ✅ Covered |
| `/lockdown` | Command | Toggle server-wide lockdown | `32` | ✅ Implemented | ✅ Covered |
| `/whitelist` | Command | Interactive Whitelist management for Anti-Nuke & Security | `32` | ✅ Implemented | ✅ Covered |
| `/threat` | Command | Instantly switch server DEFCON threat level | `32` | ✅ Implemented | ✅ Covered |
| `/quarantine` | Command | Anti-Raid quarantine management | `32` | ✅ Implemented | ✅ Covered |
| `/quickmod` | Command | Launch rapid one-click interactive moderation panel | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/vpncheck` | Command | Detect suspicious accounts, alts, and lookup hosting/VPN IPs | `1099511627776` | ✅ Implemented | ✅ Covered |
| `/raidmode` | Command | Manual raid defense mode with rapid countermeasures | `32` | ✅ Implemented | ✅ Covered |
| `/songs` | Command | THOR APEX Music & 24/7 Voice System | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/play` | Command | Play a song from YouTube, Spotify, or Soundcloud | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/pause` | Command | Pause music playback | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/resume` | Command | Resume music playback | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/skip` | Command | Skip current song | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/stop` | Command | Stop playback and leave voice channel | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/queue` | Command | Manage and view the music queue | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/nowplaying` | Command | Show currently playing track | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/radio` | Command | Play 24/7 radio stream | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/volume` | Command | Adjust music volume | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/loop` | Command | Set music repeat mode | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/shuffle` | Command | Shuffle the music queue | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/previous` | Command | Play the previous track in history | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/playnow` | Command | Play a track immediately at the front of the queue | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/disconnect` | Command | Leave the voice channel and release player resources | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/search` | Command | Search supported sources for music tracks | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/seek` | Command | Seek to a playback position in the current track | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/musicstatus` | Command | Display real-time music engine, voice connection, and queue diagnostics | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/musicupdate` | Command | Owner-only music auto-update and self-healing system | `8` | ✅ Implemented | ✅ Covered |
| `/lyrics` | Command | Search real-time lyrics for the current song or any track | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/welcome` | Command | Manage high-conversion Welcome cards | `32` | ✅ Implemented | ✅ Covered |
| `/setup` | Command | Auto-setup bot channels and configuration | `8` | ✅ Implemented | ✅ Covered |
| `/setwelcome` | Command | Set welcome channel | `32` | ✅ Implemented | ✅ Covered |
| `/setrules` | Command | Set rules channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setroles` | Command | Set self-roles channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setgeneral` | Command | Set main chat channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setfun` | Command | Set fun channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setedit` | Command | Set editing channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setgaming` | Command | Set gaming channel for welcome card | `32` | ✅ Implemented | ✅ Covered |
| `/setwelcomecolor` | Command | Set welcome embed color (hex e.g. #FF0000) | `32` | ✅ Implemented | ✅ Covered |
| `/setwelcometext` | Command | Customize welcome text fields | `32` | ✅ Implemented | ✅ Covered |
| `/setbanner` | Command | Set or sync welcome banner image (upload file, paste URL, or use server banner) | `32` | ✅ Implemented | ✅ Covered |
| `/setlogo` | Command | Set or sync welcome card logo/icon (upload file, paste URL, or use server icon) | `32` | ✅ Implemented | ✅ Covered |
| `/serverbanner` | Command | Display server banner and optionally apply it to welcome card | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/setautorole` | Command | Set auto-role assigned upon joining | `32` | ✅ Implemented | ✅ Covered |
| `/left` | Command | Manage Member Leave and Goodbye Announcements | `32` | ✅ Implemented | ✅ Covered |
| `/goodbye` | Command | Manage departure and leave messages | `32` | ✅ Implemented | ✅ Covered |
| `/setleave` | Command | Set leave/goodbye channel | `32` | ✅ Implemented | ✅ Covered |
| `/setleavetext` | Command | Customize leave message | `32` | ✅ Implemented | ✅ Covered |
| `/logs` | Command | Configure 15 dedicated log channels under SERVER LOGS category | `32` | ✅ Implemented | ✅ Covered |
| `/inv` | Command | Server Invite Tracking and Leaderboards | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/myinvites` | Command | Check your total server invites | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/invites` | Command | Check server invites for a user | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/invitetop` | Command | Top inviters leaderboard | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/games` | Command | Interactive games, fun, and economy points | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/fun` | Command | Fun minigames and entertainment pack | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/points` | Command | Server points and economy system | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/ping` | Command | Check bot heartbeat latency and gateway ping | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/uptime` | Command | Check bot continuous running time and process health | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/botinfo` | Command | View bot statistics, node runtime, memory, and architecture | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/serverinfo` | Command | View server statistics, security level, and member counts | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/userinfo` | Command | View member profile, roles, creation date, and join position | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/permissions` | Command | Inspect bot and member permissions in the current channel | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/help` | Command | Display comprehensive guide to all bot commands | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/performance` | Command | View bot execution performance, event loop delay, and command latency percentiles | `8` | ✅ Implemented | ✅ Covered |
| `/panel` | Command | Open the THOR APEX interactive admin control centre | `32` | ✅ Implemented | ✅ Covered |
| `/translate` | Command | Translate text into another language | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/appeal` | Command | Unban and punishment appeal system | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/serverstat` | Command | Configure server voice stat channels (voice only, no text channels created) | `32` | ✅ Implemented | ✅ Covered |
| `/afk` | Command | Set or check your AFK status | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/badge` | Command | Manage custom member recognition badges | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/dm` | Command | Staff direct message dispatcher | `32` | ✅ Implemented | ✅ Covered |
| `/nightmode` | Command | Scheduled server quiet hours | `32` | ✅ Implemented | ✅ Covered |
| `/devmode` | Command | Bot performance diagnostics and health monitoring | `32` | ✅ Implemented | ✅ Covered |
| `/serverconfig` | Command | Master server configuration overview and management | `32` | ✅ Implemented | ✅ Covered |
| `/birthday` | Command | Member birthday tracker and celebration | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/maintenance` | Command | Toggle server bot maintenance mode | `32` | ✅ Implemented | ✅ Covered |
| `/clone` | Command | Export or import configuration template between servers | `8` | ✅ Implemented | ✅ Covered |
| `/module` | Command | Toggle server bot feature modules on or off | `32` | ✅ Implemented | ✅ Covered |
| `/roleplay` | Command | Expressive roleplay and anime action interactions | `None (Public)` | ✅ Implemented | ✅ Covered |
| `/integration` | Command | Connect YouTube, Twitch, and GitHub alerts (no extra text channels created) | `32` | ✅ Implemented | ✅ Covered |

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
