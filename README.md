# ⚡ THOR APEX — Enterprise Discord Security, Music & Community Bot

[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14.16-blue.svg)](https://discord.js.org)
[![Tests](https://img.shields.io/badge/Tests-204%20Passing-brightgreen.svg)](https://github.com/thor1kvault-sudo/wel-bot-all)
[![Deployment](https://img.shields.io/badge/Deploy-Render-46E3B7.svg)](https://render.com)

**THOR APEX** is an enterprise-grade all-in-one Discord bot engineered with **high-speed automated security**, **24/7 persistent voice & music**, **welcome & leave notification engines**, **14-channel structured audit logging**, **invite tracking**, and **community engagement systems**.

---

## 🌟 Core Architecture & Highlights

- **🛡️ Enterprise Security Pipeline:** Event-driven sub-millisecond detection with sliding-window rate limiters, anti-nuke, multi-window anti-mod abuse detection, anti-raid multi-factor scoring, and thread-safe lockdown/unlock preserving private channels and server logs.
- **🎵 24/7 Persistent Music Engine:** Single-connection voice reuse with silent idle standby, bounded exponential backoff reconnection, YouTube/Spotify/SoundCloud playback, and true PCM seek.
- **📁 14-Channel Structured Logging:** Auto-creates isolated channels for member, message, mod, security, role, channel, voice, invite, webhook, bot, and welcome events.
- **⚡ Canonical Seven-Group Command Hierarchy:** Exactly 99 application commands registered within Discord's 100-command limit.
- **🧪 100% Automated Test Coverage:** 204 automated tests covering security, moderation, music, command dispatching, and multi-guild isolation.

---

## 📋 The Seven Canonical Command Groups

All application commands are strictly registered in this canonical hierarchy:

1. **`SECURITY`** (30 commands)
   - Master suite: `/security` (`status`, `config`, `trust`, `lockdown`, `unlock`, `diagnostics`, `antinuke`, `antimod`, `antiraid`, `incidents`, `audit`, `test`).
   - Moderation: `/warn`, `/warnings`, `/clearwarnings`, `/timeout`, `/untimeout`, `/kick`, `/ban`, `/unban`, `/softban`, `/purge`, `/slowmode`, `/lock`, `/unlock`, `/nick`, `/modlogs`.
   - Filters: `/automod`, `/antispam`, `/antilink`, `/antiraid`, `/altdetection`, `/wordfilter`, `/lockdown`, `/whitelist`, `/threat`, `/quarantine`, `/quickmod`, `/vpncheck`, `/raidmode`.

2. **`SONGS`** (20 commands)
   - 24/7 Subsystem: `/songs 24-7 enable`, `/songs 24-7 disable`, `/songs 24-7 status`, `/songs 24-7 setup`.
   - Master tree: `/songs playback`, `/songs queue`, `/songs audio`.
   - Standalone shortcuts: `/play`, `/pause`, `/resume`, `/skip`, `/stop`, `/queue`, `/nowplaying`, `/radio`, `/volume`, `/loop`, `/shuffle`, `/previous`, `/playnow`, `/disconnect`, `/search`, `/seek`, `/musicstatus`, `/musicupdate`, `/lyrics`.

3. **`WELCOME`** (15 commands)
   - `/welcome` master tree (`setup`, `config`, `test`, `banner`, `enable`, `disable`).
   - Channels & design: `/setup`, `/setwelcome`, `/setrules`, `/setroles`, `/setgeneral`, `/setfun`, `/setedit`, `/setgaming`, `/setwelcomecolor`, `/setwelcometext`, `/setbanner`, `/setlogo`, `/serverbanner`, `/setautorole`.

4. **`LEFT`** (4 commands)
   - `/left` master tree (`setup`, `config`, `test`, `enable`, `disable`, `message`), `/goodbye`, `/setleave`, `/setleavetext`.

5. **`LOGS`** (1 command)
   - `/logs` (`setup`, `status`, `configure`, `test`, `disable`) for the 14-channel server log infrastructure.

6. **`INV`** (4 commands)
   - `/inv` (`check`, `leaderboard`, `me`), `/myinvites`, `/invites`, `/invitetop`.

7. **`GAMES`** (3 commands)
   - `/games` (`coinflip`, `dice`, `8ball`, `rps`, `points`, `leaderboard`), `/fun`, `/points`.

*Plus 22 General Utilities (`/ping`, `/uptime`, `/botinfo`, `/serverinfo`, `/userinfo`, `/permissions`, `/help`, `/translate`, `/appeal`, `/serverstat`, `/afk`, `/badge`, `/dm`, `/nightmode`, `/devmode`, `/serverconfig`, `/birthday`, `/maintenance`, `/clone`, `/module`, `/roleplay`, `/integration`).*

---

## 🚀 Deployment & Installation

### Prerequisites
- Node.js `v18.0.0` or higher
- FFmpeg installed in system PATH (for music audio transcoding)
- Discord Bot Application with `Guilds`, `GuildMembers`, `GuildVoiceStates`, `GuildMessages`, `MessageContent` Gateway Intents enabled in the Discord Developer Portal.

### Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/thor1kvault-sudo/wel-bot-all.git
   cd wel-bot-all
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Create a `.env` file from the example:
   ```env
   DISCORD_TOKEN=your_bot_token_here
   CLIENT_ID=your_application_client_id_here
   GUILD_ID=your_test_guild_id_optional
   PORT=3000
   ```

4. **Deploy Application Slash Commands:**
   ```bash
   node deploy.js
   ```

5. **Run the Automated Test Suite:**
   ```bash
   npm test
   ```

6. **Start the Bot:**
   ```bash
   npm start
   ```

---

## 🧪 Testing & Verification

The bot includes an extensive automated test suite run via Node.js native test runner:
```bash
npm test
```
```text
✔ 204 passing
✔ 0 failing
✔ Duration: ~13s
```

All 99 application commands, interaction routing, rate-limiters, audio player state machines, and channel permission snapshots are validated continuously.

---

## 🔒 Security Best Practices

- **Zero Unnecessary REST Calls:** Audit logs are fetched only when local high-frequency counters cross defined burst thresholds.
- **Thread-Safe Lockdown:** Channel permission overwrites are snapshotted in memory and serialized to disk. Hidden staff and server log channels are strictly preserved.
- **Anti-Mod Protection:** Moderators cannot mass-ban, mass-kick, or mass-timeout members without triggering automated role revocation and audit alerts.
- **Owner & Safe Immunity:** Server owners, bots, and whitelisted roles are safely protected from automated punishment containment.

---

## 📄 License
ISC License © 2026 UGINE / THOR APEX
