# 🚀 PRODUCTION 24/7 DEPLOYMENT & SETUP GUIDE

This guide explains how to deploy and run your Discord bot continuously with 99.9% uptime, multi-server data persistence, and proper security configuration.

---

## 🔑 1. DISCORD DEVELOPER PORTAL REQUIREMENTS

Before deploying your bot, you **MUST** configure two critical settings in the Discord Developer Portal:

1. Visit [Discord Developer Portal](https://discord.com/developers/applications).
2. Select your Bot Application.
3. In the left sidebar, click **Bot**.
4. Scroll down to **Privileged Gateway Intents**:
   * ✅ Enable **SERVER MEMBERS INTENT** *(Required for welcome messages, goodbye messages, member join logs, and alt detection)*.
   * ✅ Enable **MESSAGE CONTENT INTENT** *(Required for AutoMod keyword blacklist, link filtering, and spam analysis)*.
5. Click **Save Changes**.

### Bot Role Hierarchy in Your Discord Server
> ⚠️ **CRITICAL SECURITY NOTE:**
> A Discord bot **cannot** punish, ban, or strip roles from any user whose highest role is **above or equal to** the bot's highest role.
> To ensure Anti-Nuke and Moderation work correctly:
> 1. Go to **Server Settings** ➔ **Roles**.
> 2. Drag the Bot's role (`THOR APEX` or your bot name) to the **very top** (just below Server Owner / Administrator).
> 3. Ensure the bot has `Administrator` or the permissions listed below.

---

## ⚙️ 2. REQUIRED ENVIRONMENT VARIABLES

Create a `.env` file in the root directory (or enter these in your hosting provider's Environment Variables dashboard):

| Variable | Required | Description | Example |
|---|---|---|---|
| `DISCORD_TOKEN` | **YES** | Your Discord Bot Token | `MTA...` |
| `OWNER_ID` | Optional | Bot Creator's User ID (immune to security triggers) | `791552110600123456` |
| `PORT` | Optional | HTTP Health Check Server Port (defaults to 10000) | `10000` |
| `SPOTIFY_CLIENT_ID` | Optional | Spotify API credentials for music resolver | `your_id` |
| `SPOTIFY_CLIENT_SECRET`| Optional | Spotify API secret | `your_secret` |

---

## ☁️ 3. RECOMMENDED HOSTING PLATFORMS (REAL 24/7)

Discord bots maintain an active, long-lived **WebSocket Gateway connection**. Because of this, traditional free serverless functions (like Vercel or Netlify) are **not suitable**. You need an always-on process host.

### Option A: Railway (Recommended — Best Balance of Ease & Reliability)
1. Go to [railway.app](https://railway.app).
2. Click **New Project** ➔ **Deploy from GitHub repo**.
3. Select this repository.
4. Go to **Variables** and add:
   * `DISCORD_TOKEN` = `your_token`
   * `PORT` = `10000`
5. Railway will automatically detect Node.js, run `npm install`, and start the bot with persistent disk storage.

### Option B: Discloud (Dedicated Discord Bot Host)
1. This project already includes `discloud.config`:
   ```ini
   ID=thorapexwelcomebot
   TYPE=bot
   MAIN=index.js
   RAM=100
   VERSION=latest
   ```
2. Upload the project zip or push via Git to Discloud.

### Option C: VPS / Dedicated Server (Ubuntu Linux with PM2)
If hosting on your own Linux server / AWS EC2 / DigitalOcean Droplet:
```bash
# 1. Install Node.js (v18+) and PM2 process supervisor
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Clone repo and install dependencies
git clone <your-repo-url> bot
cd bot
npm install

# 3. Create .env file with your token
nano .env

# 4. Start with PM2 (Auto-restarts after crashes or server reboots)
pm2 start index.js --name "discord-bot"
pm2 save
pm2 startup
```

### Option D: Render (Web Service or Background Worker)
1. Go to [render.com](https://render.com) ➔ **New Web Service**.
2. Connect your repository.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Add `DISCORD_TOKEN` in Environment Variables.
> 💡 *Note on Render Free Tier:* Web services on Render sleep after 15 minutes of inactivity. The bot runs an HTTP health check server on port 10000. On free tiers, configure [UptimeRobot](https://uptimerobot.com) to ping `https://your-service.onrender.com/` every 5 minutes to keep it awake. For production, a Background Worker or paid instance is recommended.

---

## 🧪 4. VERIFYING YOUR BOT

Once the bot is online in your Discord server:
1. Run `/ping` — Verifies WebSocket and API response times.
2. Run `/logs setup` — Creates the `📁 SERVER LOGS` category and all 14 log channels.
3. Run `/welcome test` — Checks permissions and previews the welcome card.
4. Run `/security status` — Confirms Anti-Nuke and AutoMod are protecting the guild.
