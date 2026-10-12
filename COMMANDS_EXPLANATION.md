# ⚡ THOR APEX ALL-IN-ONE BOT - COMMAND EXPLANATION GUIDE

---

## ⚙️ 1. Bot Setup & Welcome Configuration Commands
* **`/setup`** — Auto-creates essential server channels (`#welcome`, `#rules`, `#logs`, etc.) and sets default server configuration automatically.
* **`/setwelcome`** — Sets the designated channel where welcome cards/embeds will be posted.
* **`/setleave`** — Sets the designated channel where goodbye/leave messages will be posted.
* **`/setrules`** — Sets the rules channel link referenced inside the welcome embed.
* **`/setroles`** — Sets the self-roles channel link referenced inside the welcome embed.
* **`/setgeneral`** — Sets the main chat channel link referenced inside the welcome embed.
* **`/setlog`** — Sets the main security, moderator, and audit log channel.
* **`/setvoicelog`** — Sets the log channel for voice activity (joins, leaves, drags, mutes, deafens).
* **`/setrolelog`** — Sets the log channel for role changes (given, removed, created, deleted).
* **`/setmemberlog`** — Sets the log channel for member activity (joins, leaves, nickname changes).
* **`/setwelcomecolor`** — Sets the border color for welcome embeds (e.g. `#FF0000` for Red).
* **`/setwelcometext`** — Customizes greeting prefix, title subtitle, and closing line for welcome embeds.
* **`/setleavetext`** — Customizes the goodbye message sent when members leave the server.
* **`/setautorole`** — Selects a default role automatically assigned to new members upon joining.
* **`/welcomeconfig`** — Displays the current server configuration and assigned channels.
* **`/testwelcome`** — Sends a test preview of the welcome embed to check its appearance.
* **`/testleave`** — Sends a test preview of the leave message to check its appearance.

---

## 🛡️ 2. Security & Anti-Nuke Protection Commands
* **`/security`** — Displays current security settings (Anti-Nuke, Anti-Spam, Alt Detection, etc.).
* **`/antinuke`** — Toggles the Anti-Nuke system (bans unauthorized users trying to delete channels, delete roles, mass ban members, or create webhooks).
* **`/antispam`** — Toggles message spam detection and punishment.
* **`/antilink`** — Toggles protection against external URL links and Discord invite links.
* **`/antiraid`** — Toggles Anti-Raid detection (activates server lockdown if mass joins occur).
* **`/altdetection`** — Toggles kicking alt accounts created under a specified number of days (e.g. `< 7 days`).
* **`/wordfilter`** — Toggles the blacklisted word filter.
* **`/addword`** — Adds a word to the blacklisted word filter list.
* **`/removeword`** — Removes a word from the blacklisted word filter list.
* **`/lockdown`** — Locks down all text channels (prevents `@everyone` from sending messages).
* **`/tagnotify`** — Toggles DM notifications sent to users when they are tagged in the server.
* **`/whitelist`** — Whitelist management for Anti-Nuke & AutoMod bypass:
  * `/whitelist action:remove user:@User` or `role:@Role` — Removes a user or role from the whitelist.
  * `/whitelist action:add user:@User` or `role:@Role` — Adds a user or role to bypass AutoMod/Anti-Nuke.
  * `/whitelist action:manage` — Opens interactive permission dashboard.
  * `/whitelist action:list` — Shows all whitelisted members and roles.
  * `/whitelist action:clear` — Clears all entries from the whitelist.
* **`/automod`** — Opens the interactive AutoMod setup panel to enable or disable protection events.
* **`/automodpunishment`** — Opens the AutoMod Punishment panel to customize punishments (Mute, Kick, Ban, Warn, Delete) for each event.

---

## 🔨 3. Moderation Commands
* **`/warn`** — Issues an official warning to a user with a reason and stores it in database.
* **`/warnings`** — Views all active warnings and reasons recorded for a user.
* **`/clearwarns`** — Clears all warnings recorded for a user.
* **`/mute`** — Mutes a member across text and voice channels.
* **`/unmute`** — Unmutes a previously muted member.
* **`/kick`** — Kicks a member from the Discord server.
* **`/ban`** — Bans a member from the Discord server.
* **`/unban`** — Unbans a user using their Discord User ID.
* **`/purge`** — Bulk deletes a specified number of messages (1-100) from the channel.

---

## 🎵 4. Music & 24/7 Radio Commands
* **`/play`** — Plays music in your voice channel using YouTube link, Spotify link, or song name.
* **`/pause`** — Pauses current music playback.
* **`/resume`** — Resumes paused music playback.
* **`/skip`** — Skips the current song playing in the queue.
* **`/stop`** — Stops music playback, clears the queue, and disconnects from voice.
* **`/queue`** — Views the current music queue or adds a new song to it.
* **`/nowplaying`** — Displays details about the song currently playing.
* **`/radio`** — Plays 24/7 radio streams (Lofi Chill, Gaming Beats, Pop Hits, Chill Hop).

---

## 👥 5. Invites & General Commands
* **`/myinvites`** — Displays your total invite count and invite statistics.
* **`/invites`** — Checks total invites and statistics for a specified user.
* **`/invitetop`** — Displays the server leaderboard of top inviters.
* **`/help`** — Opens an organized menu showing all available bot commands.
