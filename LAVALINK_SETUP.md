# THOR APEX — Local Lavalink v4.2.2 Setup Guide (Windows)

This guide walks you through setting up and running your **free local Lavalink server** on Windows for **THOR APEX**. This provides high-quality, full-length audio playback without short previews, 403 blocks, or monthly hosting costs.

---

## 📌 Architecture Overview
- **Lavalink Server**: Version `4.2.2` (Spring Boot / Java 21)
- **Discord Client Connector**: `shoukaku` version `^4.3.0`
- **YouTube Audio Plugin**: `dev.lavalink.youtube:youtube-plugin:1.18.2`
- **Supported Sources**: YouTube (Full-length streams), Spotify (Metadata matched to full-length audio), SoundCloud, Bandcamp, Twitch, HTTP streams.
- **Port**: `2333` (Default internal bind)

---

## 🚀 Quick Setup (2 Terminals)

### Step 1: Configure Your Local `.env`

Open your existing `.env` file in the project root (`c:\Users\UGINE\OneDrive\Documents\DISCORD BOTS DATABASE\WELCOME BOT\.env`) and add the following lines at the bottom:

```env
# Lavalink v4.2.2 Local Audio Engine
LAVALINK_HOST=localhost
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=false
```

*(Do not delete your existing `DISCORD_TOKEN` or other variables. Keep all existing tokens intact).*

---

### Step 2: Start Lavalink Server (Terminal 1)

Open a **Windows PowerShell** terminal in the bot's root directory and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-lavalink.ps1
```

#### What happens automatically:
1. Detects your installed **Java 21 LTS** (`Temurin-21.0.12.1+1`).
2. Checks if `lavalink/Lavalink.jar` exists. If missing, it downloads the official Lavalink v4.2.2 JAR directly from GitHub Releases.
3. Automatically loads `lavalink/application.yml` and downloads the YouTube audio plugin.
4. Starts the WebSocket server on port `2333`.

#### Expected Terminal 1 Output:
```text
==========================================================
  THOR APEX — Lavalink v4.2.2 Local Audio Server Launcher  
==========================================================

[1/4] Checking Java installation...
  -> Detected: openjdk version "21.0.12.1" 2026-08-18 LTS
[2/4] Checking Lavalink.jar...
  -> Found existing Lavalink.jar (or downloading...)
[3/4] Checking port 2333 availability...
  -> Port 2333 is available.
[4/4] Starting Lavalink v4.2.2 server...
...
INFO [main] dev.lavalink.youtube.YoutubePlugin: Loaded YouTube plugin v1.18.2
INFO [main] lavalink.server.Launcher: Lavalink is ready to accept connections.
```

> [!TIP]
> Keep Terminal 1 open while playing music. Press `Ctrl + C` anytime to stop the Lavalink server.

---

### Step 3: Start THOR APEX Discord Bot (Terminal 2)

Open a **second PowerShell terminal** in the same repository folder and run:

```powershell
npm start
```

#### Expected Terminal 2 Output:
```text
[THOR-LAVALINK] Node "thor-apex-main" connected and ready (Lavalink 4.2.2).
Ready! Logged in as THOR APEX#...
```

---

## 🎵 Step 4: Test Playback in Discord

Join any voice channel in your Discord server and run the following slash commands:

1. **Test Song Name Search:**
   ```text
   /songs play query: Enna Sona Arijit Singh
   ```
   - **Expectation:** THOR APEX joins the voice channel, identifies the official recording by Arijit Singh (rejecting Mitraz / cover versions), displays the rich player card, and starts full-length audio playback.

2. **Test Direct YouTube Link:**
   ```text
   /songs play query: https://www.youtube.com/watch?v=s_95jJvXFqg
   ```
   - **Expectation:** Resolves instantly via Lavalink v4.2.2 with full track duration without preview limits.

3. **Test Spotify Track Link:**
   ```text
   /songs play query: https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC
   ```
   - **Expectation:** Resolves Spotify metadata (Rick Astley - Never Gonna Give You Up) and streams the full-length YouTube master recording without dropping after 30 seconds.

4. **Test Queue & Controls:**
   - Pause: `/songs pause` or click the ⏸️ button on the card.
   - Resume: `/songs resume` or click the ▶️ button.
   - Skip: `/songs skip` or click the ⏭️ button.
   - Volume: `/songs volume percent: 80`
   - Queue: `/songs queue`

---

## 🛠️ Troubleshooting & Common Questions

### 1. Bot says: "No LAVALINK_HOST configured in environment"
- **Cause:** `LAVALINK_HOST` is missing from your `.env` file.
- **Fix:** Ensure you added `LAVALINK_HOST=localhost` in your `.env` file and restarted the bot (`npm start`).

### 2. Bot logs: "WebSocket connection to ws://localhost:2333 failed (ECONNREFUSED)"
- **Cause:** Lavalink server in Terminal 1 has not finished booting or is not running.
- **Fix:** Run `scripts\start-lavalink.ps1` in Terminal 1 and wait until it prints `Lavalink is ready to accept connections` before starting the bot in Terminal 2.

### 3. Error 401 Unauthorized
- **Cause:** Password mismatch between `.env` and `application.yml`.
- **Fix:** Make sure `LAVALINK_PASSWORD=youshallnotpass` in `.env` matches the password configured in `lavalink/application.yml`.

### 4. Port 2333 is in use by another program
- **Cause:** An old Lavalink process or other background application is holding port 2333.
- **Fix:** In PowerShell, run:
  ```powershell
  Get-NetTCPConnection -LocalPort 2333 | Select-Object OwningProcess
  Stop-Process -Id <OwningProcessId> -Force
  ```
