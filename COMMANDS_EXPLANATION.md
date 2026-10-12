# 🛡️ THOR APEX — DISCORD SECURITY, ANTI-NUKE, AUTOMOD & WELCOME BOT
## Complete Command & Feature Documentation Guide

---

### 🛡️ 1. High-Speed Anti-Nuke Security Commands
* **`/security status`** — Displays real-time security protection status, enforcement policy, and active lockdowns.
* **`/security audit`** — Audits bot role hierarchy, administrative permissions, and audit log access in this server.
* **`/security incidents`** — Displays recent intercepted security incidents, actors, detection latencies, and containment results.
* **`/security test`** — Tests security notification paths and verified event dispatching.
* **`/antinuke enable`** — Enables real-time sub-second Anti-Nuke protection across channels, roles, webhooks, bans, and bots.
* **`/antinuke disable`** — Temporarily disables Anti-Nuke protection (Server Owner / Administrator only).
* **`/antinuke status`** — Displays per-guild burst limits, windows, and current containment action.
* **`/antinuke config action:<action>`** — Configures automated enforcement response:
  * `strip_and_ban`: Instantly removes dangerous roles and bans the offender (Recommended).
  * `ban`: Immediately bans the offender.
  * `kick`: Kicks the offender from the server.
  * `quarantine`: Strips all administrative and assigned roles without banning.
  * `alert`: Logs detection without automated punishment.
* **`/antinuke threshold action:<action> limit:<number> [window_seconds:<seconds>]`** — Sets customizable burst trigger limits (e.g. max 2 channel deletions within 15 seconds).
* **`/antinuke trust add user:@User` / `role:@Role`** — Adds a user or role to the Anti-Nuke trusted exemption list.
* **`/antinuke trust remove user:@User` / `role:@Role`** — Removes an entry from the trusted list.
* **`/antinuke trust list`** — Lists all authorized trusted users and roles.
* **`/antinuke lockdown`** — Immediately locks down all channels (denies `@everyone` SendMessages) in emergencies.
* **`/antinuke unlock`** — Lifts emergency server lockdown and restores normal channel permissions.

---

### 🤖 2. Professional AutoMod Commands
* **`/automod enable`** — Activates AutoMod message and member filtering.
* **`/automod disable`** — Pauses AutoMod rule enforcement.
* **`/automod status`** — Displays all active filters (Spam, Duplicates, Mention Spam, Links, NSFW, Blacklist, Caps, Emojis, Alts, Raids).
* **`/automod blacklist action:add word:<word>`** — Adds a word or phrase to the server blacklist (uses word-boundary regex to prevent false positives).
* **`/automod blacklist action:remove word:<word>`** — Removes a word from the blacklist.
* **`/automod blacklist action:list`** — Displays all server blacklisted words.
* **`/automod whitelist action:add user:@User` / `role:@Role` / `channel:#Channel`** — Exempts a user, role, or channel from AutoMod penalties.
* **`/automod whitelist action:remove user:@User` / `role:@Role` / `channel:#Channel`** — Revokes an AutoMod exemption.

---

### 📁 3. Dedicated 14-Channel Logging System
* **`/logs setup`** — Automatically creates Category **`📁 SERVER LOGS`** and all **14 dedicated log channels** (idempotent, avoids duplicates):
  1. `#member-logs` — Member joins, leaves, nickname changes.
  2. `#message-logs` — Message edits, deletions, and bulk purges.
  3. `#moderation-logs` — Warns, timeouts, kicks, bans, unbans.
  4. `#security-logs` — Security alerts and emergency lockdowns.
  5. `#anti-nuke-logs` — Anti-Nuke triggers, burst intercepts, role strips.
  6. `#automod-logs` — AutoMod rule triggers, filtered messages, alt detections.
  7. `#role-logs` — Role creations, deletions, permission grants.
  8. `#channel-logs` — Channel creations, deletions, overwrite updates.
  9. `#voice-logs` — Voice joins, leaves, moves, mutes, deafens.
  10. `#server-settings-logs` — Server name, icon, banner, security changes.
  11. `#invite-logs` — Invite creations, deletions, usage.
  12. `#webhook-logs` — Webhook creations, deletions, edits.
  13. `#bot-logs` — Bot additions, bot removals.
  14. `#welcome-logs` — Welcome/goodbye card delivery reports & diagnostics.
* **`/logs status`** — Displays all 14 linked channels.
* **`/logs configure category:<category> channel:#channel`** — Manually binds a category to any existing channel.
* **`/logs test`** — Dispatches test embeds across log channels.
* **`/logs disable category:<category>`** — Mutes logging for a category.

---

### 🎉 4. Welcome & Goodbye Commands
* **`/welcome setup channel:#channel`** — Locks the designated channel for welcome cards.
* **`/welcome test`** — Sends an interactive preview of the welcome card matching the premium demo layout and runs a full permissions diagnostic.
* **`/welcome config`** — Displays current welcome card channels, color, and options.
* **`/welcome enable`** / **`/welcome disable`** — Toggles welcome messages.
* **`/goodbye setup channel:#channel`** — Locks the channel for member leave/goodbye embeds.
* **`/goodbye test`** — Sends a preview of the departure embed.
* **`/goodbye enable`** / **`/goodbye disable`** — Toggles leave messages.
* **`/setwelcomecolor color:<#hex>`** — Customizes embed sidebar color (e.g. `#FF0000` for Red).
* **`/setwelcometext`** — Customizes greeting, subtitle, and closing lines.
* **`/setleavetext`** — Customizes departure message with `{username}`, `{server}`, `{membercount}` placeholders.
* **`/setautorole role:@Role`** — Selects a default role assigned automatically upon joining.

---

### ⚖️ 5. Moderation Commands (Role Hierarchy Protected)
* **`/warn user:@User reason:<text>`** — Issues an official warning stored in persistent storage.
* **`/warnings user:@User`** — Displays warning history for a member.
* **`/clearwarnings user:@User`** — Clears all warnings for a member.
* **`/timeout user:@User duration:<e.g. 10m, 1h, 1d> [reason:<text>]`** — Applies Discord native timeout.
* **`/untimeout user:@User`** — Removes timeout from a member.
* **`/kick user:@User [reason:<text>]`** — Kicks a member (enforces role hierarchy).
* **`/ban user:@User [delete_days:<0-7>] [reason:<text>]`** — Bans a user from the server.
* **`/unban userid:<id> [reason:<text>]`** — Unbans a user by their User ID.
* **`/softban user:@User [reason:<text>]`** — Bans and instantly unbans to purge last 7 days of messages.
* **`/purge amount:<1-100> [filter:all|bot|links]`** — Bulk deletes messages from the current channel.
* **`/slowmode seconds:<0-21600> [channel:#channel]`** — Sets channel slowmode delay.
* **`/lock [channel:#channel] [reason:<text>]`** — Locks a channel preventing `@everyone` from sending messages.
* **`/unlock [channel:#channel]`** — Restores chat permissions.
* **`/nick user:@User [nickname:<name>]`** — Updates or resets a member nickname.
* **`/modlogs user:@User`** — Views complete moderation strike history.

---

### 🎵 6. Music & 24/7 Radio Commands
* **`/play song:<name or link>`** — Plays YouTube, Spotify, or Soundcloud tracks.
* **`/pause`** — Pauses current track.
* **`/resume`** — Resumes playback.
* **`/skip`** — Skips to next track in queue.
* **`/stop`** — Stops playback, clears queue, and leaves voice.
* **`/queue [song:<add>]`** — Views current track queue.
* **`/nowplaying`** — Shows track info, duration, and artist.
* **`/radio genre:<lofi|gaming|pop|chill>`** — Plays continuous 24/7 audio streams.
* **`/volume level:<1-100>`** — Adjusts audio stream volume.
* **`/loop mode:<off|track|queue>`** — Configures track or queue repetition.
* **`/shuffle`** — Shuffles current music queue.
* **`/previous`** — Replays the previous track from history.

---

### ℹ️ 7. Utility Commands
* **`/ping`** — Displays WebSocket heartbeat and round-trip API latency.
* **`/uptime`** — Displays continuous online time and process start time.
* **`/botinfo`** — Displays Node.js version, platform, memory usage, and connected guild counts.
* **`/serverinfo`** — Displays server owner, member counts, channel counts, and creation timestamp.
* **`/userinfo [user:@User]`** — Displays profile, account creation date, server join date, and roles.
* **`/permissions [user:@User]`** — Inspects active Discord channel permissions.
* **`/help`** — Opens comprehensive interactive command guide.
