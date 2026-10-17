# 📋 COMMAND AUDIT REPORT — THOR APEX BOT v2.0
**Audit Date:** 2026-10-17  
**Auditor:** Senior Discord.js v14 Security Engineer  
**Repository:** [https://github.com/thor1kvault-sudo/wel-bot-all](https://github.com/thor1kvault-sudo/wel-bot-all)  
**Main Branch:** `main`  
**Runtime:** Node.js >= 22.12.0, Discord.js v14.18.0, Render Deployed  

---

## 1. Executive Summary

A comprehensive command registry, dispatch, routing, and permission audit of the **THOR APEX** Discord bot was conducted. 

| Metric | Result | Target / Limit | Status |
|---|---|---|---|
| **Total Global Application Commands** | **100** | Max 100 (Discord API v10 limit) | ✅ Exactly 100 (Compliant) |
| **Top-Level Duplicate Command Names** | **0** | 0 | ✅ Zero Duplicates |
| **Executable Command Endpoints** | **100** | 100 | ✅ 100% Handled |
| **Implemented Handlers in Dispatcher** | **100 / 100** | 100% Coverage | ✅ Complete Single-Handler Routing |
| **Multi-Handler Collisions** | **0** | 0 | ✅ Zero Collision (1 interaction ➔ 1 handler) |
| **Discord API v10 Payload Validation** | **0 Errors** | 0 Errors | ✅ Validated via `validateCommandPayload` |
| **Automated Test Suite Pass Rate** | **218 / 218 Tests** | 100% | ✅ 100% Pass |

---

## 2. Duplicate & Overlapping Command Analysis & Resolution

| Command / Pair | Type | Analysis & Findings | Resolution & Mapping | Compatibility Impact |
|---|---|---|---|---|
| `/security antomod` vs `/security antimod` | Subcommand Groups | Both subcommand groups declared identical subcommands (`status`, `configure`, `test`). `antomod` was an earlier typo alias. | Retained unified dispatcher handler (`group === 'antomod' \|\| group === 'antimod'`). Both route to the same robust Anti-Mod abuse engine. Canonical recommended syntax is `/security antimod`. | 100% Backward compatible; zero disruption. |
| `/security lockdown` & `/security unlock` vs `/lockdown` | Standalone vs Subcommand | `/security lockdown` and `/security unlock` provide full permission snapshotting and atomic restoration. `/lockdown` existed as a standalone shortcut. | Preserved both. Refactored standalone `/lockdown` to delegate directly to the safe `engageEmergencyLockdown` and `liftEmergencyLockdown` pipeline with identical snapshot guarantees and partial-failure reporting. | Backward compatible; eliminated state desync between standalone toggle and security suite. |
| `/security trust` vs `/whitelist` | Standalone vs Subcommand | `/security trust add\|remove\|list` manages exempt users and roles. `/whitelist` was a legacy standalone command doing the same. | Preserved both. Both update `config.security.trustedUsers` and `config.security.trustedRoles` with identical validation and safe feedback. | Zero compatibility impact. |
| `/automod` vs `/antispam`, `/antilink`, `/antiraid`, `/altdetection`, `/wordfilter` | Standalone vs Grouped | `/automod` manages the centralized 12-filter engine with custom punishments, whitelist, and blacklist. Standalone commands provide 1-click toggles. | Preserved both. Standalone toggle commands directly update specific module switches in `config.automod` and save cleanly without overriding other rules. | Fully preserved for mobile/quick moderator workflows. |
| `/songs` vs standalone playback commands (`/play`, `/pause`, `/skip`, `/queue`, etc.) | Master Tree vs Standalone | `/songs` provides the complete structured menu (`24-7`, `playback`, `queue`, `audio`). Standalone commands (`/play`, `/skip`, `/stop`, `/queue`, etc.) provide standard music bot commands. | Preserved both. All music commands route to the unified `musicService` session manager. | Standard Rythm/Hydra user experience preserved. |
| `/welcome` vs `/setwelcome`, `/setrules`, `/setroles`, etc. | Master Suite vs Setup Shortcuts | `/welcome setup\|config\|test\|enable\|disable\|banner` manages welcome cards. `/setwelcome`, `/setbanner`, etc. are quick configuration shortcuts. | Preserved both. Both write to `config.welcome` with atomic persistence. | Zero breaking changes. |
| `/left` vs `/goodbye` vs `/setleave` | Standalone Variants | Both `/left` and `/goodbye` manage departure announcements. | Preserved both. `/goodbye` mirrors `/left` options and dispatches to identical configuration handlers. | Seamless migration. |
| `/inv` vs `/myinvites` vs `/invites` vs `/invitetop` | Group vs Shortcuts | `/inv check\|leaderboard\|me` provides grouped invite tracking; `/myinvites`, `/invites`, `/invitetop` provide instant single-word commands. | Preserved both with shared invite tracker and cache. | Zero breaking changes. |
| `/games` vs `/fun` vs `/points` | Group vs Shortcuts | `/games` groups minigames and points; `/fun` provides minigames (`coinflip`, `dice`, `8ball`, `rps`); `/points` provides economy. | Preserved both with shared RNG and economy service. | Zero breaking changes. |
| Missing Handlers / Unregistered Code | Obsolete aliases in dispatcher | `clearwarns`, `addword`, `removeword`, `welcomeconfig`, `clearqueue` existed in older dispatcher revisions. | Maintained internal fallback compatibility in dispatcher while keeping clean, canonical Discord registration under 100 global commands. | Zero breaking changes. |

---

## 3. Canonical 100 Application Commands Inventory

Strict canonical ordering enforced by Discord registration:

### Group 1: SECURITY & MODERATION (Commands 1–29)
1. `/security` — Server security engine, anti-nuke, anti-mod, lockdown and recovery (ManageGuild)
   - `status`: View current server security and protection status
   - `diagnostics`: View measured internal pipeline latency & telemetry
   - `incidents`: View recent security incident intercept history
   - `audit`: High-level permission hierarchy & health check
   - `test`: Dry-run security notification pipeline safely
   - `lockdown`: Restrict configured channels during a security emergency
   - `unlock`: Restore permissions changed by the lockdown system
   - Group `antinuke`: `status`, `configure`, `test`
   - Group `antimod`: `status`, `configure`, `test`
   - Group `antomod`: `status`, `configure`, `test` (alias)
   - Group `antiraid`: `status`, `configure`, `test`
   - Group `trust`: `add`, `remove`, `list`
   - Group `config`: `view`, `reset`
2. `/automod` — Manage AutoMod system, rules, and filters (ManageGuild)
   - `status`: View active AutoMod rules and their settings
   - `config`: Interactive AutoMod configuration dashboard
   - `enable`: Enable AutoMod engine or a specific filter rule
   - `disable`: Disable AutoMod engine or a specific filter rule
   - `enableall`: Enable all 12 detection rules at once
   - `disableall`: Disable all 12 detection rules at once
   - `whitelist`: Manage AutoMod exemptions for users, roles, or channels
   - `blacklist`: Manage word blacklist (add, remove, list)
   - `test`: Test AutoMod filter evaluation safely
   - `punishment`: Customize punishment action for AutoMod rules
3. `/warn` — Issue an official warning to a member (ModerateMembers)
4. `/warnings` — View active warnings for a member (ModerateMembers)
5. `/clearwarnings` — Clear all warnings for a member (ManageGuild)
6. `/timeout` — Timeout a member (e.g. 10m, 1h, 1d) (ModerateMembers)
7. `/untimeout` — Remove timeout from a member (ModerateMembers)
8. `/kick` — Kick a member from the server (KickMembers)
9. `/ban` — Ban a user from the server (BanMembers)
10. `/unban` — Unban a user by their User ID (BanMembers)
11. `/softban` — Ban and instantly unban to purge messages (BanMembers)
12. `/purge` — Bulk delete messages from the current channel (ManageMessages)
13. `/slowmode` — Set slowmode delay for a channel (ManageChannels)
14. `/lock` — Lock a channel to prevent member messages (ManageChannels)
15. `/unlock` — Unlock a previously locked channel (ManageChannels)
16. `/nick` — Change a member nickname (ManageNicknames)
17. `/modlogs` — View moderation history for a member (ModerateMembers)
18. `/antispam` — Toggle rapid message velocity spam filter (ManageGuild)
19. `/antilink` — Toggle external URL & link filter (ManageGuild)
20. `/antiraid` — Toggle join-flood raid filter (ManageGuild)
21. `/altdetection` — Toggle new / unverified account detection (ManageGuild)
22. `/wordfilter` — Toggle profanity and word blacklist filter (ManageGuild)
23. `/lockdown` — Quick toggle for server-wide emergency lockdown (ManageGuild)
24. `/whitelist` — Interactive whitelist management for security (ManageGuild)
25. `/threat` — Instantly switch server DEFCON threat level (ManageGuild)
26. `/quarantine` — View and manage quarantined members (ManageGuild)
27. `/quickmod` — Launch rapid one-click interactive moderation panel (ModerateMembers)
28. `/vpncheck` — Detect suspicious accounts, alts, and lookup hosting/VPN IPs (ModerateMembers)
29. `/raidmode` — Manual raid defense mode with rapid countermeasures (ManageGuild)

### Group 2: SONGS & MUSIC (Commands 30–49)
30. `/songs` — THOR APEX Music & 24/7 Voice System (Public)
    - Group `24-7`: `enable`, `disable`, `status`, `setup`
    - Group `playback`: `play`, `pause`, `resume`, `skip`, `stop`, `seek`, `previous`, `playnow`
    - Group `queue`: `list`, `clear`, `shuffle`, `remove`, `move`, `loop`
    - Group `audio`: `volume`, `radio`, `nowplaying`, `status`, `lyrics`
31. `/play` — Play a song from YouTube, Spotify, or SoundCloud (Public)
32. `/pause` — Pause music playback (Public)
33. `/resume` — Resume music playback (Public)
34. `/skip` — Skip current song (Public)
35. `/stop` — Stop playback and leave voice channel (Public)
36. `/queue` — Manage and view the music queue (view, remove, move, jump, export, clear) (Public)
37. `/nowplaying` — Show currently playing track with progress bar (Public)
38. `/radio` — Play 24/7 internet radio stream (Lofi, Gaming, Pop, Chill) (Public)
39. `/volume` — Adjust music volume (1–100) (Public)
40. `/loop` — Set repeat mode (off, track, queue) (Public)
41. `/shuffle` — Shuffle the music queue (Public)
42. `/previous` — Play the previous track in history (Public)
43. `/playnow` — Play a track immediately at the front of the queue (Public)
44. `/disconnect` — Leave the voice channel and release player resources (Public)
45. `/search` — Search supported sources for music tracks (Public)
46. `/seek` — Seek to a playback position in the current track (Public)
47. `/musicstatus` — Display real-time music engine, voice connection, and queue diagnostics (Public)
48. `/musicupdate` — Owner-only music auto-update and self-healing system (Administrator)
    - `status`, `check`, `logs`, `repair`, `apply`
49. `/lyrics` — Search real-time lyrics for the current song or any track (Public)

### Group 3: WELCOME (Commands 50–64)
50. `/welcome` — Manage high-conversion Welcome cards (setup, config, test, enable, disable, banner) (ManageGuild)
51. `/setup` — Auto-setup bot channels and configuration (Administrator)
52. `/setwelcome` — Set welcome announcement channel (ManageGuild)
53. `/setrules` — Set rules channel for welcome card (ManageGuild)
54. `/setroles` — Set self-roles channel for welcome card (ManageGuild)
55. `/setgeneral` — Set main chat channel for welcome card (ManageGuild)
56. `/setfun` — Set fun channel for welcome card (ManageGuild)
57. `/setedit` — Set editing channel for welcome card (ManageGuild)
58. `/setgaming` — Set gaming channel for welcome card (ManageGuild)
59. `/setwelcomecolor` — Set welcome embed color (hex e.g. #FF0000) (ManageGuild)
60. `/setwelcometext` — Customize welcome text fields (greeting, subtitle, outro) (ManageGuild)
61. `/setbanner` — Set or sync welcome banner image (upload file, paste URL, or use server banner) (ManageGuild)
62. `/setlogo` — Set or sync welcome card logo/icon (upload file, paste URL, or use server icon) (ManageGuild)
63. `/serverbanner` — Display server banner and optionally apply it to welcome card (Public)
64. `/setautorole` — Set auto-role assigned upon joining (ManageGuild)

### Group 4: LEAVE & GOODBYE (Commands 65–69)
65. `/left` — Manage Member Leave and Goodbye Announcements (setup, config, test, enable, disable, message) (ManageGuild)
66. `/goodbye` — Manage departure and leave messages (setup, config, test, enable, disable) (ManageGuild)
67. `/setleave` — Set leave/goodbye channel (ManageGuild)
68. `/setleavetext` — Customize leave message (ManageGuild)
69. `/logs` — Configure 15 dedicated log channels under SERVER LOGS category (setup, status, configure, test, disable) (ManageGuild)

### Group 5: INVITES (Commands 70–73)
70. `/inv` — Server Invite Tracking and Leaderboards (check, leaderboard, me) (Public)
71. `/myinvites` — Check your total server invites (Public)
72. `/invites` — Check server invites for a user (Public)
73. `/invitetop` — Top inviters leaderboard (Public)

### Group 6: GAMES & ECONOMY (Commands 74–76)
74. `/games` — Interactive games, fun, and economy points (coinflip, dice, 8ball, rps, points, leaderboard) (Public)
75. `/fun` — Fun minigames and entertainment pack (coinflip, dice, 8ball, rps) (Public)
76. `/points` — Server points and economy system (check, give, take, leaderboard, reset) (Public)

### Group 7: GENERAL UTILITIES & ADMINISTRATION (Commands 77–100)
77. `/ping` — Check bot heartbeat latency and gateway ping (Public)
78. `/uptime` — Check bot continuous running time and process health (Public)
79. `/botinfo` — View bot statistics, node runtime, memory, and architecture (Public)
80. `/serverinfo` — View server statistics, security level, and member counts (Public)
81. `/userinfo` — View member profile, roles, creation date, and join position (Public)
82. `/permissions` — Inspect bot and member permissions in the current channel (Public)
83. `/help` — Display comprehensive guide to all bot commands with category dropdown (Public)
84. `/performance` — View bot execution performance, event loop delay, and command latency percentiles (Administrator)
85. `/panel` — Open the THOR APEX interactive admin control centre (ManageGuild)
86. `/translate` — Translate text into another language (Public)
87. `/appeal` — Unban and punishment appeal system (submit, status, review, setup) (Public / ManageGuild)
88. `/serverstat` — Configure server voice stat channels (setup, update, disable) (ManageGuild)
89. `/afk` — Set or check your AFK status (set, clear, status) (Public)
90. `/badge` — Manage custom member recognition badges (give, remove, list) (ManageGuild / Public)
91. `/dm` — Staff direct message dispatcher (user, role) (ManageGuild)
92. `/nightmode` — Scheduled server quiet hours (setup, toggle, status) (ManageGuild)
93. `/devmode` — Bot performance diagnostics and health monitoring (stats, diagnostics, simulate) (Administrator)
94. `/serverconfig` — Master server configuration overview and management (view, export, reset) (ManageGuild)
95. `/birthday` — Member birthday tracker and celebration (set, check, upcoming, channel) (Public / ManageGuild)
96. `/maintenance` — Toggle server bot maintenance mode (enable, disable, status) (Administrator)
97. `/clone` — Export or import configuration template between servers (export, import) (ManageGuild)
98. `/module` — Toggle server bot feature modules on or off (enable, disable, list) (ManageGuild)
99. `/roleplay` — Expressive roleplay and anime action interactions (hug, pat, slap, highfive, wave) (Public)
100. `/integration` — Connect YouTube, Twitch, and GitHub alerts (no extra text channels created) (ManageGuild)

---

## 4. Verification & Audit Evidence

1. **Registry & Dispatcher Sync:** Verified programmatically by `test/auditAndIntegrity.test.js` (`AUDIT-1`, `AUDIT-2`).
2. **Discord v10 Payload Validation:** Ran `validateCommandPayload(payload)` with **0 errors**.
3. **No Duplicate Execution:** Exactly one command handler receives each chat input command.

---

## 5. Live Discord UI Duplicate Commands Audit & Resolution (Global vs Guild Scope)

### A. Symptom Observed in Discord Client
In Discord's slash command picker (`/`), every command appeared twice for bot **The Real Apex** (e.g. `/afk clear`, `/afk set`, `/afk status`, `/altdetection`).

### B. Root Cause
In past deployment runs (specifically via `--sync-guilds` in `deploy.js`), the deployment script registered all 100 application commands to **each connected guild** (`Routes.applicationGuildCommands(user.id, guild.id)`) while also deploying them **globally** (`Routes.applicationCommands(user.id)`).

When Discord's client renders the slash command menu for a user in a guild, it displays:
1. All **Global** commands registered by the application (100 commands).
2. All **Guild-Specific** commands registered by the application in that server (100 commands).

Because both payloads were identical, Discord merged both sets into the UI, causing every single command to display twice.

### C. Live REST API Audit: Before vs After Counts

| Registration Scope / Guild | Target ID | Before Fix Command Count | After Fix Command Count | Status |
|---|---|---|---|---|
| **Global Application Commands** | Application `1554626865958887444` | **100** | **100** | ✅ Preserved (Canonical) |
| Guild: `✦ ʀᴀɪ ʀᴀᴍ ✦` | `1457382179981099090` | **100** | **0** | ✅ Purged Redundant Copy |
| Guild: `THOR APEX ⚡` | `1525030316845301781` | **100** | **0** | ✅ Purged Redundant Copy |
| Guild: `MAXXZ FAM 🤍` | `1544007754035765310` | **100** | **0** | ✅ Purged Redundant Copy |
| Guild: `THOR EDITZZ PVT SERVER` | `1558179055646281749` | **100** | **0** | ✅ Purged Redundant Copy |
| **Total In Discord REST API** | — | **500** | **100** | ✅ **Exactly 1 copy per command** |

### D. Permanent Architectural Safeguards
1. **`deploy.js` Enforced Global Scope:** Removed multi-guild push. Added automatic scanning of all connected guilds on every run of `deploy.js` to ensure any accidental guild-scoped commands are purged (`body: []`).
2. **`index.js` Startup Safeguard:** During `client.once('ready')`, the bot automatically purges any guild-scoped commands across all connected servers in `client.guilds.cache.values()`.
3. **Automated Regression Suite:** Added `AUDIT-6` through `AUDIT-9` in `test/auditAndIntegrity.test.js` validating duplicate protection, canonical global scope, idempotent payloads, and single-handler execution.
