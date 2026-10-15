/**
 * High-Resolution Performance & Event-Loop Monitoring System
 * Tracks internal command latencies (p50, p95, p99), event loop delay, memory, and API overhead.
 * Zero-allocation in hot paths using fixed-capacity circular ring buffers.
 */

const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const os = require('node:os');

// Initialize event loop delay monitor (20ms resolution)
let elHistogram = null;
try {
  elHistogram = monitorEventLoopDelay({ resolution: 20 });
  elHistogram.enable();
} catch (_) {}

// Ring buffer capacity per command
const RING_BUFFER_SIZE = 100;

class LatencyRingBuffer {
  constructor(size = RING_BUFFER_SIZE) {
    this.size = size;
    this.buffer = new Float32Array(size);
    this.pointer = 0;
    this.count = 0;
    this.total = 0;
    this.min = Infinity;
    this.max = 0;
  }

  push(val) {
    if (val < this.min) this.min = val;
    if (val > this.max) this.max = val;
    this.total += val;
    this.buffer[this.pointer] = val;
    this.pointer = (this.pointer + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  getPercentiles() {
    if (this.count === 0) {
      return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, count: 0 };
    }
    const samples = Array.from(this.buffer.subarray(0, this.count)).sort((a, b) => a - b);
    const n = samples.length;
    const getP = (p) => samples[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] || 0;
    return {
      p50: Number(getP(0.50).toFixed(3)),
      p95: Number(getP(0.95).toFixed(3)),
      p99: Number(getP(0.99).toFixed(3)),
      min: Number((samples[0] || 0).toFixed(3)),
      max: Number((samples[n - 1] || 0).toFixed(3)),
      mean: Number((this.total / (this.count || 1)).toFixed(3)),
      count: this.count,
    };
  }
}

// Global metrics state
const commandMetrics = new Map();
const globalLatency = new LatencyRingBuffer(500);
const recentErrors = [];
const MAX_ERRORS = 10;
let totalCommandsExecuted = 0;
let totalErrorsEncountered = 0;

function getCommandRing(cmdName) {
  let ring = commandMetrics.get(cmdName);
  if (!ring) {
    ring = new LatencyRingBuffer(RING_BUFFER_SIZE);
    commandMetrics.set(cmdName, ring);
  }
  return ring;
}

/**
 * Records an executed command's metrics
 */
function recordCommandExecution(commandName, internalMs, ackMs = 0, success = true, errorMsg = null) {
  totalCommandsExecuted++;
  globalLatency.push(internalMs);

  const ring = getCommandRing(commandName);
  ring.push(internalMs);

  if (!success) {
    totalErrorsEncountered++;
    recentErrors.unshift({
      command: commandName,
      error: errorMsg ? String(errorMsg).slice(0, 150) : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
    if (recentErrors.length > MAX_ERRORS) recentErrors.pop();
  }
}

/**
 * Returns complete performance snapshot
 */
function getPerformanceReport(client = null, startTime = Date.now()) {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

  // Event loop delay in milliseconds (from nanoseconds)
  let elDelayP50 = 0;
  let elDelayP95 = 0;
  let elDelayP99 = 0;
  let elDelayMax = 0;
  if (elHistogram) {
    elDelayP50 = Number((elHistogram.percentile(50) / 1e6).toFixed(2));
    elDelayP95 = Number((elHistogram.percentile(95) / 1e6).toFixed(2));
    elDelayP99 = Number((elHistogram.percentile(99) / 1e6).toFixed(2));
    elDelayMax = Number((elHistogram.max / 1e6).toFixed(2));
  }

  // Calculate top slowest commands by p95
  const commandStats = [];
  for (const [cmd, ring] of commandMetrics.entries()) {
    const stats = ring.getPercentiles();
    commandStats.push({ command: cmd, ...stats });
  }
  commandStats.sort((a, b) => b.p95 - a.p95);

  const globalStats = globalLatency.getPercentiles();

  return {
    uptime: uptimeSec,
    wsPing: client?.ws?.ping ?? -1,
    memory: {
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
      heapTotalMB: Math.round(mem.heapTotal / (1024 * 1024)),
    },
    eventLoopDelayMs: {
      p50: elDelayP50,
      p95: elDelayP95,
      p99: elDelayP99,
      max: elDelayMax,
    },
    commands: {
      totalExecuted: totalCommandsExecuted,
      totalErrors: totalErrorsEncountered,
      globalLatencyMs: globalStats,
      slowestCommands: commandStats.slice(0, 5),
    },
    recentErrors: [...recentErrors],
  };
}

function getCommandStats(commandName) {
  const ring = commandMetrics.get(commandName);
  if (!ring) return null;
  return { command: commandName, ...ring.getPercentiles() };
}

module.exports = {
  recordCommandExecution,
  getPerformanceReport,
  getCommandStats,
  LatencyRingBuffer,
};
