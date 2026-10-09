# 🤖 Multi-Server Welcome Bot

A fully **public Discord Welcome Bot** that works on any server. Each server gets its own independent configuration — no hardcoded values. Server admins set everything up using slash commands right inside Discord.

---

## ✨ Features

- ✅ Works on **any Discord server** — fully public bot
- ✅ Each server has **independent settings** (stored per guild)
- ✅ Auto-uses **server icon & banner** in welcome embed
- ✅ Shows **member's avatar** as thumbnail in welcome
- ✅ Fully configurable via **slash commands** — no code editing needed
- ✅ Health check HTTP server (compatible with Render, Railway, Koyeb)
- ✅ Legacy `!testwelcome` and `!setwelcome` text commands still supported

---

## 🚀 Slash Commands

### 🛠️ Setup (Admin / Manage Server Required)

| Command | Description |
|---|---|
| `/setwelcome [channel]` | Set the welcome channel *(defaults to current channel)* |
| `/setrules <channel>` | Set the rules channel shown in welcome embed |
| `/setroles <channel>` | Set the roles channel shown in welcome embed |
| `/setgeneral <channel>` | Set the general/chat channel shown in welcome embed |
| `/setwelcomecolor <#hex>` | Change the embed color (e.g. `#FF5733`) |
| `/setwelcometext` | Customize greeting, subtitle, and outro text |
| `/resetwelcome` | Reset all settings to defaults *(Admin only)* |

### 👁️ View & Test

| Command | Description |
|---|---|
| `/welcomeconfig` | View current configuration for this server |
| `/testwelcome` | Preview the welcome message |
| `/welcomehelp` | Show all commands |

---

## ⚡ Quick Start (For Server Admins)

After adding the bot to your server:

1. Go to your **welcome channel** → run `/setwelcome`
2. Run `/setrules #rules`, `/setroles #roles`, `/setgeneral #general`
3. Run `/setwelcomecolor #5865F2` to pick your color
4. Run `/testwelcome` to preview
5. Done! 🎉 The bot will now auto-welcome every new member.

---

## 🛠️ Self-Hosting Setup

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure your token
```bash
cp .env.example .env
```
Edit `.env` and paste your bot token:
```
DISCORD_TOKEN=your_real_token_here
```

### 4. Run the bot
```bash
npm start
```

---

## ☁️ Hosting on Render (Free)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set these options:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `Node`
5. Add Environment Variable:
   - Key: `DISCORD_TOKEN` → Value: your bot token
6. Click **Deploy** — done!

> ⚠️ **Important:** On Render's free tier, the service sleeps after inactivity. Use [UptimeRobot](https://uptimerobot.com) to ping the health check URL every 5 minutes to keep it awake.

---

## 📋 Requirements

- Node.js **v18 or higher**
- A Discord Bot with these **Privileged Gateway Intents** enabled:
  - ✅ **SERVER MEMBERS INTENT**
  - ✅ **MESSAGE CONTENT INTENT**

Enable at: [discord.com/developers/applications](https://discord.com/developers/applications) → Your Bot → **Bot** tab → Privileged Gateway Intents

---

## 📁 Project Structure

```
├── index.js              # Main bot file
├── package.json          # Dependencies
├── .env                  # Your secret token (NOT pushed to GitHub)
├── .env.example          # Token template (safe to push)
├── .gitignore            # Excludes .env, node_modules, guild_configs
├── guild_configs/        # Auto-created — stores per-server settings (NOT pushed)
│   ├── 1234567890.json   # Config for server 1234567890
│   └── ...
└── README.md
```

---

## 🔒 Security Note

- **Never commit your `.env` file** — it contains your bot token
- The `guild_configs/` folder is also excluded from git (contains server channel IDs)
- Both are listed in `.gitignore` automatically

---

## 📜 License

MIT — Free to use, modify, and share.
