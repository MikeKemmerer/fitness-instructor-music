import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AAC_IMPORT } from '../shared/audio-import';
import { newRoutine, type Filler } from '../shared/routine';
import { generateDemoWav, generateLoopSamples, MAX_DECODED_BYTES } from '../frontend/src/offline';

const local = vi.hoisted(() => ({ get: vi.fn() }));
const conversion = vi.hoisted(() => vi.fn());
vi.mock('../frontend/src/audio-conversion', () => ({ convertToM4a: conversion }));
vi.mock('../frontend/src/offline', async original => ({
  ...await original<typeof import('../frontend/src/offline')>(), getFillerRecordingBlob: local.get,
}));

const bytes = new Uint8Array(readFileSync(new URL('../frontend/src/assets/loops/lofi-hip-hop-v1.wav', import.meta.url)));
const decoded = { numberOfChannels: 1, sampleRate: 22050, length: 352800, duration: 16 } as AudioBuffer;
const decode = vi.fn();
const fetcher = vi.fn();
const audio = { createBuffer: vi.fn() } as unknown as BaseAudioContext;
const filler = { ...newRoutine().filler, sound: 'lofi' as const };

describe('pinned recorded filler', () => {
  beforeEach(() => {
    vi.resetModules();
    decode.mockReset().mockResolvedValue(decoded);
    fetcher.mockReset().mockImplementation(async () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } }));
    vi.mocked(audio.createBuffer).mockReset();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('location', new URL('https://rehearsal.example/'));
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('pins bounded PCM bytes, duration, channel count and a conditioned boundary', async () => {
    const { LOFI_ASSET } = await import('../frontend/src/filler-audio');
    expect(bytes.length).toBe(LOFI_ASSET.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(LOFI_ASSET.sha256);
    const header = new DataView(bytes.buffer);
    expect(header.getUint16(20, true)).toBe(1);
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint32(24, true)).toBe(22050);
    expect(header.getUint32(40, true) / 2 / 22050).toBe(16);
    expect(Math.abs(header.getInt16(44, true) - header.getInt16(bytes.length - 2, true)) / 32768).toBeLessThan(0.002);
  });

  it.each(['soft', 'bright', 'drums'] as const)('reports %s tempo and exact generated frame duration without fetching audio', async sound => {
    const { getFillerSoundBpm, getFillerSoundDuration } = await import('../frontend/src/filler-audio');
    for (const bpm of [40, 100, 137, 220]) {
      const value = { ...filler, sound, bpm };
      expect(getFillerSoundBpm(value)).toBe(bpm);
      expect(getFillerSoundDuration(value)).toBe(generateLoopSamples(sound, bpm).length / 22050);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([40, 60, 100, 120, 137, 220])('reports measured 120 BPM and unchanged 16-second duration with saved BPM %s', async bpm => {
    const { getFillerSoundBpm, getFillerSoundDuration, LOFI_ASSET } = await import('../frontend/src/filler-audio');
    const saved = { ...filler, bpm, seconds: 99, gain: 0.5 };
    const before = structuredClone(saved);
    expect(LOFI_ASSET.measuredBpm).toBe(120);
    expect(getFillerSoundBpm(saved)).toBe(120);
    expect(getFillerSoundDuration(saved)).toBe(16);
    expect(saved).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(audio.createBuffer).not.toHaveBeenCalled();
  });

  it('shares one verified decode across contexts and saved BPM values without synthesizing', async () => {
    const { getFillerBuffer, LOFI_ASSET } = await import('../frontend/src/filler-audio');
    const buffers = await Promise.all([getFillerBuffer(audio, filler), getFillerBuffer(audio, { ...filler, bpm: 180 })]);
    expect(buffers).toEqual([decoded, decoded]);
    expect(buffers[0]).toBe(buffers[1]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(LOFI_ASSET.url, location.href).href,
      { credentials: 'omit', mode: 'same-origin', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(decode).toHaveBeenCalledOnce();
    expect(audio.createBuffer).not.toHaveBeenCalled();
    expect(() => generateLoopSamples('lofi', 120)).toThrow('filler_requires_recording');
  });

  it('retains only verified source bytes across PCM eviction and offline decodes that detach their input', async () => {
    const { getFillerBuffer, releaseFillerCache, LOFI_ASSET } = await import('../frontend/src/filler-audio');
    const { runtimePcmBytes } = await import('../frontend/src/native-audio');
    decode.mockImplementation(async (source: ArrayBuffer) => {
      expect(source.byteLength).toBe(LOFI_ASSET.bytes);
      expect(createHash('sha256').update(new Uint8Array(source)).digest('hex')).toBe(LOFI_ASSET.sha256);
      const transferred = structuredClone(source, { transfer: [source] });
      expect(source.byteLength).toBe(0);
      new Uint8Array(transferred).fill(0);
      return { ...decoded } as AudioBuffer;
    });
    const first = await getFillerBuffer(audio, filler);
    expect(runtimePcmBytes()).toBe(LOFI_ASSET.frames * 4);
    releaseFillerCache(new Set([first]));
    expect(await getFillerBuffer(audio, filler)).toBe(first);
    fetcher.mockRejectedValue(new Error('offline network forbidden'));
    for (let index = 0; index < 2; index++) {
      releaseFillerCache();
      expect(runtimePcmBytes()).toBe(0);
      expect(await getFillerBuffer(audio, filler)).not.toBe(first);
      expect(runtimePcmBytes()).toBe(LOFI_ASSET.frames * 4);
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledTimes(3);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(LOFI_ASSET.sha256);
    releaseFillerCache();
    expect(runtimePcmBytes()).toBe(0);
  });

  it.each(['soft', 'bright', 'drums'] as const)('preserves saved %s samples exactly', async sound => {
    const copyToChannel = vi.fn();
    vi.mocked(audio.createBuffer).mockReturnValue({ copyToChannel } as unknown as AudioBuffer);
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await getFillerBuffer(audio, { ...filler, sound, bpm: 100 });
    expect(copyToChannel).toHaveBeenCalledWith(generateLoopSamples(sound, 100), 0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects corrupt bytes before decoding and permits a clean retry', async () => {
    const corrupted = bytes.slice();
    corrupted[100] ^= 1;
    fetcher.mockResolvedValueOnce(new Response(corrupted, { headers: { 'Content-Type': 'audio/wav' } }));
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await expect(getFillerBuffer(audio, filler)).rejects.toThrow('filler_integrity_failed');
    expect(decode).not.toHaveBeenCalled();
    await expect(getFillerBuffer(audio, filler)).resolves.toBe(decoded);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledExactlyOnceWith(bytes.buffer);
  });

  it.each(['fetch', 'body'])('times out stalled %s loading and permits a clean retry', async stage => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    vi.useFakeTimers();
    if (stage === 'fetch') fetcher.mockReturnValueOnce(new Promise(() => {}));
    else fetcher.mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { 'Content-Type': 'audio/wav' } }));
    const operation = getFillerBuffer(audio, filler);
    const rejection = expect(operation).rejects.toThrow('filler_timeout');
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    vi.useRealTimers();
    await expect(getFillerBuffer(audio, filler)).resolves.toBe(decoded);
  });

  it('deadlines native lo-fi decoding separately from fetch and keeps its reservation until late settlement', async () => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const { runtimePcmBytes } = await import('../frontend/src/native-audio');
    let finish!: (buffer: AudioBuffer) => void;
    decode.mockReturnValueOnce(new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    const pending = getFillerBuffer(audio, filler);
    const rejection = expect(pending).rejects.toThrow('audio_decode_timeout');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    const bytes = decoded.length * decoded.numberOfChannels * 4;
    expect(runtimePcmBytes()).toBe(bytes);
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    await expect(getFillerBuffer(audio, filler)).rejects.toThrow('audio_decoder_busy');
    expect(decode).toHaveBeenCalledOnce();
    expect(runtimePcmBytes()).toBe(bytes);
    finish(decoded);
    await vi.waitFor(() => expect(runtimePcmBytes()).toBe(0));
    await expect(getFillerBuffer(audio, filler)).resolves.toBe(decoded);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => new Response('missing', { status: 404 }),
    () => new Response(bytes, { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(bytes.slice(0, 100), { headers: { 'Content-Type': 'audio/wav' } }),
    () => new Response(new Uint8Array(bytes.length + 1), { headers: { 'Content-Type': 'audio/wav' } }),
    () => new Response(bytes, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': '999999999' } }),
  ])('blocks missing, wrong-type, truncated or oversized responses before decode', async response => {
    fetcher.mockResolvedValueOnce(response());
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await expect(getFillerBuffer(audio, filler)).rejects.toThrow(/filler_/);
    expect(decode).not.toHaveBeenCalled();
    await expect(getFillerBuffer(audio, filler)).resolves.toBe(decoded);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledExactlyOnceWith(bytes.buffer);
  });

  it.each([{ duration: 99 }, { numberOfChannels: 2 }, { sampleRate: 44100 }, { length: 1 }])(
    'rejects unexpected decoded properties: %j', async properties => {
      decode.mockResolvedValueOnce({ ...decoded, ...properties });
      const { getFillerBuffer } = await import('../frontend/src/filler-audio');
      await expect(getFillerBuffer(audio, filler)).rejects.toThrow('filler_invalid_audio');
    });
});

describe('private custom filler', () => {
  let custom: Filler;
  let blob: Blob;
  const native = { duration: 2, length: 88200, numberOfChannels: 1, sampleRate: 44100 } as AudioBuffer;
  beforeEach(async () => {
    vi.resetModules();
    blob = generateDemoWav(2, 100, 'soft');
    custom = { ...newRoutine().filler, sound: 'recording', recording: {
      id: 'selection', name: 'Synthetic loop', duration: 2,
      asset: { id: 'private-asset', sha256: createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex'),
        bytes: blob.size, contentType: blob.type },
    } };
    local.get.mockReset().mockResolvedValue(blob);
    conversion.mockReset().mockRejectedValue(new Error('conversion_unavailable'));
    decode.mockReset().mockResolvedValue(native);
    fetcher.mockReset().mockRejectedValue(new Error('network forbidden'));
    vi.mocked(audio.createBuffer).mockReset();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('reports immutable recording duration separately from filler timing and leaves tempo unknown', async () => {
    const { getFillerSoundBpm, getFillerSoundDuration } = await import('../frontend/src/filler-audio');
    expect(getFillerSoundDuration({ ...custom, seconds: 99, bpm: 220 })).toBe(2);
    expect(getFillerSoundBpm(custom)).toBeUndefined();
    expect(local.get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shares one native buffer and identical source bytes across audition/rehearsal contexts and saved BPM/gain', async () => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const secondAudio = { createBuffer: vi.fn() } as unknown as BaseAudioContext;
    const buffers = await Promise.all([
      getFillerBuffer(audio, custom), getFillerBuffer(secondAudio, { ...custom, bpm: 220, gain: 0.5 }),
    ]);
    expect(buffers[0]).toBe(native);
    expect(buffers[1]).toBe(buffers[0]);
    const descriptor = custom.recording!;
    expect(await getFillerBuffer(audio, { ...custom, recording: { ...descriptor, asset: {
      contentType: descriptor.asset.contentType, bytes: descriptor.asset.bytes,
      sha256: descriptor.asset.sha256, id: descriptor.asset.id,
    } } })).toBe(native);
    expect(decode).toHaveBeenCalledOnce();
    expect(decode.mock.calls[0][0]).toEqual(await blob.arrayBuffer());
    expect(local.get).toHaveBeenCalledWith(custom.recording);
    expect(fetcher).not.toHaveBeenCalled();
    expect(audio.createBuffer).not.toHaveBeenCalled();
    expect(secondAudio.createBuffer).not.toHaveBeenCalled();
    expect(() => generateLoopSamples('recording', 100)).toThrow('filler_requires_recording');
  });

  it('keeps only the most recent custom decode, replacing it when immutable asset identity changes', async () => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await getFillerBuffer(audio, custom);
    const other = structuredClone(custom);
    other.recording!.asset.id = 'other-asset';
    await getFillerBuffer(audio, other);
    await getFillerBuffer(audio, custom);
    expect(decode).toHaveBeenCalledTimes(3);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses cached AAC bytes for native 44.1 kHz audition and rehearsal without converting, fetching or changing saved tempo', async () => {
    const encoded = new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `anullsrc=sample_rate=${AAC_IMPORT.sampleRate}:channel_layout=mono`, '-t', '2',
      '-c:a', AAC_IMPORT.codec, '-profile:a', AAC_IMPORT.profile, '-b:a', String(AAC_IMPORT.bitRate),
      '-map_metadata', '-1', '-movflags', '+frag_keyframe+empty_moov', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1'],
    { timeout: 15000, maxBuffer: AAC_IMPORT.maxOutputBytes }));
    blob = new Blob([encoded], { type: AAC_IMPORT.contentType });
    custom.recording!.asset = { ...custom.recording!.asset, contentType: blob.type, bytes: blob.size,
      sha256: createHash('sha256').update(encoded).digest('hex') };
    local.get.mockResolvedValue(blob);
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const buffers = await Promise.all([
      getFillerBuffer(audio, custom), getFillerBuffer(audio, { ...custom, bpm: 220, gain: 0.5 }),
    ]);
    expect(buffers).toEqual([native, native]);
    expect(buffers[0]).toMatchObject({ sampleRate: 44100, duration: custom.recording!.duration, length: 88200 });
    expect(decode).toHaveBeenCalledExactlyOnceWith(await blob.arrayBuffer());
    expect(conversion).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(audio.createBuffer).not.toHaveBeenCalled();
  });

  it('rechecks the descriptor on cache hits and fails when local bytes are missing or corrupt', async () => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await getFillerBuffer(audio, custom);
    local.get.mockResolvedValueOnce(undefined);
    await expect(getFillerBuffer(audio, custom)).rejects.toThrow('Synthetic loop (filler-private-asset)');
    expect(decode).toHaveBeenCalledOnce();
    await getFillerBuffer(audio, custom);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['missing', 'name', 'duration', 'hash', 'bytes', 'mime', 'builtin'])(
    'rejects malformed %s metadata before cache lookup without falling back', async defect => {
      if (defect === 'missing') delete custom.recording;
      if (defect === 'name') custom.recording!.name = '';
      if (defect === 'duration') custom.recording!.duration = NaN;
      if (defect === 'hash') custom.recording!.asset.sha256 = 'bad';
      if (defect === 'bytes') custom.recording!.asset.bytes = MAX_DECODED_BYTES + 1;
      if (defect === 'mime') custom.recording!.asset.contentType = 'text/html';
      if (defect === 'builtin') custom.sound = 'soft';
      const { getFillerBuffer } = await import('../frontend/src/filler-audio');
      await expect(getFillerBuffer(audio, custom)).rejects.toThrow('invalid_filler_recording');
      expect(local.get).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(audio.createBuffer).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ duration: 0 }, 'audio_duration_mismatch'], [{ duration: NaN }, 'audio_duration_mismatch'],
    [{ duration: 361 }, 'audio_duration_mismatch'], [{ duration: 2.2 }, 'audio_duration_mismatch'],
    [{ numberOfChannels: 0 }, 'audio_memory_limit'], [{ numberOfChannels: 3 }, 'audio_memory_limit'],
    [{ length: MAX_DECODED_BYTES / 4 + 1 }, 'audio_memory_limit'], [{ length: NaN }, 'audio_memory_limit'],
  ] as const)('rejects decoded %j and permits a clean retry', async (properties, error) => {
    decode.mockResolvedValueOnce({ ...native, ...properties });
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await expect(getFillerBuffer(audio, custom)).rejects.toThrow(error);
    await expect(getFillerBuffer(audio, custom)).resolves.toBe(native);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates native codec failures without synthesis', async () => {
    decode.mockRejectedValueOnce(new Error('unsupported codec'));
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    await expect(getFillerBuffer(audio, custom)).rejects.toThrow('unsupported codec');
    expect(audio.createBuffer).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('holds private native timeout reservation until late %s without a second decoder', async settlement => {
    const { getFillerBuffer, releaseFillerCache } = await import('../frontend/src/filler-audio');
    const { runtimePcmBytes, estimateRuntimePcm } = await import('../frontend/src/native-audio');
    let finish!: (buffer: AudioBuffer) => void;
    let fail!: (error: Error) => void;
    decode.mockReturnValueOnce(new Promise<AudioBuffer>((resolve, reject) => { finish = resolve; fail = reject; }));
    vi.useFakeTimers();
    const pending = getFillerBuffer(audio, custom);
    const rejection = expect(pending).rejects.toThrow('audio_decode_timeout');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    const reserved = estimateRuntimePcm(custom.recording!.duration);
    expect(runtimePcmBytes()).toBe(reserved);
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    releaseFillerCache();
    const other = structuredClone(custom);
    other.recording!.asset.id = 'next-recording';
    await expect(getFillerBuffer(audio, other)).rejects.toThrow('audio_decoder_busy');
    expect(decode).toHaveBeenCalledOnce();
    expect(runtimePcmBytes()).toBe(reserved);
    if (settlement === 'resolve') finish(native);
    else fail(new Error('late_native_failure'));
    await vi.waitFor(() => expect(runtimePcmBytes()).toBe(0));
    await expect(getFillerBuffer(audio, other)).resolves.toBe(native);
    expect(decode).toHaveBeenCalledTimes(2);
    releaseFillerCache();
    expect(runtimePcmBytes()).toBe(0);
  });

  it.each([0, 1, 2])('bounds the complete private filler operation when local read %s stalls', async stage => {
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    let finish!: (blob: Blob) => void;
    for (let index = 0; index < stage; index++) local.get.mockResolvedValueOnce(blob);
    local.get.mockReturnValueOnce(new Promise<Blob>(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    const pending = getFillerBuffer(audio, custom);
    const rejection = expect(pending).rejects.toThrow('audio_decode_timeout');
    await vi.waitFor(() => expect(local.get).toHaveBeenCalledTimes(stage + 1));
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(decode).toHaveBeenCalledTimes(stage === 2 ? 1 : 0);
    finish(blob);
    await vi.advanceTimersByTimeAsync(0);
    expect(decode).toHaveBeenCalledTimes(stage === 2 ? 1 : 0);
    await expect(getFillerBuffer(audio, custom)).resolves.toBe(native);
  });

  it('counts shared cache PCM by identity across contexts and releases only cache-owned references', async () => {
    const { getFillerBuffer, releaseFillerCache } = await import('../frontend/src/filler-audio');
    const { registerRuntimePcm, runtimePcmBytes } = await import('../frontend/src/native-audio');
    const buffer = await getFillerBuffer(audio, custom);
    const unregister = registerRuntimePcm(() => [buffer, buffer]);
    expect(await getFillerBuffer(audio, custom)).toBe(buffer);
    expect(runtimePcmBytes()).toBe(buffer.length * buffer.numberOfChannels * 4);
    releaseFillerCache();
    expect(runtimePcmBytes()).toBe(buffer.length * buffer.numberOfChannels * 4);
    unregister();
    expect(runtimePcmBytes()).toBe(0);
  });

  it('does not release decoded private audio after the account guard invalidates', async () => {
    let finish!: (buffer: AudioBuffer) => void;
    decode.mockReturnValueOnce(new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const result = getFillerBuffer(audio, custom);
    const rejection = expect(result).rejects.toThrow('hosted_session_invalidated');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    local.get.mockRejectedValue(new Error('hosted_session_invalidated'));
    finish(native);
    await rejection;
    await expect(getFillerBuffer(audio, custom)).rejects.toThrow('hosted_session_invalidated');
    local.get.mockResolvedValue(blob);
    await expect(getFillerBuffer(audio, custom)).resolves.toBe(native);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('serializes different custom decodes without retaining the whole library', async () => {
    let finish!: (buffer: AudioBuffer) => void;
    decode.mockReturnValueOnce(new Promise<AudioBuffer>(resolve => { finish = resolve; }));
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const first = getFillerBuffer(audio, custom);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    const other = structuredClone(custom);
    other.recording!.asset.id = 'other-asset';
    const second = getFillerBuffer(audio, other);
    await vi.waitFor(() => expect(local.get).toHaveBeenCalledWith(other.recording));
    expect(decode).toHaveBeenCalledOnce();
    finish(native);
    expect(await Promise.all([first, second])).toEqual([native, native]);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('returns each distinct recording buffer and validates its own descriptor during concurrent requests', async () => {
    const other = structuredClone(custom);
    other.recording!.asset.id = 'second-recording';
    other.recording!.duration = 3;
    const otherBlob = generateDemoWav(3, 100, 'drums');
    other.recording!.asset.bytes = otherBlob.size;
    other.recording!.asset.sha256 = createHash('sha256').update(new Uint8Array(await otherBlob.arrayBuffer())).digest('hex');
    local.get.mockImplementation(async reference => reference.asset.id === 'second-recording' ? otherBlob : blob);
    const secondBuffer = { ...native, duration: 3, length: 132300 } as AudioBuffer;
    decode.mockResolvedValueOnce(native).mockResolvedValueOnce(secondBuffer);
    const { getFillerBuffer } = await import('../frontend/src/filler-audio');
    const [first, second] = await Promise.all([getFillerBuffer(audio, custom), getFillerBuffer(audio, other)]);
    expect(first).toBe(native);
    expect(second).toBe(secondBuffer);
    expect(decode.mock.calls[0][0]).toEqual(await blob.arrayBuffer());
    expect(decode.mock.calls[1][0]).toEqual(await otherBlob.arrayBuffer());
    for (const id of ['private-asset', 'second-recording']) {
      expect(local.get.mock.calls.filter(([reference]) => reference.asset.id === id)).toHaveLength(3);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});