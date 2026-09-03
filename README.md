# ⚡ THOR APEX Discord Welcome Bot

Custom, high-quality Discord Welcome Message Bot for **THOR APEX ⚡** (or any Discord Server).

Matches your exact screenshot design featuring:
- ⚡ **Member Mentions**: Tags new members directly in the message (`HEY BUDDY! @username`).
- 🖼️ **Animated Server Logo**: Configured automatically with your server's animated GIF logo.
- 🎨 **Animated Server Banner**: Full-width server banner image at the bottom of the embed.
- 📌 **Interactive Channel Mentions**: Clickable channel links for Rules, Self-Role, Announcements, and Chill Out.
- 🔴 **Red Theme Accent**: Sleek red border accent color matching your server branding.
- 🧪 **Admin Test Command (`!testwelcome`)**: Preview the welcome message anytime without having to re-join the server.

---

## 🛠️ Step-by-Step Setup Guide

### STEP 1: Create your Discord Bot Application
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** on the top right.
3. Give your bot a name (e.g., `THOR APEX WELCOME`) and click **Create**.
4. Go to the **Bot** tab on the left menu:
   - Click **Reset Token** (or **Copy**) to get your Bot Token.
   - ⚠️ **KEEP THIS TOKEN PRIVATE!**

---

### STEP 2: Enable Privileged Gateway Intents (CRITICAL!)
> [!IMPORTANT]
> If you skip this step, Discord will block the bot from detecting when new members join!

1. In the **Bot** tab of the Discord Developer Portal, scroll down to **Privileged Gateway Intents**.
2. Turn **ON** the following toggles:
   - ✅ **SERVER MEMBERS INTENT** *(Required for welcome messages)*
   - ✅ **MESSAGE CONTENT INTENT** *(Required for `!testwelcome` command)*
3. Click **Save Changes** at the bottom.

---

### STEP 3: Invite the Bot to Your Discord Server
1. Go to the **OAuth2** tab -> **URL Generator** on the left menu.
2. Under **Scopes**, check:
   - ✅ `bot`
3. Under **Bot Permissions**, check:
   - ✅ `Send Messages`
   - ✅ `Embed Links`
   - ✅ `Attach Files`
   - ✅ `Read Message History`
   - ✅ `Mention Everyone`
4. Copy the **Generated URL** at the bottom, paste it into your browser, and select your Discord server (`THOR APEX ⚡`) to invite the bot.

---

### STEP 4: Get Channel IDs in Discord
To link your server channels in the welcome message:
1. Open Discord -> Go to **User Settings** (Gear icon bottom left).
2. Go to **Advanced** -> Turn **ON** **Developer Mode**.
3. Now right-click on any channel in your server and click **Copy Channel ID**:
   - Copy your **Welcome Channel ID**
   - Copy your **Rules Channel ID**
   - Copy your **Roles Channel ID**
   - Copy your **Announcements Channel ID**
   - Copy your **Chill Out Channel ID**

---

### STEP 5: Configure `.env` and `config.json`

#### 1. Edit `.env`
Open the `.env` file in VS Code or Notepad and paste your Bot Token:
```env
DISCORD_TOKEN=OTExMjM0NTY3ODkwMTIzNDU2.G12345.YourActualBotTokenHere
```

#### 2. Edit `config.json`
Open `config.json` and replace the placeholder channel IDs with the IDs you copied in Step 4:
```json
"channels": {
  "welcomeChannelId": "1528085405809901578",
  "rulesChannelId": "YOUR_RULES_CHANNEL_ID",
  "rolesChannelId": "YOUR_ROLES_CHANNEL_ID",
  "announcementsChannelId": "YOUR_ANNOUNCEMENTS_CHANNEL_ID",
  "chillOutChannelId": "YOUR_CHILL_OUT_CHANNEL_ID"
}
```

---

### STEP 6: Run the Bot!

Open your terminal in the `WELCOME BOT` folder and run:
```bash
node index.js
```

You should see:
```text
===========================================
⚡ Discord Welcome Bot is ONLINE!
🤖 Logged in as: THOR APEX WELCOME#1234
🛡️  Guilds active: 1
===========================================
```

---

## 🧪 Testing the Welcome Embed
Go to any text channel in your server where the bot has permission to speak and type:
```text
!testwelcome
```
The bot will generate and send the exact welcome embed instantly!

---

## 🎨 Customizing Text & Images
You can customize all text, titles, images, and colors directly in `config.json`:
- `embedColor`: Change hex color (e.g. `#FF0000` for Red, `#00FF00` for Green, `#5865F2` for Discord Blurple).
- `customImages.logoUrl`: Change custom thumbnail logo image URL.
- `customImages.bannerUrl`: Change custom bottom banner image URL.
- `messages`: Change greeting texts, guidelines title, or outro message.

---

## 🌐 24/7 Free Hosting Guide

### Method 1: Discloud (Recommended - Best 100% Free Discord Bot Host)
1. Go to [discloud.app](https://discloud.app) and sign in with Discord.
2. Select all files in your project directory **except `node_modules`** and zip them (`bot.zip`).
   *(Ensure `discloud.config`, `index.js`, `package.json`, `config.json`, and `.env` are inside the zip)*.
3. On Discloud dashboard, upload `bot.zip`.
4. Click **Start** — your bot will stay online 24/7 for free!

### Method 2: Render.com (Free Web Service + Keep-Alive)
1. Push your code to a GitHub repository (do **not** push `.env` with your token).
2. Go to [render.com](https://render.com) and create a **Web Service** connected to your repo.
3. Build Command: `npm install`
4. Start Command: `node index.js`
5. Add Environment Variable:
   - Key: `DISCORD_TOKEN` | Value: `(Your Bot Token)`
6. Copy your Render web service URL (e.g. `https://your-bot.onrender.com`).
7. Go to [UptimeRobot.com](https://uptimerobot.com) (free) and create an **HTTP Monitor** pointing to your Render URL every 5 minutes so it never goes to sleep!

