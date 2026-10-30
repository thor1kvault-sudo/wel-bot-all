# THOR APEX — Lavalink 4.2.2 Audio Server

Official Lavalink v4.2.2 deployment service for THOR APEX Discord Bot.

## 📌 Architecture Overview
- **Lavalink Version**: `4.2.2` ([Release Tag](https://github.com/lavalink-devs/Lavalink/releases/tag/4.2.2))
- **Base Docker Image**: `ghcr.io/lavalink-devs/lavalink:4.2.2`
- **Runtime**: Java 21 (bundled in base image)
- **Audio Plugin**: `dev.lavalink.youtube:youtube-plugin:1.18.2`
- **Default Port**: `2333`
- **Internal Bind**: `0.0.0.0`

---

## 🚀 Local Docker Run
To run Lavalink locally with Docker:
```bash
cd lavalink
docker build -t thor-apex-lavalink:4.2.2 .
docker run -d \
  --name thor-apex-lavalink \
  -p 2333:2333 \
  -e LAVALINK_SERVER_PASSWORD=your_secure_password_here \
  thor-apex-lavalink:4.2.2
```

Verify logs:
```bash
docker logs -f thor-apex-lavalink
```

---

## ☁️ Render Private Service Deployment (`thor-apex-lavalink`)

### 1. Create a New Service on Render
1. Go to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Private Service**.
3. Connect your Git repository: `thor1kvault-sudo/wel-bot-all`.
4. Set the following configuration:
   - **Name**: `thor-apex-lavalink`
   - **Environment**: `Docker`
   - **Region**: Same region as your THOR APEX Discord bot (e.g. Frankfurt or Oregon).
   - **Branch**: `main`
   - **Dockerfile Path**: `lavalink/Dockerfile`
   - **Docker Context**: `lavalink`
   - **Instance Type**: Starter / Standard (at least 512MB RAM recommended; 1GB preferred).

### 2. Environment Variables on Render
Configure these environment variables in the Render dashboard for `thor-apex-lavalink`:

| Key | Value | Description |
|---|---|---|
| `PORT` | `2333` | Port Lavalink listens on |
| `LAVALINK_SERVER_PASSWORD` | `<choose-a-strong-secret>` | Authentication password |

### 3. Connect THOR APEX Bot to Lavalink
In your main THOR APEX bot's Render service (or local `.env`), add:

```env
LAVALINK_HOST=thor-apex-lavalink
LAVALINK_PORT=2333
LAVALINK_PASSWORD=<same-strong-secret-chosen-above>
LAVALINK_SECURE=false
```

*Note: In Render internal networking, Private Services resolve by their service name (e.g., `thor-apex-lavalink`) without requiring SSL/TLS (`LAVALINK_SECURE=false`).*
