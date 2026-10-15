/**
 * High-Resolution Performance & Event-Loop Monitoring System
 *
 * Separates and tracks:
 *  1. Internal Engine Processing Time (Pure bot CPU/cache logic before dispatching response)
 *  2. Interaction Acknowledgement / Deferral Latency
 *  3. Discord HTTPS REST API Network Round-Trip Latency
 *  4. Total End-to-End Command Response Duration
 *  5. Node.js Event Loop Delay Percentiles (p50, p95, p99, max)
 *  6. Memory Profile (RSS, Heap Used/Total) & Error Health
 *
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
const globalInternalLatency = new LatencyRingBuffer(500);
const globalTotalLatency = new LatencyRingBuffer(500);
const globalNetworkLatency = new LatencyRingBuffer(500);

const recentErrors = [];
const MAX_ERRORS = 10;
let totalCommandsExecuted = 0;
let totalErrorsEncountered = 0;

function getCommandMetrics(cmdName) {
  let m = commandMetrics.get(cmdName);
  if (!m) {
    m = {
      internalRing: new LatencyRingBuffer(RING_BUFFER_SIZE),
      totalRing: new LatencyRingBuffer(RING_BUFFER_SIZE),
      networkRing: new LatencyRingBuffer(RING_BUFFER_SIZE),
    };
    commandMetrics.set(cmdName, m);
  }
  return m;
}

/**
 * Records an executed command's metrics with strict separation of internal CPU execution
 * vs Discord REST API network latency and total duration.
 *
 * Supports both invocation styles:
 *  Style A: recordCommandExecution(name, { internalMs, totalMs, networkMs, success, errorMsg })
 *  Style B: recordCommandExecution(name, internalOrTotalMs, ackMs, success, errorMsg)
 */
function recordCommandExecution(commandName, paramA, paramB = 0, paramC = true, paramD = null) {
  totalCommandsExecuted++;

  let internalMs = 0;
  let totalMs = 0;
  let networkMs = 0;
  let success = true;
  let errorMsg = null;

  if (typeof paramA === 'object' && paramA !== null) {
    internalMs = Number(paramA.internalMs || 0);
    totalMs = Number(paramA.totalMs || internalMs);
    networkMs = Number(paramA.networkMs ?? Math.max(0, totalMs - internalMs));
    success = paramA.success !== false;
    errorMsg = paramA.errorMsg || null;
  } else {
    internalMs = Number(paramA || 0);
    const rawVal2 = Number(paramB || 0);
    totalMs = rawVal2 > internalMs ? rawVal2 : internalMs;
    networkMs = Math.max(0, totalMs - internalMs);
    success = paramC !== false;
    errorMsg = paramD || null;
  }

  globalInternalLatency.push(internalMs);
  globalTotalLatency.push(totalMs);
  globalNetworkLatency.push(networkMs);

  const cmd = getCommandMetrics(commandName);
  cmd.internalRing.push(internalMs);
  cmd.totalRing.push(totalMs);
  cmd.networkRing.push(networkMs);

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
 * Returns complete performance snapshot separating internal engine processing
 * from Discord network latency.
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

  // Calculate command stats ranked by internal processing p95
  const commandStats = [];
  for (const [cmd, metrics] of commandMetrics.entries()) {
    const internalStats = metrics.internalRing.getPercentiles();
    const totalStats = metrics.totalRing.getPercentiles();
    const networkStats = metrics.networkRing.getPercentiles();

    commandStats.push({
      command: cmd,
      count: internalStats.count,
      isPreliminary: internalStats.count < 5,
      p50: internalStats.p50,
      p95: internalStats.p95,
      p99: internalStats.p99,
      totalP50: totalStats.p50,
      totalP95: totalStats.p95,
      networkP50: networkStats.p50,
      networkP95: networkStats.p95,
    });
  }
  commandStats.sort((a, b) => b.p95 - a.p95);

  const internalGlobal = globalInternalLatency.getPercentiles();
  const totalGlobal = globalTotalLatency.getPercentiles();
  const networkGlobal = globalNetworkLatency.getPercentiles();

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
      internalLatencyMs: internalGlobal,
      totalLatencyMs: totalGlobal,
      networkLatencyMs: networkGlobal,
      globalLatencyMs: internalGlobal, // Backward-compatibility
      slowestCommands: commandStats.slice(0, 5),
    },
    recentErrors: [...recentErrors],
  };
}

function getCommandStats(commandName) {
  const metrics = commandMetrics.get(commandName);
  if (!metrics) return null;
  const internal = metrics.internalRing.getPercentiles();
  const total = metrics.totalRing.getPercentiles();
  const network = metrics.networkRing.getPercentiles();
  return {
    command: commandName,
    count: internal.count,
    p50: internal.p50,
    p95: internal.p95,
    p99: internal.p99,
    internal,
    total,
    network,
  };
}

module.exports = {
  recordCommandExecution,
  getPerformanceReport,
  getCommandStats,
  LatencyRingBuffer,
};
