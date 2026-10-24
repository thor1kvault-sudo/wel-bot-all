'use strict';

/**
 * THOR APEX — "Hey Apex" Voice Assistant Subsystem
 *
 * Real Audio Receive & Speech-to-Text Pipeline:
 *  - STRICTLY OPT-IN: Disabled by default for all servers.
 *  - PERSISTENCE SAFETY: Does NOT silently re-enable across bot restarts.
 *  - REAL AUDIO RECEIVE: Subscribes to Discord incoming audio via VoiceReceiver.
 *  - REAL OPUS DECODING: Decodes Opus voice frames to 16-bit linear PCM (48kHz stereo) via OpusScript.
 *  - WAV PACKAGING: In-memory transient RIFF WAV container packaging (zero disk writes).
 *  - REAL STT PROVIDER: Real HTTPS transcription via OpenAI Whisper, Wit.ai, or Deepgram.
 *  - HONEST TELEMETRY: If no STT API key is present, disables listening and clearly demands setup.
 *  - PRIVACY & SECURITY: Ephemeral in-memory audio buffers only, instant stream closure on silence/timeout.
 *  - DAVE COMPATIBILITY: Supports Discord end-to-end encryption module where installed.
 *  - UNIFIED EXECUTION: All recognized speech commands route through the single authoritative musicService.
 */

const https = require('https');
const { EndBehaviorType, VoiceConnectionStatus } = require('@discordjs/voice');
const { PermissionsBitField } = require('discord.js');

// Per-guild voice assistant runtime state (in-memory only)
const voiceSessions = new Map();

// Listening window duration after wake word detection (milliseconds)
const LISTENING_WINDOW_MS = 8000;

// Test hook for mocking transcription in automated unit tests
let testTranscribeHandler = null;

function setTestTranscribeHandler(handler) {
  testTranscribeHandler = handler;
}

/**
 * Get or initialize voice assistant state for a guild
 */
function getVoiceState(guildId) {
  if (!voiceSessions.has(guildId)) {
    voiceSessions.set(guildId, {
      guildId,
      enabled: false,
      channelId: null,
      textChannel: null,
      listeningWindowActive: false,
      listeningTimer: null,
      activeSpeakerId: null,
      lastUtterance: null,
      lastUtteranceTime: 0,
      lastAction: null,
      lastActionTime: 0,
      activeStreams: new Map(),
      receiverAttached: false,
      speechProvider: detectSpeechProvider(),
      daveStatus: detectDaveSupport(),
    });
  }
  return voiceSessions.get(guildId);
}

/**
 * Detect available Speech-to-Text provider from environment variables
 */
function detectSpeechProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai_whisper';
  if (process.env.WITAI_TOKEN) return 'wit_ai';
  if (process.env.DEEPGRAM_API_KEY) return 'deepgram';
  if (process.env.NODE_ENV === 'test') return 'mock_test';
  return 'unconfigured';
}

/**
 * Detect DAVE (Discord Audio/Video End-to-End Encryption) compatibility
 */
function detectDaveSupport() {
  try {
    const davey = require('@snazzah/davey');
    return {
      available: true,
      library: '@snazzah/davey',
      version: davey?.version || '0.1.12',
      note: 'DAVE MLS protocol module available for incoming voice decryption',
    };
  } catch (_) {
    return {
      available: false,
      library: null,
      version: null,
      note: 'Native DAVE package not present; voice receive operates on standard Discord RTP channels',
    };
  }
}

/**
 * Packages 16-bit linear PCM audio into a standard RIFF WAV buffer in memory
 * @param {Buffer} pcmBuffer Raw linear PCM samples (16-bit LE)
 * @param {number} sampleRate Sample rate in Hz (default: 48000)
 * @param {number} channels Number of channels (default: 2 for Discord stereo)
 * @returns {Buffer} WAV container buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 48000, channels = 2) {
  if (!pcmBuffer || !Buffer.isBuffer(pcmBuffer)) {
    pcmBuffer = Buffer.alloc(0);
  }
  const header = Buffer.alloc(44);
  const dataSize = pcmBuffer.length;
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);               // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20);                // AudioFormat (1 for PCM)
  header.writeUInt16LE(channels, 22);         // NumChannels
  header.writeUInt32LE(sampleRate, 24);       // SampleRate
  header.writeUInt32LE(byteRate, 28);         // ByteRate
  header.writeUInt16LE(blockAlign, 32);       // BlockAlign
  header.writeUInt16LE(16, 34);               // BitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Transcribes a WAV buffer using OpenAI Whisper API
 */
async function transcribeOpenAIWhisper(wavBuffer, apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const boundary = `----ApexWhisperBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
    `Content-Type: audio/wav\r\n\r\n`
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, wavBuffer, post]);

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(json.error?.message || `Whisper API HTTP ${res.statusCode}`));
          }
          resolve((json.text || '').trim());
        } catch (err) {
          reject(new Error(`Failed to parse Whisper response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Whisper API request timed out (10s)')); });
    req.write(body);
    req.end();
  });
}

/**
 * Transcribes a WAV buffer using Wit.ai Speech API
 */
async function transcribeWitAi(wavBuffer, token = process.env.WITAI_TOKEN) {
  if (!token) throw new Error('Missing WITAI_TOKEN');
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.wit.ai/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'audio/wav',
        'Content-Length': wavBuffer.length,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Wit.ai may return chunks of JSON or a single JSON document
          const lines = data.trim().split('\n').filter(Boolean);
          let text = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const j = JSON.parse(lines[i]);
              if (j.text) { text = j.text; break; }
            } catch (_) {}
          }
          resolve(text.trim());
        } catch (err) {
          reject(new Error(`Failed to parse Wit.ai response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Wit.ai request timed out (10s)')); });
    req.write(wavBuffer);
    req.end();
  });
}

/**
 * Transcribes a WAV buffer using Deepgram API
 */
async function transcribeDeepgram(wavBuffer, apiKey = process.env.DEEPGRAM_API_KEY) {
  if (!apiKey) throw new Error('Missing DEEPGRAM_API_KEY');
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
        'Content-Length': wavBuffer.length,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
          resolve(transcript.trim());
        } catch (err) {
          reject(new Error(`Failed to parse Deepgram response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Deepgram request timed out (10s)')); });
    req.write(wavBuffer);
    req.end();
  });
}

/**
 * Dispatches WAV audio to the active configured STT provider
 */
async function transcribeAudio(wavBuffer, providerOverride = null) {
  const provider = providerOverride || detectSpeechProvider();

  if (provider === 'unconfigured') {
    throw new Error('No Speech-to-Text provider credentials configured in environment (.env).');
  }

  // Test mode mock hook
  if (provider === 'mock_test' || (process.env.NODE_ENV === 'test' && !providerOverride)) {
    if (typeof testTranscribeHandler === 'function') {
      return testTranscribeHandler(wavBuffer);
    }
    return '';
  }

  if (provider === 'openai_whisper') return transcribeOpenAIWhisper(wavBuffer);
  if (provider === 'wit_ai') return transcribeWitAi(wavBuffer);
  if (provider === 'deepgram') return transcribeDeepgram(wavBuffer);

  throw new Error('No Speech-to-Text provider credentials configured in environment (.env).');
}

/**
 * Detects wake-word in an utterance string
 * Returns { detected: boolean, remainingText: string }
 */
function detectWakeWord(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return { detected: false, remainingText: '' };
  }

  const clean = transcript.trim().toLowerCase();
  const wakePatterns = [
    /^(?:hey|ay|yo|ok|hi)\s+apex[,\s]*(.*)$/i,
    /^apex[,\s]+(.*)$/i,
  ];

  for (const pat of wakePatterns) {
    const m = clean.match(pat);
    if (m) {
      return { detected: true, remainingText: (m[1] || '').trim() };
    }
  }

  // Exact wake word with nothing after
  if (/^(?:hey\s+)?apex$/i.test(clean)) {
    return { detected: true, remainingText: '' };
  }

  return { detected: false, remainingText: clean };
}

/**
 * Maps a natural speech phrase to a controlled, validated music command action
 * @param {string} text
 * @returns {{ action: string, arg?: any, confidence: number } | null}
 */
function parseVoiceCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const q = text.toLowerCase().trim();

  // 1. Play Now (urgent jump)
  const playNowMatch = q.match(/^(?:play\s+now|stream\s+now|jump\s+and\s+play)\s+(.+)$/i);
  if (playNowMatch && playNowMatch[1].trim()) {
    return { action: 'playnow', arg: playNowMatch[1].trim(), confidence: 0.95 };
  }

  // 2. Play
  const playMatch = q.match(/^(?:play|start|stream|put\s+on)\s+(.+)$/i);
  if (playMatch && playMatch[1].trim()) {
    return { action: 'play', arg: playMatch[1].trim(), confidence: 0.95 };
  }

  // 3. Pause
  if (/^(?:pause|hold\s+on|stop\s+music\s+temporarily|freeze)$/i.test(q)) {
    return { action: 'pause', confidence: 1.0 };
  }

  // 4. Resume
  if (/^(?:resume|unpause|continue|keep\s+playing)$/i.test(q)) {
    return { action: 'resume', confidence: 1.0 };
  }

  // 5. Skip / Next
  if (/^(?:skip|next|next\s+song|skip\s+song|skip\s+track|next\s+track)$/i.test(q)) {
    return { action: 'skip', confidence: 1.0 };
  }

  // 6. Previous
  if (/^(?:previous|previous\s+song|prev|play\s+previous|go\s+back|replay\s+last)$/i.test(q)) {
    return { action: 'previous', confidence: 1.0 };
  }

  // 7. Stop
  if (/^(?:stop|stop\s+playing|clear\s+and\s+stop|shut\s+down|end\s+playback)$/i.test(q)) {
    return { action: 'stop', confidence: 1.0 };
  }

  // 8. Queue / What's next
  if (/^(?:queue|show\s+queue|what(?:'s|\s+is)\s+in\s+the\s+queue|upcoming\s+songs|view\s+queue)$/i.test(q)) {
    return { action: 'queue', confidence: 0.95 };
  }

  // 9. Now Playing / What's playing
  if (/^(?:what(?:'s|\s+is)\s+playing|now\s+playing|current\s+song|what\s+song\s+is\s+this|info)$/i.test(q)) {
    return { action: 'nowplaying', confidence: 0.95 };
  }

  // 10. Volume Control
  const volMatch = q.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d{1,3})(?:\s*%)?(?:\s+percent)?$/i) ||
                   q.match(/^volume\s+(\d{1,3})$/i);
  if (volMatch) {
    const lvl = parseInt(volMatch[1], 10);
    if (!isNaN(lvl)) {
      return { action: 'volume', arg: Math.max(1, Math.min(100, lvl)), confidence: 0.95 };
    }
  }

  // 11. Loop / Repeat Mode
  if (/^(?:repeat\s+(?:this\s+)?track|loop\s+track|repeat\s+song)$/i.test(q)) {
    return { action: 'loop', arg: 'track', confidence: 0.95 };
  }
  if (/^(?:repeat\s+(?:the\s+)?queue|loop\s+queue|repeat\s+all)$/i.test(q)) {
    return { action: 'loop', arg: 'queue', confidence: 0.95 };
  }
  if (/^(?:repeat\s+off|loop\s+off|disable\s+loop)$/i.test(q)) {
    return { action: 'loop', arg: 'off', confidence: 0.95 };
  }

  // 12. Shuffle
  if (/^(?:shuffle|shuffle\s+(?:the\s+)?queue|mix\s+queue|randomize)$/i.test(q)) {
    return { action: 'shuffle', confidence: 0.95 };
  }

  // Unrecognized or Ambiguous
  return null;
}

/**
 * Enables voice assistant for a guild session
 */
function enableVoiceAssistant(guild, channel, user, musicService, textChannel = null) {
  const provider = detectSpeechProvider();
  if (provider === 'unconfigured' && process.env.NODE_ENV !== 'test') {
    return {
      success: false,
      configured: false,
      message: '⚠️ Voice Assistant requires a configured Speech-to-Text provider in `.env` (`OPENAI_API_KEY`, `WITAI_TOKEN`, or `DEEPGRAM_API_KEY`). Real speech recognition is currently unavailable.',
      speechProvider: 'unconfigured',
    };
  }

  const state = getVoiceState(guild.id);
  const session = musicService?.sessions?.get(guild.id);

  state.enabled = true;
  state.channelId = channel.id;
  state.textChannel = textChannel || session?.textChannel || null;
  state.speechProvider = provider;
  state.lastAction = 'ENABLED';
  state.lastActionTime = Date.now();
  state.activeStreams = state.activeStreams || new Map();

  // Attach audio receiver to active connection if ready
  if (session?.connection && session.connection.state.status === VoiceConnectionStatus.Ready) {
    attachVoiceReceiver(session.connection, guild.id, musicService, state.textChannel);
  }

  return {
    success: true,
    guildId: guild.id,
    channelId: channel.id,
    speechProvider: state.speechProvider,
    daveSupport: state.daveStatus,
  };
}

/**
 * Disables voice assistant for a guild session and cleans up resources
 */
function disableVoiceAssistant(guildId) {
  const state = voiceSessions.get(guildId);
  if (!state) return { success: true, enabled: false };

  state.enabled = false;
  state.channelId = null;
  state.listeningWindowActive = false;
  if (state.listeningTimer) {
    clearTimeout(state.listeningTimer);
    state.listeningTimer = null;
  }
  state.activeSpeakerId = null;
  state.lastAction = 'DISABLED';
  state.lastActionTime = Date.now();

  // Promptly destroy all active receiving streams
  if (state.activeStreams) {
    for (const [userId, stream] of state.activeStreams.entries()) {
      try {
        if (typeof stream.destroy === 'function') stream.destroy();
      } catch (_) {}
    }
    state.activeStreams.clear();
  }

  state.receiverAttached = false;
  return { success: true, enabled: false };
}

/**
 * Full cleanup on bot disconnect or guild session destruction
 */
function cleanupVoiceAssistant(guildId) {
  disableVoiceAssistant(guildId);
  voiceSessions.delete(guildId);
}

/**
 * Attaches real receiver event listeners and Opus decoding pipeline to the active voice connection
 */
function attachVoiceReceiver(connection, guildId, musicService, textChannel = null) {
  const state = getVoiceState(guildId);
  if (!state.enabled || state.receiverAttached || !connection?.receiver) return;

  state.receiverAttached = true;
  state.activeStreams = state.activeStreams || new Map();
  if (textChannel) state.textChannel = textChannel;

  try {
    if (connection.receiver.speaking) {
      connection.receiver.speaking.on('start', (userId) => {
        if (!state.enabled) return;

        // If already listening in window to a specific speaker, preserve focus
        if (state.activeSpeakerId && state.activeSpeakerId !== userId) return;

        // Prevent overlapping active streams for the same user
        if (state.activeStreams.has(userId)) return;

        let opusStream;
        try {
          opusStream = connection.receiver.subscribe(userId, {
            end: {
              behavior: EndBehaviorType.AfterSilence,
              duration: 800,
            },
          });
        } catch (subErr) {
          console.warn(`[THOR-VOICE-ASSISTANT] Failed to subscribe to user ${userId}:`, subErr.message);
          return;
        }

        let decoder;
        try {
          const OpusScript = require('opusscript');
          decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
        } catch (decErr) {
          console.warn(`[THOR-VOICE-ASSISTANT] OpusScript decoder initialization failed:`, decErr.message);
          try { opusStream.destroy(); } catch (_) {}
          return;
        }

        const pcmChunks = [];
        let totalPcmBytes = 0;
        const MAX_BYTES = 48000 * 2 * 2 * 8; // 8 seconds max buffer (~1.53 MB)

        state.activeStreams.set(userId, opusStream);

        const timeoutTimer = setTimeout(() => {
          try { opusStream.destroy(); } catch (_) {}
        }, 10000);

        const cleanupStream = () => {
          clearTimeout(timeoutTimer);
          if (decoder) {
            try { decoder.delete(); } catch (_) {}
            decoder = null;
          }
          state.activeStreams.delete(userId);
        };

        opusStream.on('data', (chunk) => {
          if (totalPcmBytes >= MAX_BYTES) return;
          try {
            const pcm = decoder.decode(chunk);
            if (pcm && pcm.length > 0) {
              pcmChunks.push(pcm);
              totalPcmBytes += pcm.length;
            }
          } catch (_) {}
        });

        opusStream.on('error', () => {
          cleanupStream();
        });

        opusStream.on('end', async () => {
          cleanupStream();

          // Reject audio shorter than 400ms (too short for speech, ambient noise)
          const MIN_BYTES = 48000 * 2 * 2 * 0.4;
          if (totalPcmBytes < MIN_BYTES) return;

          try {
            const wavBuffer = pcmToWav(Buffer.concat(pcmChunks), 48000, 2);
            const transcript = await transcribeAudio(wavBuffer, state.speechProvider);

            if (!transcript || typeof transcript !== 'string' || !transcript.trim()) return;

            // Prevent duplicate execution of identical utterance within 2.5s
            const cleanTranscript = transcript.trim();
            const now = Date.now();
            if (state.lastUtterance === cleanTranscript && (now - state.lastUtteranceTime) < 2500) {
              return;
            }
            state.lastUtterance = cleanTranscript;
            state.lastUtteranceTime = now;

            const session = musicService?.sessions?.get(guildId);
            const guild = session?.guild || { id: guildId };
            const channel = session?.voiceChannel;
            const targetTextChannel = state.textChannel || session?.textChannel;

            let member = null;
            if (guild.members?.cache) {
              member = guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null));
            }
            if (!member) {
              member = {
                id: userId,
                displayName: `User_${userId.slice(-4)}`,
                voice: { channel },
              };
            }

            const res = await processUtterance({
              guild,
              member,
              textChannel: targetTextChannel,
              utterance: cleanTranscript,
              musicService,
            });

            const replyMsg = res?.execution?.message || res?.message;
            if (replyMsg && targetTextChannel && typeof targetTextChannel.send === 'function') {
              await targetTextChannel.send(replyMsg).catch(() => {});
            }
          } catch (sttErr) {
            console.warn(`[THOR-VOICE-ASSISTANT] Speech transcription error in guild ${guildId}:`, sttErr.message);
          }
        });
      });

      connection.receiver.speaking.on('end', (userId) => {
        if (state.activeSpeakerId === userId && !state.listeningWindowActive) {
          state.activeSpeakerId = null;
        }
      });
    }
  } catch (err) {
    console.warn(`[THOR-VOICE-ASSISTANT] Failed to bind receiver in guild ${guildId}:`, err.message);
  }
}

/**
 * Executes a verified voice command using the shared authoritative musicService
 */
async function executeVoiceAction({ guild, member, textChannel, action, arg, musicService }) {
  if (!guild || !member || !musicService) {
    return { success: false, message: 'Missing guild, member, or music engine.' };
  }

  const vc = member.voice?.channel;
  if (!vc) {
    return { success: false, message: 'You must be in the voice channel to give voice commands.' };
  }

  const session = musicService.sessions?.get(guild.id);
  if (session?.voiceChannel && session.voiceChannel.id !== vc.id) {
    return { success: false, message: 'You must be in the same voice channel as the bot.' };
  }

  const user = member.user || { id: member.id, username: member.displayName };

  switch (action) {
    case 'play': {
      if (!arg) return { success: false, message: 'Please specify a song name or URL.' };
      const res = await musicService.enqueueTrack(guild, vc, user, textChannel, arg, { playNow: false });
      if (!res.success) return res;
      return {
        success: true,
        message: res.isPlaylist
          ? `🎵 Added **${res.count}** tracks from **${res.playlistName || 'playlist'}** to queue via voice.`
          : `▶️ Added **${res.firstTrack?.title || arg}** to queue (Position **#${res.position}**) via voice.`,
      };
    }

    case 'playnow': {
      if (!arg) return { success: false, message: 'Please specify a song name or URL.' };
      const res = await musicService.enqueueTrack(guild, vc, user, textChannel, arg, { playNow: true });
      if (!res.success) return res;
      return {
        success: true,
        message: `⚡ Now playing: **${res.firstTrack?.title || arg}** via voice!`,
      };
    }

    case 'pause': {
      const ok = musicService.pause(guild.id);
      return { success: ok, message: ok ? '⏸️ Music paused via voice.' : 'Nothing is currently playing.' };
    }

    case 'resume': {
      const ok = musicService.resume(guild.id);
      return { success: ok, message: ok ? '▶️ Music resumed via voice.' : 'Music is not paused.' };
    }

    case 'skip': {
      const skipped = musicService.skip(guild.id);
      return {
        success: !!skipped,
        message: skipped ? `⏭️ Skipped **${skipped.title}** via voice.` : 'Queue is empty!',
      };
    }

    case 'previous': {
      const prev = musicService.playPrevious(guild.id);
      return {
        success: !!prev,
        message: prev ? `⏮️ Replaying **${prev.title}** via voice.` : 'No previous track in history.',
      };
    }

    case 'stop': {
      musicService.destroySession(guild.id);
      return { success: true, message: '⏹️ Stopped playback and cleared queue via voice.' };
    }

    case 'queue': {
      const s = musicService.sessions?.get(guild.id);
      if (!s || !s.queue || s.queue.length === 0) {
        return { success: true, message: '📋 Queue is currently empty.' };
      }
      const top = s.queue.slice(0, 3).map((t, i) => `${i + 1}. **${t.title}**`).join(', ');
      return {
        success: true,
        message: `📋 Current queue has **${s.queue.length}** tracks: ${top}`,
      };
    }

    case 'nowplaying': {
      const s = musicService.sessions?.get(guild.id);
      if (!s || !s.currentTrack || !s.isPlaying) {
        return { success: true, message: 'Nothing is currently playing.' };
      }
      return {
        success: true,
        message: `🎶 Now playing: **${s.currentTrack.title}** by **${s.currentTrack.artist || 'Unknown'}**.`,
      };
    }

    case 'volume': {
      const actual = musicService.setVolume(guild.id, arg);
      return { success: true, message: `🔊 Volume adjusted to **${actual}%** via voice.` };
    }

    case 'loop': {
      const mode = musicService.setLoop(guild.id, arg);
      return { success: true, message: `🔁 Loop mode set to **${mode.toUpperCase()}** via voice.` };
    }

    case 'shuffle': {
      const count = musicService.shuffle(guild.id);
      return {
        success: count > 0,
        message: count > 0 ? `🔀 Shuffled **${count}** tracks in queue via voice.` : 'Not enough tracks in queue to shuffle.',
      };
    }

    default:
      return { success: false, message: `Unrecognized voice command: "${action}".` };
  }
}

/**
 * Processes an incoming speech utterance for a guild
 * Handles wake-word detection, command window, parsing, and execution
 */
async function processUtterance({ guild, member, textChannel, utterance, musicService }) {
  const state = getVoiceState(guild.id);
  if (!state.enabled) {
    return { ignored: true, reason: 'Voice mode is disabled.' };
  }

  // 1. Wake Word Evaluation
  const wakeResult = detectWakeWord(utterance);
  if (!wakeResult.detected && !state.listeningWindowActive) {
    return { ignored: true, reason: 'Wake word not detected.' };
  }

  let commandText = wakeResult.remainingText;

  // If wake word was detected by itself, open the listening window
  if (wakeResult.detected && !commandText) {
    state.listeningWindowActive = true;
    state.activeSpeakerId = member.id;
    if (state.listeningTimer) clearTimeout(state.listeningTimer);
    state.listeningTimer = setTimeout(() => {
      state.listeningWindowActive = false;
      state.activeSpeakerId = null;
      state.listeningTimer = null;
    }, LISTENING_WINDOW_MS);

    return {
      wakeWordDetected: true,
      listeningWindowOpened: true,
      message: '🎙️ **"Hey Apex" detected!** Listening for music command for 8s...',
    };
  }

  // 2. Parse command
  const parsed = parseVoiceCommand(commandText);
  if (!parsed) {
    return {
      wakeWordDetected: true,
      ambiguous: true,
      message: `❓ Recognized speech: *"${commandText}"*, but no music action matched. Try: *"play <song>"*, *"pause"*, *"skip"*, or *"stop"*.`,
    };
  }

  // Clear listening window since a valid command was received
  state.listeningWindowActive = false;
  state.activeSpeakerId = null;
  if (state.listeningTimer) {
    clearTimeout(state.listeningTimer);
    state.listeningTimer = null;
  }

  // 3. Execute authoritative command
  state.lastUtterance = commandText;
  state.lastUtteranceTime = Date.now();
  state.lastAction = parsed.action;
  state.lastActionTime = Date.now();

  const execResult = await executeVoiceAction({
    guild,
    member,
    textChannel,
    action: parsed.action,
    arg: parsed.arg,
    musicService,
  });

  return {
    wakeWordDetected: true,
    action: parsed.action,
    execution: execResult,
  };
}

module.exports = {
  getVoiceState,
  enableVoiceAssistant,
  disableVoiceAssistant,
  cleanupVoiceAssistant,
  attachVoiceReceiver,
  detectWakeWord,
  parseVoiceCommand,
  executeVoiceAction,
  processUtterance,
  detectSpeechProvider,
  detectDaveSupport,
  pcmToWav,
  transcribeAudio,
  setTestTranscribeHandler,
};
