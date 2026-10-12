# 🤖 THOR APEX Bot - Complete Setup, Security & Command Reference Archive

---

## 📌 Project Overview
* **Bot Name:** THOR APEX All-in-One Bot
* **Core Functions:** Welcome System, Leave System, Anti-Nuke, AutoMod, Logging, Music, 24/7 Radio Streams, Moderation, and Invites.
* **Storage Location:** `WELCOME BOT` directory

---

## 🛡️ Anti-Nuke & Security System

### 1. Features
* **Anti-Channel Delete / Create / Update**
* **Anti-Role Delete / Create / Update**
* **Anti-Member Ban / Kick / Prune**
* **Anti-Bot Add**
* **Anti-Webhook Create / Delete / Update**
* **Anti-Server Name / Icon / Guild Update**
* **Anti-Emoji / Sticker Tampering**
* **Anti-Everyone & Anti-Here Ping Protection** (Immediate message deletion + Kick/Punishment)

### 2. Whitelist Management
* `/whitelist action:add user:@Username` — Adds a user to bypass security checks.
* `/whitelist action:add role:@Role` — Adds a role to bypass security checks.
* `/whitelist action:remove user:@Username` — Removes a user from the whitelist.
* `/whitelist action:remove role:@Role` — Removes a role from the whitelist.
* `/whitelist action:manage` — Opens the interactive permissions dashboard.
* `/whitelist action:list` — Lists all currently whitelisted members and roles.
* `/whitelist action:clear` — Clears the whitelist entirely.

---

## 🤖 AutoMod & Protection Events

### 1. Events Protected
1. **Anti-Spam** (> 3 fast messages within 4 seconds)
2. **Anti-Everyone / Anti-Here Ping** (Instant deletion + Kick/Punish)
3. **Anti-Caps Lock** (> 70% uppercase text)
4. **Anti-Invites** (Blocks discord.gg and discord.com/invite links)
5. **Anti-Links** (Blocks unauthorized external URLs)
6. **Anti-NSFW Links** (Blocks inappropriate links)
7. **Anti-Mass Mention** (Blocks 5+ mentions in a single message)
8. **Anti-Emoji Spam** (Blocks messages exceeding emoji limit)
9. **Word Filter / Blacklist** (Deletes messages containing banned terms)
10. **Tag Notifications** (Sends private DM when users are mentioned)

### 2. AutoMod Commands
* `/automod action:enable` — Enables all AutoMod protections at once.
* `/automod action:disable` — Disables AutoMod protections.
* `/automod action:status` — Displays the interactive status dashboard.
* `/automodpunishment` — Opens the interactive per-event punishment configuration menu (choose Mute, Kick, Ban, Warn, or Delete Only for each event).
* `/antieveryone toggle:on` — Toggles Anti-Everyone/Here ping protection on or off.

---

## 📋 Complete Slash Commands Cheat Sheet

### Configuration & Setup
| Command | Description |
|---|---|
| `/setup` | Complete server onboarding and automatic channel generation |
| `/setwelcome` | Sets the welcome message channel |
| `/setleave` | Sets the member leave announcement channel |
| `/setrules` | Sets the server rules channel |
| `/setroles` | Sets the reaction roles channel |
| `/setgeneral` | Sets the main chat channel |
| `/setlog` | Sets the moderation audit log channel |
| `/setvoicelog` | Sets the voice connect/disconnect log channel |
| `/setrolelog` | Sets the role create/update/delete log channel |
| `/setmemberlog` | Sets the member join/leave log channel |
| `/setautorole` | Configures the role auto-assigned to new joiners |
| `/setmuterole` | Configures the mute role applied during punishments |
| `/sendwelcome` | Sends an embed welcome test message to the configured channel |
| `/sendrules` | Posts rules embed to the rules channel |
| `/sendroles` | Posts reaction role selectors |

### Moderation
| Command | Description |
|---|---|
| `/warn` | Warns a member with an optional reason |
| `/warnings` | Checks active warnings for a member |
| `/clearwarns` | Clears all warnings for a member |
| `/mute` | Mutes a member across all channels |
| `/unmute` | Unmutes a muted member |
| `/kick` | Kicks a member from the server |
| `/ban` | Bans a member from the server |
| `/unban` | Unbans a member via Discord User ID |
| `/purge` | Mass-deletes messages (1-100) from a channel |
| `/lockdown` | Locks down channels to prevent @everyone messaging |

### Music & 24/7 Radio
| Command | Description |
|---|---|
| `/play` | Plays YouTube/Spotify audio in voice channel |
| `/pause` | Pauses audio playback |
| `/resume` | Resumes audio playback |
| `/skip` | Skips to next song in queue |
| `/stop` | Stops playback and leaves voice channel |
| `/queue` | Displays current music queue |
| `/nowplaying` | Displays currently playing track |
| `/radio` | Streams 24/7 radio (Lofi Chill, Gaming Beats, Pop Hits, Chill Hop) |

### Invites & General
| Command | Description |
|---|---|
| `/myinvites` | Displays your total invite count |
| `/invites` | Checks invites for a specific member |
| `/invitetop` | Server invite leaderboard |
| `/help` | Complete interactive bot command directory |

---

## 🚀 How to Run the Bot
1. Ensure your `.env` file contains your `DISCORD_TOKEN` and `BOT_OWNER_ID`.
2. Open terminal in the bot folder:
   ```bash
   node index.js
   ```
