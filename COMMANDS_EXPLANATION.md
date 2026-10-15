# 🛡️ THOR APEX — DISCORD SECURITY, MUSIC, WELCOME & MANAGEMENT BOT
## Canonical Command Guide & Feature Documentation

THOR APEX is organized into **Seven Core Command Groups**, registered in strict canonical order, validated against Discord API v10 constraints:

1. **SECURITY**
2. **SONGS**
3. **WELCOME**
4. **LEFT**
5. **LOGS**
6. **INV**
7. **GAMES**
*(Followed by General Utilities)*

---

## 🛡️ 1. SECURITY (30 Commands)

### Canonical `/security` Command Suite
* **`/security status`** — Displays real-time security protection overview, active engine status, and thread health.
* **`/security config view|reset`** — View or restore factory defaults for security configurations.
* **`/security trust add|remove|list`** — Manage trusted users and roles exempt from anti-nuke and rate-limiting enforcement.
* **`/security lockdown [channels:all|public|current] [reason:<text>]`** — Thread-safe server lockdown. Restricts `@everyone` permissions while preserving original overwrites and keeping private channels, staff channels, and server logs hidden.
* **`/security unlock [restore_all:true|false]`** — Reverses lockdown and restores captured baseline overwrites.
* **`/security diagnostics`** — Displays high-resolution monotonic latency percentiles (p50, p95, p99), audit log latency, and active timers.
* **`/security antinuke status|configure|test`** — Sub-millisecond Anti-Nuke burst protection across channels, roles, webhooks, bans, and bots.
* **`/security antimod status|configure|test`** — Multi-window Anti-Mod abuse detection detecting rogue moderators performing high-velocity actions.
* **`/security antiraid status|configure|test`** — Multi-factor join risk scoring (account age, default avatar, suspicious patterns) with auto-quarantine.
* **`/security incidents`** — View recent security incident log, detection time, and containment latency.
* **`/security audit`** — High-level permission hierarchy and audit log integrity check.
* **`/security test`** — Dry-run security notification pipeline without mutating guild state.

### Standalone Security & Moderation Commands
* **`/automod enable|disable|status|config|whitelist|blacklist|test`** — Rule-based automated filtering (spam, links, caps, invites, mentions).
* **`/warn user:@User reason:<text>`** — Issues an official recorded warning.
* **`/warnings user:@User`** — Displays warning history for a member.
* **`/clearwarnings user:@User`** — Clears all warnings for a member.
* **`/timeout user:@User duration:<e.g. 10m, 1h, 1d> [reason:<text>]`** — Discord native communication timeout.
* **`/untimeout user:@User`** — Removes timeout from a member.
* **`/kick user:@User [reason:<text>]`** — Kicks member (enforces role hierarchy).
* **`/ban user:@User [delete_days:<0-7>] [reason:<text>]`** — Bans user from the server.
* **`/unban userid:<id> [reason:<text>]`** — Unbans a user by their User ID.
* **`/softban user:@User [reason:<text>]`** — Bans and instantly unbans to purge recent messages.
* **`/purge amount:<1-100> [filter:all|bot|links]`** — Bulk deletes messages from the channel.
* **`/slowmode seconds:<0-21600> [channel:#channel]`** — Sets channel slowmode delay.
* **`/lock [channel:#channel] [reason:<text>]`** — Locks single channel.
* **`/unlock [channel:#channel]`** — Unlocks single channel.
* **`/nick user:@User [nickname:<name>]`** — Updates or resets member nickname.
* **`/modlogs user:@User`** — Views complete moderation strike history.
* **`/antispam enable|disable|status|threshold`** — Fast message velocity spam detection.
* **`/antilink enable|disable|status|whitelist`** — Unauthorized URL and invite link filter.
* **`/antiraid enable|disable|status|threshold`** — Fast join velocity and raid suppression.
* **`/altdetection enable|disable|status|threshold`** — Detects suspicious new or unverified accounts.
* **`/wordfilter add|remove|list|clear`** — Explicit blacklisted word filtering.
* **`/lockdown`** — Direct shortcut for server-wide emergency lockdown.
* **`/whitelist add|remove|list`** — Direct shortcut for security exemptions.
* **`/threat level|status|threshold`** — Real-time threat assessment score.
* **`/quarantine user:@User reason:<text> [duration:<minutes>]`** — Strips roles and isolates member into quarantine.
* **`/quickmod user:@User`** — Interactive 1-click moderation panel with Warn, Timeout, Kick, and Ban buttons.
* **`/vpncheck user:@User`** — Checks account risk heuristics and proxy indicators.
* **`/raidmode on|off|status`** — Rapid mass channel slowmode lockdown.

---

## 🎵 2. SONGS (20 Commands)

### Canonical `/songs` Command Tree
* **`/songs 24-7 enable [channel:#channel]`** — Enables 24/7 persistent voice presence. Bot stays in the voice channel on silent standby when queue is empty.
* **`/songs 24-7 disable`** — Disables 24/7 mode, restoring normal voice idle timeout disconnect.
* **`/songs 24-7 status`** — Displays 24/7 configuration, voice channel, reconnect attempts, and connection health.
* **`/songs 24-7 setup channel:#channel`** — Configures designated 24/7 voice channel without starting random playback.
* **`/songs playback play|pause|resume|skip|stop|seek|previous|playnow`** — Full playback control tree.
* **`/songs queue list|clear|shuffle|remove|move|loop`** — Full queue management tree.
* **`/songs audio volume|radio|nowplaying|status|lyrics`** — Audio status, lyrics, radio, and volume.

### Standalone Music Shortcuts
* **`/play song:<query or url>`** — Plays YouTube, Spotify (track, album, playlist metadata matching), or SoundCloud audio.
* **`/playnow song:<query or url>`** — Enqueues track at the top of the queue or interrupts for immediate playback.
* **`/pause`** — Pauses active playback.
* **`/resume`** — Resumes paused playback.
* **`/skip`** — Skips to the next track.
* **`/previous`** — Replays previously played track from session history.
* **`/stop`** — Clears queue, stops playback, and leaves voice (or remains if 24/7 active).
* **`/queue [page:<number>]`** — Displays paginated music queue.
* **`/nowplaying`** — Shows track progress bar, requester, and audio bitrate.
* **`/radio genre:<lofi|gaming|pop|chill>`** — Streams continuous internet radio.
* **`/volume level:<1-100>`** — Adjusts volume in real time.
* **`/loop mode:<off|track|queue>`** — Toggles repeat mode.
* **`/shuffle`** — Shuffles current queue in place.
* **`/disconnect`** — Forces bot disconnect from voice channel.
* **`/search query:<text>`** — Searches audio platforms for top tracks.
* **`/seek time:<timestamp>`** — Seeks audio position using ffmpeg offset (e.g. `1:30`, `90s`).
* **`/musicstatus`** — Real-time memory, voice ping, and active session count.
* **`/musicupdate status|check|logs|repair|apply`** — Self-healing audio diagnostics.
* **`/lyrics [song:<query>]`** — Fetches live song lyrics.

---

## 🎉 3. WELCOME (15 Commands)

* **`/welcome setup|config|test|banner|enable|disable`** — Master welcome card configuration tree.
* **`/setup`** — Automated interactive server setup wizard.
* **`/setwelcome [channel:#channel]`** — Sets welcome embed destination channel.
* **`/setrules channel:#channel`** — Binds server rules channel into welcome cards.
* **`/setroles channel:#channel`** — Binds roles channel into welcome cards.
* **`/setgeneral channel:#channel`** — Binds general chat channel into welcome cards.
* **`/setfun channel:#channel`** — Binds entertainment/bot channel into welcome cards.
* **`/setedit channel:#channel`** — Binds media/editing channel into welcome cards.
* **`/setgaming channel:#channel`** — Binds gaming channel into welcome cards.
* **`/setwelcomecolor color:<#hex>`** — Customizes welcome embed sidebar color.
* **`/setwelcometext`** — Customizes greeting, subtitle, and footer text.
* **`/setbanner [image] [url]`** — Sets custom welcome card banner (or `url:server`).
* **`/setlogo [image] [url]`** — Sets custom server logo/icon for welcome cards.
* **`/serverbanner [apply_welcome:true|false]`** — Syncs server banner to welcome card.
* **`/setautorole role:@Role`** — Selects default role auto-assigned to new joiners.

---

## 🚪 4. LEFT (4 Commands)

* **`/left setup|config|test|enable|disable|message`** — Master departure notification configuration tree.
* **`/goodbye [channel:#channel]`** — Sets departure channel.
* **`/setleave [channel:#channel]`** — Sets departure channel.
* **`/setleavetext message:<text>`** — Customizes goodbye message text (supports `{username}`, `{server}`, `{membercount}`).

---

## 📁 5. LOGS (1 Command)

* **`/logs setup|status|configure|test|disable`** — Master automated 14-channel server logging system:
  - Auto-creates Category **`📁 SERVER LOGS`** and all 14 isolated log channels (`#member-logs`, `#message-logs`, `#moderation-logs`, `#security-logs`, `#anti-nuke-logs`, `#automod-logs`, `#role-logs`, `#channel-logs`, `#voice-logs`, `#server-settings-logs`, `#invite-logs`, `#webhook-logs`, `#bot-logs`, `#welcome-logs`).

---

## 🎟️ 6. INV (4 Commands)

* **`/inv check|leaderboard|me`** — Master invite tracking system with invite code attribution.
* **`/myinvites`** — Displays personal invite statistics (regular, fake, leaves, bonus).
* **`/invites [user:@User]`** — Displays invite statistics for any member.
* **`/invitetop`** — Displays top server recruiters leaderboard.

---

## 🎲 7. GAMES (3 Commands)

* **`/games coinflip|dice|8ball|rps|points|leaderboard`** — Minigames and economy suite.
* **`/fun coinflip|dice|8ball|rps`** — Fast entertainment shortcuts.
* **`/points check|give|take|leaderboard|reset`** — Built-in server points system.

---

## ℹ️ 8. General Utilities (23 Commands)

* **`/ping`** — WebSocket heartbeat and API round-trip latency.
* **`/performance`** — Real-time performance monitor & telemetry: distinguishes Discord WebSocket ping (network latency) from internal command processing (p50/p95/p99), event-loop delay, RSS/heap memory, and recent errors (Owner/Admin only).
* **`/uptime`** — Continuous online time and process metrics.
* **`/botinfo`** — Node.js runtime, platform, memory usage, and guild counts.
* **`/serverinfo`** — Guild owner, member counts, channel distribution, and creation date.
* **`/userinfo [user:@User]`** — Member profile, account age, join date, and permissions.
* **`/permissions [user:@User]`** — Inspects active channel permissions.
* **`/help`** — Interactive command browser with category filters.
* **`/translate text:<text> to:<lang> [from:<lang>]`** — Real-time multi-lingual message translation.
* **`/appeal submit|status|review|setup`** — Formal punishment appeal system.
* **`/serverstat setup|update|disable`** — Real-time voice counter channels (`👥 Members`, `🤖 Bots`, `🚀 Boosts`).
* **`/afk set|clear|status`** — Dynamic AFK status system with mention auto-responses.
* **`/badge give|remove|list`** — Custom server recognition badges.
* **`/dm user|role`** — Direct message announcement dispatcher for staff.
* **`/nightmode setup|toggle|status`** — Scheduled server quiet hours with automated slowmode.
* **`/devmode stats|diagnostics|simulate`** — Deep bot performance metrics and dry-run simulation.
* **`/serverconfig view|export|reset`** — Master configuration dashboard with JSON export.
* **`/birthday set|check|upcoming|channel`** — Server birthday tracker with celebratory announcements.
* **`/maintenance enable|disable|status`** — Server maintenance mode notice.
* **`/clone export|import`** — Server configuration template cloning via base64 tokens.
* **`/module enable|disable|list`** — Granular feature toggle switchboard.
* **`/roleplay hug|pat|slap|highfive|wave`** — Social anime roleplay actions.
* **`/integration youtube|twitch|github|list|remove`** — External alert feeds for Twitch, YouTube, and GitHub.
