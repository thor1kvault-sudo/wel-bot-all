# 📖 THOR APEX — COMPLETE COMMANDS EXPLANATION GUIDE
**Version:** 2.0.0 Production  
**Runtime:** Node.js, Discord.js v14  
**Target Platform:** Render Hosted Production Discord Bot  

This guide provides a comprehensive, plain-English explanation for every single slash command supported by THOR APEX. For each command, you will find its exact syntax, purpose, parameters, required permissions, server-state effect, and a safe usage example.

---

## Table of Contents
1. [Security & Anti-Nuke](#1-security--anti-nuke)
2. [Moderation](#2-moderation)
3. [AutoMod](#3-automod)
4. [Songs & Music (including 24/7 Voice)](#4-songs--music)
5. [Welcome Cards](#5-welcome-cards)
6. [Leave & Goodbye Announcements](#6-leave--goodbye-announcements)
7. [Server Logs (15 Channels)](#7-server-logs)
8. [Invites & Leaderboards](#8-invites--leaderboards)
9. [Games & Economy](#9-games--economy)
10. [Utilities, Information & System Performance](#10-utilities--information)
11. [Administration & Advanced Features](#11-administration--advanced-features)

---

## 1. Security & Anti-Nuke

### `/security status`
* **Purpose:** View overall security protection posture, active threat thresholds, and recent intercepts.
* **Permissions:** `Manage Guild`
* **Effect:** Informational (Read-only, no server changes).
* **Options:** None.
* **Example:** `/security status`

### `/security lockdown`
* **Purpose:** Immediately restrict `@everyone` send and connect permissions across public channels during an emergency attack, while strictly preserving private/staff channels and saving baseline overwrites for atomic recovery.
* **Permissions:** `Administrator` or `Manage Guild`
* **Effect:** State-changing (Secures public text & voice channels).
* **Options:** None.
* **Example:** `/security lockdown`

### `/security unlock`
* **Purpose:** Lifts emergency lockdown and restores original channel permissions exactly as saved prior to lockdown. Automatically handles partial channel restoration and allows retrying failed channels.
* **Permissions:** `Administrator` or `Manage Guild`
* **Effect:** State-changing (Restores original channel permissions).
* **Options:** None.
* **Example:** `/security unlock`

### `/security webhooks`
* **Purpose:** Audit all webhooks across the entire server to detect unauthorized, orphan, or malicious webhooks created during account hijacks. Features an interactive 1-click **`[Delete All Rogue Webhooks]`** button (Zero Extra Channels created).
* **Permissions:** `Manage Webhooks` or `Manage Guild`
* **Effect:** Informational with optional 1-click cleanup.
* **Options:** None.
* **Example:** `/security webhooks`

### `/security posture`
* **Purpose:** Dynamic 8-factor security health assessment giving the server a safety rating from **0 to 100** and a letter grade (A+ to F). Evaluates 2FA, verification levels, media filters, bot hierarchy, and provides a **`[1-Click Quick Harden]`** button.
* **Permissions:** `Manage Guild`
* **Effect:** Informational with optional 1-click hardening.
* **Options:** None.
* **Example:** `/security posture`

### `/security panic`
* **Purpose:** High-emergency panic switch. Immediately quarantines dangerous permissions (`Administrator`, `ManageRoles`, `ManageChannels`, `BanMembers`) from all roles situated below the bot to instantly halt an active rogue admin raid. Saves full snapshots and provides a 1-click **`[Deactivate & Restore Roles]`** button.
* **Permissions:** `Administrator`
* **Effect:** High-urgency containment (Temporary role permission quarantine).
* **Options:** `action` (`activate`, `lift`, `status`).
* **Example:** `/security panic action:activate`

### `/security diagnostics`
* **Purpose:** Displays internal event pipeline latency metrics (p50, p95, p99 measured via `process.hrtime.bigint()`), WebSocket heartbeat, memory footprint, and bot permission posture.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security diagnostics`

### `/security incidents`
* **Purpose:** Displays a chronological log of recent intercepted security breaches, rogue moderator velocity trips, and containment actions taken.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security incidents`

### `/security audit`
* **Purpose:** Performs a high-level permission hierarchy and audit log integrity check, verifying that the bot holds necessary permissions.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security audit`

### `/security test`
* **Purpose:** Dry-run test of the security event pipeline and alert dispatch paths without making any destructive changes.
* **Permissions:** `Manage Guild`
* **Effect:** Informational / Simulation.
* **Options:** None.
* **Example:** `/security test`

### `/security antinuke status`
* **Purpose:** View Anti-Nuke protection status, limits, and active thresholds.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security antinuke status`

### `/security antinuke configure`
* **Purpose:** Configures Anti-Nuke burst limits, response actions (`strip_and_ban`, `strip_roles`, `ban`, `kick`, `quarantine`, `alert`), and time windows.
* **Permissions:** `Administrator`
* **Effect:** State-changing (Updates guild security configuration).
* **Options:** `toggle`, `action`, `channel_delete_limit`, `channel_create_limit`, `role_delete_limit`, `role_create_limit`, `ban_limit`, `kick_limit`, `window_seconds`.
* **Example:** `/security antinuke configure toggle:Enable action:Strip Roles & Instant Ban ban_limit:3 window_seconds:15`

### `/security antinuke test`
* **Purpose:** Simulates an Anti-Nuke burst detection scenario to verify that the monitoring pipeline is functioning correctly.
* **Permissions:** `Manage Guild`
* **Effect:** Simulation.
* **Options:** None.
* **Example:** `/security antinuke test`

### `/security antimod status`
* **Purpose:** Displays Anti-Moderator abuse protection status and staff velocity limits.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security antimod status`

### `/security antimod configure`
* **Purpose:** Configures dual-window velocity thresholds (burst + extended) for staff timeouts, kicks, bans, and role assignments.
* **Permissions:** `Administrator`
* **Effect:** State-changing.
* **Options:** `toggle`, `action`, `ban_limit`, `kick_limit`, `timeout_limit`, `role_limit`, `window_seconds`.
* **Example:** `/security antimod configure toggle:Enable action:Strip Roles & Quarantine timeout_limit:5 window_seconds:30`

### `/security antimod test`
* **Purpose:** Simulates a moderator action burst check to verify velocity containment evaluation.
* **Permissions:** `Manage Guild`
* **Effect:** Simulation.
* **Options:** None.
* **Example:** `/security antimod test`

### `/security antiraid status`
* **Purpose:** Displays anti-raid join velocity thresholds, account age risk filters, and current quarantine count.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Options:** None.
* **Example:** `/security antiraid status`

### `/security antiraid configure`
* **Purpose:** Configures mass join thresholds and containment mode (`quarantine` or `kick`).
* **Permissions:** `Administrator`
* **Effect:** State-changing.
* **Options:** `toggle`, `action`, `join_threshold`, `window_seconds`.
* **Example:** `/security antiraid configure toggle:Enable action:Quarantine Only join_threshold:6 window_seconds:10`

### `/security antiraid test`
* **Purpose:** Simulates a raid join wave and tests multi-factor join risk scoring safely.
* **Permissions:** `Manage Guild`
* **Effect:** Simulation.
* **Options:** None.
* **Example:** `/security antiraid test`

### `/security trust add` | `/security trust remove` | `/security trust list`
* **Purpose:** Manage trusted users and roles exempt from Anti-Nuke velocity tracking and automatic containment.
* **Permissions:** `Administrator`
* **Effect:** State-changing.
* **Options:** `user`, `role`.
* **Example:** `/security trust add role:@SeniorMods`

### `/security config view` | `/security config reset`
* **Purpose:** View complete active security configuration or restore safe factory defaults.
* **Permissions:** `Administrator`
* **Effect:** Informational (`view`) / State-changing (`reset`).
* **Options:** None.
* **Example:** `/security config view`

### `/lockdown`
* **Purpose:** Quick shortcut toggle to engage or lift server-wide emergency lockdown.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `toggle` (`on` or `off`).
* **Example:** `/lockdown toggle:on`

### `/whitelist`
* **Purpose:** Quick interactive shortcut to manage security trusted users and roles.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `action` (`add`, `remove`, `list`), `user`, `role`.
* **Example:** `/whitelist action:add user:@CoOwner`

### `/threat`
* **Purpose:** Instantly switch server DEFCON threat level (1: Raid Underway, 2: High Alert, 3: Normal).
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `level` (`1`, `2`, `3`).
* **Example:** `/threat level:2`

### `/quarantine`
* **Purpose:** Manage quarantined members isolated during join raids (view count or mass release).
* **Permissions:** `Manage Guild`
* **Effect:** State-changing / Informational.
* **Options:** `action` (`status`, `release`).
* **Example:** `/quarantine action:status`

### `/raidmode`
* **Purpose:** Rapid manual raid defense mode that enables channel slowmode and activates join shielding.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `action` (`on`, `off`, `status`).
* **Example:** `/raidmode action:on`

### `/vpncheck`
* **Purpose:** Analyzes a member account for risk indicators (age, avatar, flags) or checks an IP address for VPN, proxy, or hosting flags.
* **Permissions:** `Moderate Members`
* **Effect:** Informational.
* **Options:** `target` (`user` or `ip`), `user`, `ip`.
* **Example:** `/vpncheck target:user user:@SuspiciousUser`

---

## 2. Moderation

* **`/warn user:@Member [reason:<text>]`** — Issues an official warning strike to a member. (*Moderate Members*)
* **`/warnings user:@Member`** — Displays warning history and strike count for a member. (*Moderate Members*)
* **`/clearwarnings user:@Member`** — Clears all recorded warnings for a member. (*Manage Guild*)
* **`/timeout user:@Member duration:<time> [reason:<text>]`** — Applies Discord communication timeout (e.g. `10m`, `1h`, `1d`). (*Moderate Members*)
* **`/untimeout user:@Member`** — Removes active timeout from a member. (*Moderate Members*)
* **`/kick user:@Member [reason:<text>]`** — Kicks member from the guild (checks role hierarchy). (*Kick Members*)
* **`/ban user:@Member [delete_days:<0-7>] [reason:<text>]`** — Bans a user and purges recent messages. (*Ban Members*)
* **`/unban userid:<id> [reason:<text>]`** — Unbans a user by their Discord User ID. (*Ban Members*)
* **`/softban user:@Member [reason:<text>]`** — Bans and immediately unbans to purge member messages without permanent exclusion. (*Ban Members*)
* **`/purge amount:<1-100> [filter:<all|bots|links>]`** — Bulk deletes messages from the current channel. (*Manage Messages*)
* **`/slowmode seconds:<0-21600> [channel:#channel]`** — Sets message cooldown timer for a channel. (*Manage Channels*)
* **`/lock [channel:#channel] [reason:<text>]`** — Locks a single text channel preventing member messages. (*Manage Channels*)
* **`/unlock [channel:#channel]`** — Unlocks a previously locked text channel. (*Manage Channels*)
* **`/nick user:@Member [nickname:<text>]`** — Changes or resets member server nickname. (*Manage Nicknames*)
* **`/modlogs user:@Member`** — Displays complete moderation history for a member. (*Moderate Members*)
* **`/quickmod user:@Member`** — Launches rapid interactive button panel with 1-click Warn, 10m Timeout, 1h Timeout, Kick, and Ban actions. (*Moderate Members*)

---

## 3. AutoMod

### `/automod status`
* **Purpose:** View current active status and configuration of all 12 AutoMod detection rules.
* **Permissions:** `Manage Guild`
* **Effect:** Informational.
* **Example:** `/automod status`

### `/automod config`
* **Purpose:** Interactive dashboard to configure spam, mention, caps, link, and blacklist rules.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing / Dashboard.
* **Example:** `/automod config`

### `/automod enable [rule:<rule>]` | `/automod disable [rule:<rule>]`
* **Purpose:** Enable or disable the entire AutoMod engine or a specific detection rule.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `rule` (`all`, `antiSpam`, `antiDuplicate`, `antiMentionSpam`, `antiEveryone`, `antiInvites`, `antiLinks`, `antiNsfwLinks`, `wordFilter`, `antiCaps`, `antiEmojiSpam`, `altDetection`, `antiRaid`).
* **Example:** `/automod enable rule:antiInvites`

### `/automod enableall` | `/automod disableall`
* **Purpose:** Bulk-enables or bulk-disables all 12 AutoMod detection rules at once.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Example:** `/automod enableall`

### `/automod whitelist action:add|remove|list`
* **Purpose:** Manages AutoMod exemptions for trusted users, moderator roles, or dedicated bot/media channels.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `action`, `user`, `role`, `channel`.
* **Example:** `/automod whitelist action:add role:@Moderator`

### `/automod blacklist action:add|remove|list [word:<word>]`
* **Purpose:** Manages custom blacklisted keywords and profanity.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `action`, `word`.
* **Example:** `/automod blacklist action:add word:scamlink`

### `/automod punishment rule:<rule> action:<action> [timeout_duration:<duration>]`
* **Purpose:** Customizes penalty action (delete, warn, timeout, kick, ban, log) per detection rule.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Options:** `rule`, `action`, `timeout_duration`.
* **Example:** `/automod punishment rule:antiInvites action:Delete + Timeout User timeout_duration:10m`

### `/automod test`
* **Purpose:** Runs a safe diagnostic and simulation suite validating regex patterns, permissions, and rule readiness without punishing users.
* **Permissions:** `Manage Guild`
* **Effect:** Simulation.
* **Example:** `/automod test`

### Standalone AutoMod Shortcuts
* **`/antispam toggle:on|off`** — Quick toggle for message velocity spam filter. (*Manage Guild*)
* **`/antilink toggle:on|off`** — Quick toggle for external link and advertisement filter. (*Manage Guild*)
* **`/antiraid toggle:on|off`** — Quick toggle for join-flood raid suppression. (*Manage Guild*)
* **`/altdetection toggle:on|off [mindays:<days>]`** — Quick toggle for new account detection. (*Manage Guild*)
* **`/wordfilter toggle:on|off`** — Quick toggle for word blacklist filter. (*Manage Guild*)

---

## 4. Songs & Music

### `/songs 24-7 enable [channel:#channel]`
* **Purpose:** Enables 24/7 voice presence. The bot remains connected in the specified voice channel indefinitely on silent standby when the queue is empty.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing (Voice connection maintained).
* **Example:** `/songs 24-7 enable channel:#music-lounge`

### `/songs 24-7 disable`
* **Purpose:** Disables 24/7 voice presence, returning the bot to normal idle disconnect behavior when music stops.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Example:** `/songs 24-7 disable`

### `/songs 24-7 status`
* **Purpose:** Displays 24/7 connection health, current voice channel, reconnect attempts, and player state.
* **Permissions:** `Public`
* **Effect:** Informational.
* **Example:** `/songs 24-7 status`

### `/songs 24-7 setup channel:#channel`
* **Purpose:** Configures the designated 24/7 voice channel without immediately playing random tracks.
* **Permissions:** `Manage Guild`
* **Effect:** State-changing.
* **Example:** `/songs 24-7 setup channel:#radio-247`

### Standalone Playback Commands
* **`/play song:<query or url>`** — Streams audio from YouTube, Spotify, or SoundCloud. Supports interactive player card with Rythm-style buttons. (*Public*)
* **`/playnow song:<query or url>`** — Enqueues track at the top of the queue or streams immediately. (*Public*)
* **`/pause`** — Pauses active audio playback. (*Public*)
* **`/resume`** — Resumes paused playback. (*Public*)
* **`/skip`** — Skips current track. (*Public*)
* **`/previous`** — Replays the previously played song from session history. (*Public*)
* **`/stop`** — Stops playback, clears queue, and leaves channel (or stays on standby if 24/7 enabled). (*Public*)
* **`/disconnect`** — Forces bot disconnect from voice channel and destroys session. (*Public*)
* **`/queue [action:<view|clear|shuffle|remove|move|jump|export>]`** — Full queue management suite. (*Public*)
* **`/nowplaying`** — Displays currently playing track with interactive duration progress bar. (*Public*)
* **`/radio genre:<lofi|gaming|pop|chill>`** — Streams 24/7 internet radio stream. (*Public*)
* **`/volume level:<1-100>`** — Adjusts player volume. (*Public*)
* **`/loop mode:<off|track|queue>`** — Configures song or queue repeat mode. (*Public*)
* **`/shuffle`** — Shuffles current queued tracks in place. (*Public*)
* **`/search query:<text>`** — Searches audio platforms and displays selectable top tracks. (*Public*)
* **`/seek time:<timestamp>`** — Seeks audio playback position (e.g. `1:30` or `90s`). (*Public*)
* **`/lyrics [song:<query>]`** — Fetches real-time song lyrics. (*Public*)
* **`/musicstatus`** — Displays real-time voice connection latency, active sessions, and audio engine metrics. (*Public*)
* **`/musicupdate status|check|logs|repair|apply`** — Owner-only self-healing audio subsystem diagnostics and dependency repair. (*Administrator*)

---

## 5. Welcome Cards

* **`/welcome setup channel:#channel`** — Configures the welcome announcement channel. (*Manage Guild*)
* **`/welcome config`** — Displays current welcome card layout, embed color, and channel bindings. (*Manage Guild*)
* **`/welcome test`** — Sends preview welcome card to verify canvas rendering and channel permissions. (*Manage Guild*)
* **`/welcome enable` | `/welcome disable`** — Toggles automated welcome messages on or off. (*Manage Guild*)
* **`/welcome banner [image:<file>] [url:<link>]`** — Sets custom welcome card banner image. (*Manage Guild*)
* **`/setwelcome channel:#channel`** — Shortcut to set welcome channel. (*Manage Guild*)
* **`/setrules channel:#channel`** — Sets rules channel button on welcome card. (*Manage Guild*)
* **`/setroles channel:#channel`** — Sets self-roles channel button on welcome card. (*Manage Guild*)
* **`/setgeneral channel:#channel`** — Sets main chat channel button on welcome card. (*Manage Guild*)
* **`/setwelcomecolor color:<#hex>`** — Customizes welcome card embed highlight color. (*Manage Guild*)
* **`/setwelcometext greeting:<text> [subtitle:<text>] [outro:<text>]`** — Customizes welcome message text templates. (*Manage Guild*)
* **`/setbanner`** | **`/setlogo`** — Sets card banner and logo via file upload or URL. (*Manage Guild*)
* **`/serverbanner [apply_welcome:true|false]`** — Displays guild server banner and optionally applies it as welcome banner. (*Public*)
* **`/setautorole role:@Role`** — Configures auto-role automatically assigned to members upon join. (*Manage Guild*)

---

## 6. Leave & Goodbye Announcements

* **`/left setup channel:#channel`** — Sets channel for member departure announcements. (*Manage Guild*)
* **`/left config`** — Views current leave card settings. (*Manage Guild*)
* **`/left test`** — Tests leave message dispatch. (*Manage Guild*)
* **`/left enable` | `/left disable`** — Toggles departure messages on or off. (*Manage Guild*)
* **`/left message text:<template>`** — Customizes goodbye text with `{user}`, `{tag}`, and `{membercount}` placeholders. (*Manage Guild*)
* **`/goodbye setup|config|test|enable|disable`** — Canonical departure management commands. (*Manage Guild*)
* **`/setleave channel:#channel`** — Shortcut to bind leave channel. (*Manage Guild*)
* **`/setleavetext message:<template>`** — Shortcut to set leave announcement text. (*Manage Guild*)

---

## 7. Server Logs

* **`/logs setup`** — One-click automated setup: creates `SERVER LOGS` category and 15 dedicated channels (`#member-logs`, `#message-logs`, `#moderation-logs`, `#security-logs`, `#antinuke-logs`, `#automod-logs`, `#role-logs`, `#channel-logs`, `#voice-logs`, `#server-logs`, `#invite-logs`, `#webhook-logs`, `#bot-logs`, `#welcome-logs`, `#leave-logs`). (*Manage Guild*)
* **`/logs status`** — Displays active channel destinations for all 15 logging categories. (*Manage Guild*)
* **`/logs configure category:<cat> channel:#channel`** — Binds a specific logging category to any chosen channel. (*Manage Guild*)
* **`/logs test`** — Sends verification test embeds to all configured logging channels. (*Manage Guild*)
* **`/logs disable category:<cat>`** — Disables logging for a specific category. (*Manage Guild*)

---

## 8. Invites & Leaderboards

* **`/inv check [user:@Member]`** — Checks invite statistics (total, real, leaves, fake) for a user. (*Public*)
* **`/inv leaderboard`** — Displays top inviters leaderboard. (*Public*)
* **`/inv me`** — Displays your own invite statistics. (*Public*)
* **`/myinvites`** — Shortcut to check personal invite counts. (*Public*)
* **`/invites [user:@Member]`** — Shortcut to check invites for a user. (*Public*)
* **`/invitetop`** — Shortcut to view server top inviters leaderboard. (*Public*)

---

## 9. Games & Economy

* **`/games coinflip`** | **`/fun coinflip`** — Flips a fair coin (Heads or Tails). (*Public*)
* **`/games dice [sides:<number>]`** | **`/fun dice`** — Rolls dice with customizable sides (default 6). (*Public*)
* **`/games 8ball question:<text>`** | **`/fun 8ball`** — Consults the Magic 8-Ball. (*Public*)
* **`/games rps choice:<rock|paper|scissors>`** | **`/fun rps`** — Plays Rock, Paper, Scissors with points rewards. (*Public*)
* **`/points check [user:@Member]`** — Checks current server economy points balance. (*Public*)
* **`/points give user:@Member amount:<pts>`** — Awards points to a member. (*Manage Guild*)
* **`/points take user:@Member amount:<pts>`** — Deducts points from a member. (*Manage Guild*)
* **`/points leaderboard`** — Displays top 10 members with highest economy points. (*Public*)
* **`/points reset [target:user|all] [user:@Member]`** — Resets economy points. (*Administrator*)
* **`/badge give user:@Member badge:<badge>`** — Awards custom achievement badges. (*Manage Guild*)
* **`/badge remove user:@Member badge:<badge>`** — Removes an achievement badge. (*Manage Guild*)
* **`/badge list [user:@Member]`** — Displays earned achievement badges. (*Public*)
* **`/roleplay action:<hug|pat|slap|highfive|wave> user:@Member`** — Expressive anime-style action interactions. (*Public*)

---

## 10. Utilities & Information

* **`/ping`** — Displays WebSocket heartbeat ping, REST round-trip, and process status. (*Public*)
* **`/uptime`** — Displays continuous bot running time and node process metrics. (*Public*)
* **`/botinfo`** — Displays detailed bot version, memory, architecture, and server count. (*Public*)
* **`/serverinfo`** — Displays server statistics, verification level, channel breakdown, and member counts. (*Public*)
* **`/userinfo [user:@Member]`** — Displays profile details, badges, creation date, join position, and roles. (*Public*)
* **`/permissions [user:@Member]`** — Evaluates active bot and member permissions in the channel. (*Public*)
* **`/help [category:<cat>]`** — Interactive command center with category select dropdown. (*Public*)
* **`/performance`** — Displays server owner & admin execution telemetry, CPU latency percentiles (p50, p95, p99), event loop delay, and slowest command diagnostics. (*Administrator*)
* **`/panel`** — Opens interactive THOR APEX administration dashboard with buttons for AutoMod, Anti-Nuke, Lockdown, and DEFCON. (*Manage Guild*)
* **`/translate text:<text> to:<lang> [from:<lang>]`** — Translates text into target language. (*Public*)

---

## 11. Administration & Advanced Features

* **`/setup`** — Complete auto-setup wizard configuring log channels, welcome categories, and server roles. (*Administrator*)
* **`/serverconfig view|export|reset`** — Master configuration dashboard to view settings, export JSON, or reset modules. (*Manage Guild*)
* **`/module enable|disable|list`** — Enables or disables feature modules (music, welcome, logs, games, etc.). (*Manage Guild*)
* **`/maintenance enable|disable|status`** — Toggles bot maintenance mode. (*Administrator*)
* **`/nightmode setup|toggle|status`** — Configures automated quiet hours with optional channel restrictions. (*Manage Guild*)
* **`/devmode stats|diagnostics|simulate`** — Bot performance diagnostics and event pipeline simulations. (*Administrator*)
* **`/clone export|import`** — Exports or imports server configuration templates between servers. (*Manage Guild*)
* **`/dm user:@Member [role:@Role] message:<text>`** — Dispatches official staff notifications via direct message. (*Manage Guild*)
* **`/appeal submit|status|review|setup`** — Punishment appeal system allowing users to request unbans or punishment reviews. (*Public / Manage Guild*)
* **`/serverstat setup|update|disable`** — Sets up voice stat counter channels (Member count, Bot count, Boost count). (*Manage Guild*)
* **`/afk set|clear|status`** — Sets AFK status and auto-replies when mentioned. (*Public*)
* **`/birthday set|check|upcoming|channel`** — Member birthday tracker and celebration announcement system. (*Public / Manage Guild*)
* **`/integration youtube|twitch|github|list|remove`** — Connects external feeds to designated channels without creating clutter. (*Manage Guild*)
