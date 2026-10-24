'use strict';

/**
 * Pre-compiled static help catalog & select options
 * Designed for sub-millisecond, zero-allocation command execution in /help.
 */

const STATIC_HELP_CATEGORIES = {
  overview: {
    emoji: '🏠',
    label: 'Overview',
    title: '🏠 THOR APEX — All-in-One Command Centre',
    description:
      '**THOR APEX** is a production-grade, all-in-one Discord bot with **80+ commands** spanning security, moderation, music, welcome, utility, fun and more.\n\n' +
      '**Use the dropdown menu below to explore each category in detail.**\n\n' +
      '📁 **Command Categories:**\n' +
      '> ⚖️ **Moderation** — Warn, timeout, kick, ban, purge & more\n' +
      '> 🛡️ **Security & Anti-Nuke** — Real-time nuke interception & lockdown\n' +
      '> 🤖 **AutoMod** — 12 detection filters with custom punishments\n' +
      '> 📋 **Server Logs** — 14 dedicated event log channels\n' +
      '> 🎉 **Welcome & Goodbye** — Custom welcome cards & departure messages\n' +
      '> 🎵 **Music** — Full music player, queue, radio & Spotify\n' +
      '> 🔧 **Utility & Info** — Ping, uptime, botinfo, userinfo\n' +
      '> 🎮 **Fun & Roleplay** — Minigames, dice, 8-ball, roleplay actions\n' +
      '> 💎 **Economy & Badges** — Points, leaderboard & member badges\n' +
      '> 🌐 **Integrations** — YouTube, Twitch & GitHub alerts\n' +
      '> ⚙️ **Admin & Config** — Server config, modules, maintenance\n' +
      '> 🚀 **Advanced** — AFK, birthdays, translate, VPN check & more',
    color: '#5865F2',
  },
  moderation: {
    emoji: '⚖️',
    label: 'Moderation',
    title: '⚖️ Moderation Commands',
    description:
      '`/warn` — Issue an official warning to a member\n' +
      '`/warnings` — View active warnings for a member\n' +
      '`/clearwarnings` — Clear all warnings for a member\n' +
      '`/timeout` — Timeout a member (e.g. 10m, 1h, 1d)\n' +
      '`/untimeout` — Remove timeout from a member\n' +
      '`/kick` — Kick a member from the server\n' +
      '`/ban` — Ban a user from the server\n' +
      '`/unban` — Unban a user by their User ID\n' +
      '`/softban` — Ban and instantly unban to purge messages\n' +
      '`/purge` — Bulk delete messages (1–100, with filters)\n' +
      '`/slowmode` — Set slowmode delay for a channel\n' +
      '`/lock` — Lock a channel to prevent member messages\n' +
      '`/unlock` — Unlock a previously locked channel\n' +
      '`/nick` — Change a member\'s nickname\n' +
      '`/modlogs` — View moderation history for a member\n' +
      '`/quickmod` — Launch rapid one-click moderation panel',
    color: '#FEE75C',
  },
  security: {
    emoji: '🛡️',
    label: 'Security & Anti-Nuke',
    title: '🛡️ Security & Anti-Nuke Commands',
    description:
      '`/security status` — View current server security and protection status\n' +
      '`/security lockdown` — Restrict configured channels during a security emergency\n' +
      '`/security unlock` — Restore permissions changed by the lockdown system\n' +
      '`/security diagnostics` — View measured internal pipeline latency & telemetry\n' +
      '`/security incidents` — View recent security incident intercept history\n' +
      '`/security audit` — High-level permission hierarchy & health check\n' +
      '`/security test` — Dry-run security notification pipeline safely\n' +
      '`/security antinuke status` — View Anti-Nuke settings and detection health\n' +
      '`/security antinuke configure` — Configure Anti-Nuke thresholds and response actions\n' +
      '`/security antinuke test` — Simulate detection scenario without destructive actions\n' +
      '`/security antimod status|configure|test` — Anti-moderator abuse protection\n' +
      '`/security antiraid status|configure|test` — Anti-raid join flood & risk scoring\n' +
      '`/security trust add|remove|list` — Manage trusted identities exempt from security\n' +
      '`/security config view|reset` — View complete config or reset to factory defaults\n' +
      '`/lockdown` — Quick toggle for server-wide emergency lockdown (on/off)\n' +
      '`/whitelist` — Quick shortcut to manage trusted security identities\n' +
      '`/threat` — Switch server DEFCON threat level (1: Emergency, 2: High, 3: Normal)\n' +
      '`/quarantine` — View and manage quarantined members (status/release)\n' +
      '`/raidmode` — Manual rapid raid defense countermeasures\n' +
      '`/vpncheck` — Analyze account risk score or lookup IP flags',
    color: '#ED4245',
  },
  automod: {
    emoji: '🤖',
    label: 'AutoMod',
    title: '🤖 AutoMod Engine Commands',
    description:
      '`/automod status` — View active AutoMod rules and their settings\n' +
      '`/automod config` — Interactive dashboard to configure spam, mention, link & keyword rules\n' +
      '`/automod enable [rule]` — Enable AutoMod engine or a specific filter rule\n' +
      '`/automod disable [rule]` — Disable AutoMod engine or a specific filter rule\n' +
      '`/automod enableall` — Enable all 12 detection rules at once\n' +
      '`/automod disableall` — Disable all 12 detection rules at once\n' +
      '`/automod whitelist action:add|remove|list` — Manage AutoMod exemptions for users/roles/channels\n' +
      '`/automod blacklist action:add|remove|list` — Manage word blacklist (add/remove/list words)\n' +
      '`/automod test` — Run safe diagnostic & filter simulation without punishing real users\n' +
      '`/automod punishment rule:<rule> action:<action>` — Customize punishment (delete, warn, timeout, kick, ban, log)\n\n' +
      '**Quick Toggle Shortcuts:**\n' +
      '`/antispam` — Toggle rapid message velocity spam filter\n' +
      '`/antilink` — Toggle external URL & link filter\n' +
      '`/antiraid` — Toggle join-flood raid filter\n' +
      '`/altdetection` — Toggle new / unverified account detection\n' +
      '`/wordfilter` — Toggle profanity and word blacklist filter\n\n' +
      '**12 Automated Detection Filters:** Anti-Spam, Duplicate Messages, Mention Spam, @everyone Ping, Discord Invites, External Links, NSFW Links, Word Blacklist, Caps Lock, Emoji Spam, Alt Account Detection, Anti-Raid',
    color: '#57F287',
  },
  logs: {
    emoji: '📋',
    label: 'Server Logs',
    title: '📋 14-Channel Logging System',
    description:
      '`/logs setup` — Auto-create 📁 SERVER LOGS category & 14 dedicated channels\n' +
      '`/logs status` — View all 14 log channel destinations\n' +
      '`/logs configure` — Bind a specific log category to a channel\n' +
      '`/logs test` — Send test embeds to all configured log channels\n' +
      '`/logs disable` — Disable logging for a category or all\n\n' +
      '**14 Dedicated Channels:** Member, Message, Moderation, Security, Anti-Nuke, AutoMod, Role, Channel, Voice, Server Settings, Invite, Webhook, Bot, Welcome',
    color: '#5865F2',
  },
  welcome: {
    emoji: '🎉',
    label: 'Welcome & Goodbye',
    title: '🎉 Welcome & Goodbye System',
    description:
      '`/welcome setup` — Set welcome channel\n' +
      '`/welcome enable` — Enable welcome messages\n' +
      '`/welcome disable` — Disable welcome messages\n' +
      '`/welcome config` — View current welcome card settings\n' +
      '`/welcome test` — Preview welcome card & run diagnostics\n' +
      '`/welcome banner` — Set or sync welcome banner image\n' +
      '`/goodbye setup` — Set goodbye channel\n' +
      '`/goodbye enable` — Enable goodbye messages\n' +
      '`/goodbye disable` — Disable goodbye messages\n' +
      '`/goodbye config` — View goodbye message settings\n' +
      '`/goodbye test` — Preview goodbye message\n\n' +
      '**Customization shortcuts:**\n' +
      '`/setwelcome` `/setleave` `/setrules` `/setroles` `/setgeneral` `/setfun`\n' +
      '`/setedit` `/setgaming` `/setwelcomecolor` `/setwelcometext`\n' +
      '`/setbanner` `/setlogo` `/serverbanner` `/setleavetext` `/setautorole`',
    color: '#EB459E',
  },
  music: {
    emoji: '🎵',
    label: 'Music',
    title: '🎵 Music & Radio System',
    description:
      '`/play` — Play a song from YouTube, Spotify, or SoundCloud\n' +
      '`/playnow` — Play a track immediately at the front of the queue\n' +
      '`/pause` — Pause music playback\n' +
      '`/resume` — Resume music playback\n' +
      '`/skip` — Skip the current song\n' +
      '`/previous` — Play the previous track in history\n' +
      '`/stop` — Stop playback and leave voice channel\n' +
      '`/disconnect` — Leave the voice channel & release resources\n' +
      '`/nowplaying` — Show currently playing track with progress bar\n' +
      '`/search` — Search sources for music tracks (pick from results)\n' +
      '`/queue view` — View current music queue\n' +
      '`/queue remove` — Remove a track from queue\n' +
      '`/queue move` — Move a track position in queue\n' +
      '`/queue jump` — Skip directly to a position in queue\n' +
      '`/queue export` — Export queue as text\n' +
      '`/queue clear` — Clear all upcoming tracks\n' +
      '`/shuffle` — Shuffle the music queue\n' +
      '`/loop` — Set repeat mode (off/track/queue)\n' +
      '`/volume` — Adjust music volume (1–100)\n' +
      '`/seek` — Seek to a playback position (e.g. 1:30 or 90s)\n' +
      '`/songs playback panel` — Launch the interactive Music Control Centre\n' +
      '`/songs playback history` — View recently played tracks history\n' +
      '`/songs voice enable|disable|status` — "Hey Apex" opt-in voice assistant controls\n' +
      '`/songs favorites add|remove|list|play` — Personal library & favorites\n' +
      '`/radio` — Play 24/7 radio stream (Lofi, Gaming, Pop, Chill)\n' +
      '`/lyrics` — Search real-time lyrics for any song\n' +
      '`/musicstatus` — Music engine & voice connection diagnostics\n' +
      '`/musicupdate status` — Music engine health & dependency versions\n' +
      '`/musicupdate check` — Check for compatible library updates\n' +
      '`/musicupdate logs` — View playback incidents & self-healing logs\n' +
      '`/musicupdate repair` — Reinitialize & repair music subsystem\n' +
      '`/musicupdate apply` — Review update status & deployment info',
    color: '#1DB954',
  },
  utility: {
    emoji: '🔧',
    label: 'Utility & Info',
    title: '🔧 Utility & Information Commands',
    description:
      '`/ping` — Check bot heartbeat latency & gateway ping\n' +
      '`/uptime` — Check bot continuous running time & process health\n' +
      '`/botinfo` — View bot statistics, runtime, memory & architecture\n' +
      '`/serverinfo` — View server statistics, security level & member counts\n' +
      '`/userinfo` — View member profile, roles, creation date & join position\n' +
      '`/permissions` — Inspect bot and member permissions\n' +
      '`/help` — Display this comprehensive command guide\n' +
      '`/myinvites` — Check your total server invites\n' +
      '`/invites` — Check server invites for a user\n' +
      '`/invitetop` — Top inviters leaderboard\n' +
      '`/translate` — Translate text into another language\n' +
      '`/panel` — Open the THOR APEX interactive admin control centre',
    color: '#5865F2',
  },
  fun: {
    emoji: '🎮',
    label: 'Fun & Roleplay',
    title: '🎮 Fun, Minigames & Roleplay',
    description:
      '**🎲 Minigames:**\n' +
      '`/fun coinflip` — Flip a fair coin (Heads or Tails)\n' +
      '`/fun dice` — Roll dice (customizable sides)\n' +
      '`/fun 8ball` — Ask the Magic 8-Ball a question\n' +
      '`/fun rps` — Play Rock, Paper, Scissors\n\n' +
      '**🎭 Roleplay Actions:**\n' +
      '`/roleplay hug` — Give a member a warm hug\n' +
      '`/roleplay pat` — Gently pat a member on the head\n' +
      '`/roleplay slap` — Playfully slap a member\n' +
      '`/roleplay highfive` — High five a member\n' +
      '`/roleplay wave` — Wave hello to a member',
    color: '#EB459E',
  },
  economy: {
    emoji: '💎',
    label: 'Economy & Badges',
    title: '💎 Points Economy & Member Badges',
    description:
      '**💰 Points Economy:**\n' +
      '`/points check` — Check points balance (yours or another member)\n' +
      '`/points give` — Award points to a member\n' +
      '`/points take` — Deduct points from a member\n' +
      '`/points leaderboard` — View top 10 members with highest points\n' +
      '`/points reset` — Reset points for a user or entire server\n\n' +
      '**🏅 Member Badges:**\n' +
      '`/badge give` — Award a custom badge to a member (🏆 ⭐ 🛡️ 💎)\n' +
      '`/badge remove` — Remove a badge from a member\n' +
      '`/badge list` — View all badges of a member',
    color: '#FEE75C',
  },
  integrations: {
    emoji: '🌐',
    label: 'Integrations',
    title: '🌐 External Service Integrations',
    description:
      '`/integration youtube` — Add YouTube channel upload alerts\n' +
      '`/integration twitch` — Add Twitch stream live alerts\n' +
      '`/integration github` — Add GitHub repository release/commit alerts\n' +
      '`/integration list` — List active external integrations\n' +
      '`/integration remove` — Remove an external integration\n\n' +
      '**Feeds are sent to your chosen existing text channels — no extra channels created!**',
    color: '#7289DA',
  },
  admin: {
    emoji: '⚙️',
    label: 'Admin & Config',
    title: '⚙️ Administration & Server Configuration',
    description:
      '`/setup` — One-click auto-setup: log channels & configuration\n' +
      '`/serverconfig view` — Master dashboard of all active modules\n' +
      '`/serverconfig export` — Export server settings as JSON\n' +
      '`/serverconfig reset` — Reset a module to factory defaults\n' +
      '`/module enable` — Enable a specific feature module\n' +
      '`/module disable` — Disable a specific feature module\n' +
      '`/module list` — Display status of all modules\n' +
      '`/maintenance enable` — Enable bot maintenance mode\n' +
      '`/maintenance disable` — Disable maintenance mode\n' +
      '`/maintenance status` — Check maintenance mode status\n' +
      '`/clone export` — Export config as a portable template token\n' +
      '`/clone import` — Import config template into this server\n' +
      '`/nightmode setup` — Configure nightmode quiet hours\n' +
      '`/nightmode toggle` — Enable or disable nightmode schedule\n' +
      '`/nightmode status` — View current nightmode config\n' +
      '`/devmode stats` — CPU, memory, uptime, latency & cache metrics\n' +
      '`/devmode diagnostics` — System integrity & permission verification\n' +
      '`/devmode simulate` — Simulate security workflows safely\n' +
      '`/dm user` — Send official staff DM to a user\n' +
      '`/dm role` — Send official DM to all members of a role',
    color: '#99AAB5',
  },
  advanced: {
    emoji: '🚀',
    label: 'Advanced Features',
    title: '🚀 Advanced Suite Commands',
    description:
      '`/afk set` — Set your AFK status with a custom message\n' +
      '`/afk clear` — Clear your AFK status\n' +
      '`/afk status` — Check a member\'s AFK status\n' +
      '`/birthday set` — Set your birthday\n' +
      '`/birthday check` — Check a member\'s birthday\n' +
      '`/birthday upcoming` — View upcoming birthdays in the next 30 days\n' +
      '`/birthday channel` — Set birthday announcement channel\n' +
      '`/appeal submit` — Submit an unban/punishment appeal\n' +
      '`/appeal status` — Check your appeal status\n' +
      '`/appeal review` — Staff decision on an appeal\n' +
      '`/appeal setup` — Configure appeal notifications channel\n' +
      '`/serverstat setup` — Setup voice stat counter channels\n' +
      '`/serverstat update` — Refresh voice stat counters now\n' +
      '`/serverstat disable` — Remove voice stat channels',
    color: '#9B59B6',
  },
};

const STATIC_HELP_CATEGORY_COUNT = Object.keys(STATIC_HELP_CATEGORIES).length - 1;

const STATIC_HELP_SELECT_OPTIONS = Object.entries(STATIC_HELP_CATEGORIES).map(([key, cat]) => ({
  label: cat.label,
  value: `help_${key}`,
  description: cat.title.replace(/^[^\s]+\s/, '').slice(0, 100),
  emoji: cat.emoji,
  default: key === 'overview',
}));

module.exports = {
  STATIC_HELP_CATEGORIES,
  STATIC_HELP_CATEGORY_COUNT,
  STATIC_HELP_SELECT_OPTIONS,
};
