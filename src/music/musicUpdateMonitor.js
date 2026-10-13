const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');

// In-memory audit log and incident recorder
const incidentLogs = [];
const MAX_LOGS = 50;

/**
 * Records an event into the music subsystem audit log
 */
function logIncident(level, action, message, metadata = {}) {
  const entry = {
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    level, // 'INFO' | 'WARN' | 'ERROR' | 'RECOVERY'
    action,
    message,
    metadata,
  };
  incidentLogs.unshift(entry);
  if (incidentLogs.length > MAX_LOGS) incidentLogs.pop();
  return entry;
}

/**
 * Gets recent music subsystem incident logs
 */
function getRecentLogs(limit = 15) {
  return incidentLogs.slice(0, limit);
}

/**
 * Queries the official NPM registry API for the latest published package version
 */
function fetchNpmVersion(pkgName) {
  return new Promise((resolve) => {
    https.get(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, {
      headers: { 'User-Agent': 'THOR-APEX-Bot-Update-Checker/2.0' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json['dist-tags']?.latest || null);
        } catch (_) { resolve(null); }
      });
    }).on('error', () => resolve(null))
      .on('timeout', function() { this.destroy(); resolve(null); });
  });
}

/**
 * Inspects local package.json to get currently installed versions
 */
function getInstalledVersions() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.dependencies || {};
    }
  } catch (_) {}
  return {};
}

/**
 * Checks trusted package registry for updates to critical audio packages
 */
async function checkForDependencyUpdates() {
  const installed = getInstalledVersions();
  const targetPackages = ['@discordjs/voice', 'play-dl', 'ffmpeg-static', 'discord.js'];
  const report = [];

  for (const pkg of targetPackages) {
    const currentRaw = installed[pkg] || 'Not Installed';
    const current = currentRaw.replace(/^[\^~]/, '');
    const latest = await fetchNpmVersion(pkg);

    const hasUpdate = latest && current !== 'Not Installed' && latest !== current;
    report.push({
      package: pkg,
      current,
      latest: latest || 'Unable to check',
      hasUpdate: !!hasUpdate,
      status: hasUpdate ? 'Update Available' : 'Up to Date',
    });
  }

  logIncident('INFO', 'UPDATE_CHECK', `Checked ${targetPackages.length} dependencies against npm registry`);
  return report;
}

/**
 * Comprehensive health report of active music sessions and resources
 */
function getSystemHealth(musicSessions) {
  const sessionList = Array.from(musicSessions.values());
  const activeCount = sessionList.filter(s => s.isPlaying).length;
  const pausedCount = sessionList.filter(s => s.isPaused).length;
  const totalQueued = sessionList.reduce((acc, s) => acc + (s.queue?.length || 0), 0);
  const mem = process.memoryUsage();

  return {
    uptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: `${os.platform()} (${os.arch()})`,
    memoryRssMb: Math.round(mem.rss / 1024 / 1024),
    memoryHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
    totalSessions: sessionList.length,
    activePlayingSessions: activeCount,
    pausedSessions: pausedCount,
    totalQueuedTracks: totalQueued,
    voiceConnectionsReady: sessionList.filter(s => s.connection?.state?.status === 'ready').length,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  logIncident,
  getRecentLogs,
  checkForDependencyUpdates,
  getSystemHealth,
  getInstalledVersions,
};
