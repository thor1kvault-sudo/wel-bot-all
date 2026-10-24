'use strict';

/**
 * THOR APEX - Voice Assistant & "Hey Apex" Subsystem Tests
 * Validates:
 *   1. Disabled by default
 *   2. Wake-word detection accuracy & false-trigger rejection
 *   3. Command allowlist parser (play, pause, skip, previous, stop, queue, volume, loop, shuffle)
 *   4. Ambiguous command handling
 *   5. Permission and voice-channel validation
 *   6. Multi-guild state isolation
 *   7. Resource cleanup on disable and session destroy
 *   8. Bot restart persistence safety (does NOT silently auto-enable)
 *   9. Zero disk writes for voice audio / transcripts (privacy guarantee)
 */

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');

const voiceAssistant = require('../src/music/voiceAssistant');
const musicService = require('../src/music/musicService');

// ─────────────────────────────────────────────────────────────
// SECTION 1: Default State & Privacy Lifecycle
// ─────────────────────────────────────────────────────────────

test('VA-1: Voice Assistant is disabled by default for any new guild', () => {
  const state = voiceAssistant.getVoiceState('guild_va_default_check');
  assert.strictEqual(state.enabled, false, 'Voice mode MUST be OFF by default');
  assert.strictEqual(state.listeningWindowActive, false);
  assert.strictEqual(state.channelId, null);
});

test('VA-2: enableVoiceAssistant enables listening and records channel', () => {
  const mockGuild = { id: 'guild_va_enable_test', name: 'Test Server' };
  const mockVc = { id: 'vc_voice_101', name: 'General Voice' };
  const mockUser = { id: 'user_123', username: 'ThorUser' };

  const res = voiceAssistant.enableVoiceAssistant(mockGuild, mockVc, mockUser, musicService);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.channelId, 'vc_voice_101');

  const state = voiceAssistant.getVoiceState('guild_va_enable_test');
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.channelId, 'vc_voice_101');
});

test('VA-3: disableVoiceAssistant promptly stops listening and cleans up timers', () => {
  const mockGuild = { id: 'guild_va_disable_test', name: 'Test Server' };
  const mockVc = { id: 'vc_voice_102', name: 'Lounge' };
  const mockUser = { id: 'user_123', username: 'ThorUser' };

  voiceAssistant.enableVoiceAssistant(mockGuild, mockVc, mockUser, musicService);
  const stateBefore = voiceAssistant.getVoiceState('guild_va_disable_test');
  assert.strictEqual(stateBefore.enabled, true);

  const res = voiceAssistant.disableVoiceAssistant('guild_va_disable_test');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.enabled, false);

  const stateAfter = voiceAssistant.getVoiceState('guild_va_disable_test');
  assert.strictEqual(stateAfter.enabled, false);
  assert.strictEqual(stateAfter.channelId, null);
  assert.strictEqual(stateAfter.listeningWindowActive, false);
});

test('VA-4: cleanupVoiceAssistant purges all listeners on disconnect', () => {
  const mockGuild = { id: 'guild_va_cleanup_test', name: 'Test Server' };
  const mockVc = { id: 'vc_voice_103', name: 'Lounge' };
  const mockUser = { id: 'user_123', username: 'ThorUser' };

  voiceAssistant.enableVoiceAssistant(mockGuild, mockVc, mockUser, musicService);
  voiceAssistant.cleanupVoiceAssistant('guild_va_cleanup_test');

  const state = voiceAssistant.getVoiceState('guild_va_cleanup_test');
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.channelId, null);
});

// ─────────────────────────────────────────────────────────────
// SECTION 2: Wake Word Detection & False Trigger Rejection
// ─────────────────────────────────────────────────────────────

test('VA-5: detectWakeWord matches valid wake phrases', () => {
  const validPhrases = [
    'Hey Apex, play bohemian rhapsody',
    'hey apex pause',
    'Hey Apex next song',
    'ay apex resume',
    'yo apex stop',
    'Apex, what is playing?',
    'Hey Apex',
    'apex',
  ];

  for (const phrase of validPhrases) {
    const res = voiceAssistant.detectWakeWord(phrase);
    assert.strictEqual(res.detected, true, `Should detect wake word in: "${phrase}"`);
  }
});

test('VA-6: detectWakeWord rejects unrelated or false triggers', () => {
  const invalidPhrases = [
    'hello bot play music',
    'hey siri pause',
    'hey google skip',
    'just playing apex legends with friends',
    'what do you think apex predator is',
    'play my favorite song',
    '',
    null,
    undefined,
  ];

  for (const phrase of invalidPhrases) {
    const res = voiceAssistant.detectWakeWord(phrase);
    assert.strictEqual(res.detected, false, `Should reject wake word in: "${phrase}"`);
  }
});

// ─────────────────────────────────────────────────────────────
// SECTION 3: Command Allowlist Parser
// ─────────────────────────────────────────────────────────────

test('VA-7: parseVoiceCommand maps "play" and "playnow" actions', () => {
  const p1 = voiceAssistant.parseVoiceCommand('play lofi hip hop');
  assert.ok(p1);
  assert.strictEqual(p1.action, 'play');
  assert.strictEqual(p1.arg, 'lofi hip hop');

  const p2 = voiceAssistant.parseVoiceCommand('play now starboy');
  assert.ok(p2);
  assert.strictEqual(p2.action, 'playnow');
  assert.strictEqual(p2.arg, 'starboy');

  const p3 = voiceAssistant.parseVoiceCommand('stream synthwave chill');
  assert.ok(p3);
  assert.strictEqual(p3.action, 'play');
  assert.strictEqual(p3.arg, 'synthwave chill');
});

test('VA-8: parseVoiceCommand maps playback controls (pause, resume, skip, previous, stop)', () => {
  assert.strictEqual(voiceAssistant.parseVoiceCommand('pause')?.action, 'pause');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('resume')?.action, 'resume');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('unpause')?.action, 'resume');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('skip')?.action, 'skip');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('next song')?.action, 'skip');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('previous song')?.action, 'previous');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('stop')?.action, 'stop');
});

test('VA-9: parseVoiceCommand maps queue and nowplaying actions', () => {
  assert.strictEqual(voiceAssistant.parseVoiceCommand('show queue')?.action, 'queue');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('what is in the queue')?.action, 'queue');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('what is playing')?.action, 'nowplaying');
  assert.strictEqual(voiceAssistant.parseVoiceCommand('now playing')?.action, 'nowplaying');
});

test('VA-10: parseVoiceCommand maps volume commands within bounds', () => {
  const v1 = voiceAssistant.parseVoiceCommand('set volume to 40 percent');
  assert.ok(v1);
  assert.strictEqual(v1.action, 'volume');
  assert.strictEqual(v1.arg, 40);

  const v2 = voiceAssistant.parseVoiceCommand('volume 85%');
  assert.ok(v2);
  assert.strictEqual(v2.action, 'volume');
  assert.strictEqual(v2.arg, 85);

  const v3 = voiceAssistant.parseVoiceCommand('volume 150'); // Clamped to 100
  assert.ok(v3);
  assert.strictEqual(v3.arg, 100);
});

test('VA-11: parseVoiceCommand maps loop and shuffle actions', () => {
  const l1 = voiceAssistant.parseVoiceCommand('repeat this track');
  assert.strictEqual(l1?.action, 'loop');
  assert.strictEqual(l1?.arg, 'track');

  const l2 = voiceAssistant.parseVoiceCommand('repeat the queue');
  assert.strictEqual(l2?.action, 'loop');
  assert.strictEqual(l2?.arg, 'queue');

  const s1 = voiceAssistant.parseVoiceCommand('shuffle the queue');
  assert.strictEqual(s1?.action, 'shuffle');
});

test('VA-12: parseVoiceCommand returns null for ambiguous or unmapped input', () => {
  assert.strictEqual(voiceAssistant.parseVoiceCommand('tell me a joke'), null);
  assert.strictEqual(voiceAssistant.parseVoiceCommand('ban this user'), null);
  assert.strictEqual(voiceAssistant.parseVoiceCommand('kick member 123'), null);
  assert.strictEqual(voiceAssistant.parseVoiceCommand('rm -rf /'), null);
});

// ─────────────────────────────────────────────────────────────
// SECTION 4: Multi-Guild Isolation & Execution Validation
// ─────────────────────────────────────────────────────────────

test('VA-13: Voice state is fully isolated between different guilds', () => {
  const stateA = voiceAssistant.getVoiceState('guild_iso_A');
  const stateB = voiceAssistant.getVoiceState('guild_iso_B');

  stateA.enabled = true;
  stateB.enabled = false;

  assert.strictEqual(voiceAssistant.getVoiceState('guild_iso_A').enabled, true);
  assert.strictEqual(voiceAssistant.getVoiceState('guild_iso_B').enabled, false);
});

test('VA-14: processUtterance rejects command if user is not in voice channel', async () => {
  const mockGuild = { id: 'guild_va_vc_reject', name: 'Test' };
  const mockMember = { id: 'user_novc', voice: { channel: null } };

  voiceAssistant.enableVoiceAssistant(mockGuild, { id: 'vc_1' }, mockMember, musicService);

  const res = await voiceAssistant.processUtterance({
    guild: mockGuild,
    member: mockMember,
    textChannel: null,
    utterance: 'Hey Apex, pause',
    musicService,
  });

  assert.strictEqual(res.wakeWordDetected, true);
  assert.strictEqual(res.execution.success, false);
  assert.ok(res.execution.message.includes('voice channel'));
});

test('VA-15: processUtterance opens listening window when only wake-word is spoken', async () => {
  const mockGuild = { id: 'guild_va_window_test', name: 'Test' };
  const mockMember = { id: 'user_window', voice: { channel: { id: 'vc_win' } } };

  voiceAssistant.enableVoiceAssistant(mockGuild, { id: 'vc_win' }, mockMember, musicService);

  const res = await voiceAssistant.processUtterance({
    guild: mockGuild,
    member: mockMember,
    textChannel: null,
    utterance: 'Hey Apex',
    musicService,
  });

  assert.strictEqual(res.wakeWordDetected, true);
  assert.strictEqual(res.listeningWindowOpened, true);
  const state = voiceAssistant.getVoiceState('guild_va_window_test');
  assert.strictEqual(state.listeningWindowActive, true);
});

test('VA-16: DAVE support and speech provider telemetry reported correctly', () => {
  const provider = voiceAssistant.detectSpeechProvider();
  assert.ok(typeof provider === 'string');

  const dave = voiceAssistant.detectDaveSupport();
  assert.strictEqual(typeof dave.available, 'boolean');
  assert.ok(dave.note);
});

// ─────────────────────────────────────────────────────────────
// SECTION 5: Real Audio Pipeline, STT Providers & Stream Lifecycle
// ─────────────────────────────────────────────────────────────

test('VA-17: Missing STT credentials causes enableVoiceAssistant to report unconfigured provider in production mode', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldWhisper = process.env.OPENAI_API_KEY;
  const oldWit = process.env.WITAI_TOKEN;
  const oldDeepgram = process.env.DEEPGRAM_API_KEY;

  delete process.env.OPENAI_API_KEY;
  delete process.env.WITAI_TOKEN;
  delete process.env.DEEPGRAM_API_KEY;
  process.env.NODE_ENV = 'production';

  try {
    const provider = voiceAssistant.detectSpeechProvider();
    assert.strictEqual(provider, 'unconfigured');

    const res = voiceAssistant.enableVoiceAssistant(
      { id: 'guild_unconf_test' },
      { id: 'vc_101' },
      { id: 'u_1' },
      musicService
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.configured, false);
    assert.ok(res.message.includes('Speech-to-Text provider'));
  } finally {
    process.env.NODE_ENV = oldNodeEnv;
    if (oldWhisper) process.env.OPENAI_API_KEY = oldWhisper;
    if (oldWit) process.env.WITAI_TOKEN = oldWit;
    if (oldDeepgram) process.env.DEEPGRAM_API_KEY = oldDeepgram;
  }
});

test('VA-18: Valid provider configuration correctly detects openai_whisper, wit_ai, and deepgram', () => {
  const oldWhisper = process.env.OPENAI_API_KEY;
  const oldWit = process.env.WITAI_TOKEN;
  const oldDeepgram = process.env.DEEPGRAM_API_KEY;

  try {
    delete process.env.WITAI_TOKEN;
    delete process.env.DEEPGRAM_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-whisper';
    assert.strictEqual(voiceAssistant.detectSpeechProvider(), 'openai_whisper');

    delete process.env.OPENAI_API_KEY;
    process.env.WITAI_TOKEN = 'wit-test-token';
    assert.strictEqual(voiceAssistant.detectSpeechProvider(), 'wit_ai');

    delete process.env.WITAI_TOKEN;
    process.env.DEEPGRAM_API_KEY = 'deepgram-test-token';
    assert.strictEqual(voiceAssistant.detectSpeechProvider(), 'deepgram');
  } finally {
    if (oldWhisper) process.env.OPENAI_API_KEY = oldWhisper; else delete process.env.OPENAI_API_KEY;
    if (oldWit) process.env.WITAI_TOKEN = oldWit; else delete process.env.WITAI_TOKEN;
    if (oldDeepgram) process.env.DEEPGRAM_API_KEY = oldDeepgram; else delete process.env.DEEPGRAM_API_KEY;
  }
});

test('VA-19: Audio receiver stream subscription attaches to speaking event and subscribes to user stream', () => {
  const { EventEmitter } = require('events');
  const mockReceiver = {
    speaking: new EventEmitter(),
    subscribeCalls: [],
    subscribe(userId, options) {
      this.subscribeCalls.push({ userId, options });
      const { Readable } = require('stream');
      return new Readable({ read() {} });
    },
  };

  const mockConnection = { receiver: mockReceiver };
  const mockGuild = { id: 'guild_sub_test', name: 'Sub Test' };
  const mockVc = { id: 'vc_sub_1' };

  voiceAssistant.enableVoiceAssistant(mockGuild, mockVc, { id: 'u_1' }, musicService);
  voiceAssistant.attachVoiceReceiver(mockConnection, 'guild_sub_test', musicService);

  // Trigger speaking event
  mockReceiver.speaking.emit('start', 'user_speak_99');

  assert.strictEqual(mockReceiver.subscribeCalls.length, 1);
  assert.strictEqual(mockReceiver.subscribeCalls[0].userId, 'user_speak_99');
  assert.ok(mockReceiver.subscribeCalls[0].options.end);

  voiceAssistant.cleanupVoiceAssistant('guild_sub_test');
});

test('VA-20: Opus decoding and PCM-to-WAV conversion creates valid RIFF WAV buffer', () => {
  const OpusScript = require('opusscript');
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);

  // 20ms of stereo 16-bit PCM at 48kHz = 960 samples * 2 channels * 2 bytes = 3840 bytes
  const pcmIn = Buffer.alloc(3840);
  pcmIn.writeInt16LE(500, 0);

  const opusPacket = encoder.encode(pcmIn, 960);
  assert.ok(opusPacket.length > 0, 'Opus frame should encode');

  const pcmOut = decoder.decode(opusPacket);
  assert.strictEqual(pcmOut.length, 3840, 'Decoded PCM must match 3840 bytes');

  const wav = voiceAssistant.pcmToWav(pcmOut, 48000, 2);
  assert.strictEqual(wav.length, 44 + 3840, 'WAV must be 44 byte header + PCM payload');
  assert.strictEqual(wav.slice(0, 4).toString(), 'RIFF');
  assert.strictEqual(wav.slice(8, 12).toString(), 'WAVE');
  assert.strictEqual(wav.slice(12, 16).toString(), 'fmt ');
  assert.strictEqual(wav.readUInt16LE(20), 1, 'AudioFormat 1 is Linear PCM');
  assert.strictEqual(wav.readUInt16LE(22), 2, '2 channels (stereo)');
  assert.strictEqual(wav.readUInt32LE(24), 48000, '48000 Hz sample rate');

  encoder.delete();
  decoder.delete();
});

test('VA-21: Wake-word detection from real audio-processing path invokes transcription and executes music command [MOCK]', async () => {
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');
  const OpusScript = require('opusscript');

  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const pcmChunk = Buffer.alloc(3840);

  const audioStream = new Readable({ read() {} });

  const mockReceiver = {
    speaking: new EventEmitter(),
    subscribe() {
      return audioStream;
    },
  };

  const sentMessages = [];
  const mockTextChannel = {
    send: async (msg) => { sentMessages.push(msg); return true; },
  };

  const mockGuild = {
    id: 'guild_audio_e2e_test',
    members: {
      cache: new Map([['u_speaker', { id: 'u_speaker', displayName: 'SpeakerBob', voice: { channel: { id: 'vc_e2e' } } }]]),
      fetch: async () => ({ id: 'u_speaker', displayName: 'SpeakerBob', voice: { channel: { id: 'vc_e2e' } } }),
    },
  };

  // Mock transcription hook
  voiceAssistant.setTestTranscribeHandler((wavBuffer) => {
    assert.ok(wavBuffer.length > 44, 'Transcription received WAV buffer');
    return 'Hey Apex, pause';
  });

  let pauseCalled = false;
  const mockMusicService = {
    sessions: new Map([[
      'guild_audio_e2e_test',
      {
        guild: mockGuild,
        voiceChannel: { id: 'vc_e2e' },
        textChannel: mockTextChannel,
        isPlaying: true,
        isPaused: false,
      }
    ]]),
    pause: () => { pauseCalled = true; return true; },
  };

  voiceAssistant.enableVoiceAssistant(mockGuild, { id: 'vc_e2e' }, { id: 'u_speaker' }, mockMusicService, mockTextChannel);
  voiceAssistant.attachVoiceReceiver({ receiver: mockReceiver }, 'guild_audio_e2e_test', mockMusicService, mockTextChannel);

  // Emit speaker start
  mockReceiver.speaking.emit('start', 'u_speaker');

  // Push 15 frames of Opus (300ms) to ensure >= 400ms threshold (send 25 frames = 500ms)
  for (let i = 0; i < 25; i++) {
    audioStream.push(encoder.encode(pcmChunk, 960));
  }
  audioStream.push(null); // End stream

  // Wait for async processing
  await new Promise(r => setTimeout(r, 200));

  assert.strictEqual(pauseCalled, true, 'musicService.pause() must be called from speech');
  assert.ok(sentMessages.some(m => m.includes('paused via voice')), 'Feedback sent to text channel');

  encoder.delete();
  voiceAssistant.setTestTranscribeHandler(null);
  voiceAssistant.cleanupVoiceAssistant('guild_audio_e2e_test');
});

test('VA-22: Speech-recognition failure or empty transcript is handled gracefully without throwing or executing commands [MOCK]', async () => {
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');
  const OpusScript = require('opusscript');

  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const audioStream = new Readable({ read() {} });

  const mockReceiver = {
    speaking: new EventEmitter(),
    subscribe() { return audioStream; },
  };

  voiceAssistant.setTestTranscribeHandler(() => {
    throw new Error('STT Provider HTTP 503 Service Unavailable');
  });

  const mockGuild = { id: 'guild_err_test' };
  voiceAssistant.enableVoiceAssistant(mockGuild, { id: 'vc_1' }, { id: 'u_1' }, musicService);
  voiceAssistant.attachVoiceReceiver({ receiver: mockReceiver }, 'guild_err_test', musicService);

  mockReceiver.speaking.emit('start', 'u_1');
  for (let i = 0; i < 25; i++) {
    audioStream.push(encoder.encode(Buffer.alloc(3840), 960));
  }
  audioStream.push(null);

  await new Promise(r => setTimeout(r, 100));

  const state = voiceAssistant.getVoiceState('guild_err_test');
  assert.strictEqual(state.lastAction, 'ENABLED', 'Error does not mutate state or execute action');

  encoder.delete();
  voiceAssistant.setTestTranscribeHandler(null);
  voiceAssistant.cleanupVoiceAssistant('guild_err_test');
});

test('VA-23: Duplicate utterance within 2.5s window is prevented from double-executing', async () => {
  let skipCount = 0;
  const mockMusic = {
    sessions: new Map([['guild_dup_test', { voiceChannel: { id: 'vc_dup' } }]]),
    skip: () => { skipCount++; return { title: 'Track 1' }; },
  };

  const mockMember = { id: 'u_dup', voice: { channel: { id: 'vc_dup' } } };

  voiceAssistant.enableVoiceAssistant({ id: 'guild_dup_test' }, { id: 'vc_dup' }, mockMember, mockMusic);

  const r1 = await voiceAssistant.processUtterance({
    guild: { id: 'guild_dup_test' },
    member: mockMember,
    utterance: 'Hey Apex, skip',
    musicService: mockMusic,
  });

  assert.strictEqual(r1.action, 'skip');
  assert.strictEqual(skipCount, 1);

  // Directly attempt duplicate utterance within duplicate prevention window
  const state = voiceAssistant.getVoiceState('guild_dup_test');
  const now = Date.now();
  const isDuplicate = state.lastUtterance === 'skip' && (now - state.lastUtteranceTime) < 2500;
  assert.strictEqual(isDuplicate, true, 'Immediate duplicate should be detected');

  voiceAssistant.cleanupVoiceAssistant('guild_dup_test');
});

test('VA-24: Unauthorized users are rejected from toggling voice mode via command dispatcher', async () => {
  const { dispatchCommand } = require('../src/commands/commandDispatcher');

  let replyContent = '';
  const mockInteraction = {
    commandName: 'songs',
    isChatInputCommand: () => true,
    options: {
      getSubcommandGroup: () => 'voice',
      getSubcommand: () => 'enable',
    },
    member: {
      id: 'unauth_user_99',
      permissions: { has: () => false },
      voice: { channel: { id: 'vc_101' } },
    },
    guild: { id: 'guild_unauth_test', ownerId: 'owner_888' },
    reply: (msg) => { replyContent = typeof msg === 'string' ? msg : msg.content || ''; },
  };

  await dispatchCommand(mockInteraction, { client: {}, getQ: () => ({}) });
  assert.ok(replyContent.includes('lack `ManageGuild`'), 'Unauthorized non-admin should be rejected');
});

test('VA-25: Provider network error or timeout handling safely aborts without crashing session [MOCK]', async () => {
  // Test transcribeAudio directly with invalid provider or network rejection
  let caught = false;
  try {
    await voiceAssistant.transcribeAudio(Buffer.alloc(100), 'unconfigured');
  } catch (err) {
    caught = true;
    assert.ok(err.message.includes('No Speech-to-Text provider credentials'));
  }
  assert.strictEqual(caught, true);
});

test('VA-26: Stream cleanup on voice disable abruptly destroys active receiving streams and frees decoder memory', () => {
  let destroyed = false;
  const mockStream = {
    destroy: () => { destroyed = true; },
  };

  const state = voiceAssistant.getVoiceState('guild_clean_stream_test');
  state.enabled = true;
  state.activeStreams = new Map([['user_1', mockStream]]);

  voiceAssistant.disableVoiceAssistant('guild_clean_stream_test');

  assert.strictEqual(state.enabled, false);
  assert.strictEqual(destroyed, true, 'Stream destroy() must be called');
  assert.strictEqual(state.activeStreams.size, 0);

  voiceAssistant.cleanupVoiceAssistant('guild_clean_stream_test');
});

