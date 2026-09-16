import loopUrl from './assets/loops/lofi-hip-hop-v1.wav?url';
import { validFillerRecording, type Filler, type FillerRecording } from '../../shared/routine';
import { generateLoopSamples, getFillerRecordingBlob, MAX_DECODED_BYTES, MAX_TRACK_SECONDS } from './offline';
import { assertRuntimeDecoderAvailable, decodeRuntimeAudio, estimateRuntimePcm, registerRuntimePcm, reserveRuntimePcm, RUNTIME_DECODE_TIMEOUT_MS } from './native-audio';

export const LOFI_ASSET = Object.freeze({
  url: loopUrl,
  sha256: '4b4abf4e85b4887714ea58b7f96586f01cd2eeef3a11fb6953960861bb6c3379',
  bytes: 705644, frames: 352800, sampleRate: 22050, channels: 1, seconds: 16,
});

interface CachedFiller {
  key: string;
  promise: Promise<AudioBuffer>;
  buffer?: AudioBuffer;
}

let recordedBuffer: CachedFiller | null = null;
let customBuffer: CachedFiller | null = null;
let verifiedRecordingBytes: ArrayBuffer | null = null;
const requests = new Set<CachedFiller>();
registerRuntimePcm(() => [...requests, recordedBuffer, customBuffer].flatMap(entry => entry?.buffer ? [entry.buffer] : []));

export function releaseFillerCache(keep = new Set<AudioBuffer>()): void {
  if (recordedBuffer?.buffer && !keep.has(recordedBuffer.buffer)) recordedBuffer = null;
  if (customBuffer?.buffer && !keep.has(customBuffer.buffer)) customBuffer = null;
}

async function customRecording(recording: FillerRecording, signal: AbortSignal): Promise<AudioBuffer> {
  const asset = recording.asset;
  const key = JSON.stringify([asset.id, asset.sha256, asset.bytes, asset.contentType, recording.duration]);
  let entry: CachedFiller | undefined;
  try {
    const blob = await getFillerRecordingBlob(recording);
    signal.throwIfAborted();
    if (!blob) throw new Error(`missing_audio: ${recording.name} (filler-${recording.asset.id})`);
    if (!customBuffer || customBuffer.key !== key) {
      customBuffer = null;
      const cached: CachedFiller = { key, promise: Promise.resolve(undefined as unknown as AudioBuffer) };
      const promise = decodeRuntimeAudio(async () => {
        signal.throwIfAborted();
        if (!await getFillerRecordingBlob(recording)) throw new Error('filler_unavailable');
        const bytes = await blob.arrayBuffer();
        signal.throwIfAborted();
        return bytes;
      }, estimateRuntimePcm(recording.duration), 44100, buffer => {
        signal.throwIfAborted();
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > MAX_TRACK_SECONDS ||
          Math.abs(buffer.duration - recording.duration) > 0.1) throw new Error('audio_duration_mismatch');
        if (!Number.isSafeInteger(buffer.length) || buffer.length <= 0 || !Number.isInteger(buffer.numberOfChannels) ||
          buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 ||
          buffer.length * buffer.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
      }, buffer => { cached.buffer = buffer; }, signal);
      cached.promise = promise;
      customBuffer = cached;
      void promise.catch(() => { if (customBuffer?.promise === promise) customBuffer = null; });
    }
    entry = customBuffer;
    requests.add(entry);
    const buffer = await entry.promise;
    signal.throwIfAborted();
    if (!await getFillerRecordingBlob(recording)) throw new Error('filler_unavailable');
    signal.throwIfAborted();
    return buffer;
  } catch (error) {
    if (customBuffer?.key === key) customBuffer = null;
    throw error;
  } finally { if (entry) requests.delete(entry); }
}

async function loadRecording(signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  if (verifiedRecordingBytes) return verifiedRecordingBytes.slice(0);
  const url = new URL(LOFI_ASSET.url, location.href);
  if (url.origin !== location.origin) throw new Error('filler_unavailable');
  const response = await fetch(url.href, { credentials: 'omit', mode: 'same-origin', redirect: 'error', signal });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!response.ok || response.status !== 200 || response.redirected || !['basic', 'default'].includes(response.type) ||
    (response.url && response.url !== url.href) || !/^audio\/(?:wav|wave|x-wav|vnd\.wave)$/i.test(contentType) ||
    !response.body) throw new Error('filler_unavailable');
  const size = response.headers.get('content-length');
  if (size !== null && Number(size) !== LOFI_ASSET.bytes) throw new Error('filler_invalid_audio');
  const bytes = new Uint8Array(LOFI_ASSET.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error('filler_invalid_audio');
      bytes.set(value, offset);
      offset += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (offset !== bytes.length) throw new Error('filler_invalid_audio');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== LOFI_ASSET.sha256) throw new Error('filler_integrity_failed');
  const header = new DataView(bytes.buffer);
  if (header.getUint16(20, true) !== 1 || header.getUint16(22, true) !== LOFI_ASSET.channels ||
    header.getUint32(24, true) !== LOFI_ASSET.sampleRate || header.getUint16(34, true) !== 16 ||
    header.getUint32(40, true) !== LOFI_ASSET.frames * 2) throw new Error('filler_invalid_audio');
  signal.throwIfAborted();
  verifiedRecordingBytes = bytes.buffer;
  return verifiedRecordingBytes.slice(0);
}

export async function getFillerBuffer(audio: BaseAudioContext, filler: Filler): Promise<AudioBuffer> {
  if (filler.sound === 'recording') {
    if (!validFillerRecording(filler.recording)) throw new Error('invalid_filler_recording');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('audio_decode_timeout');
        controller.abort(error);
        reject(error);
      }, RUNTIME_DECODE_TIMEOUT_MS);
    });
    return Promise.race([customRecording(structuredClone(filler.recording), controller.signal), timeout])
      .finally(() => clearTimeout(timer));
  }
  if (filler.recording !== undefined) throw new Error('invalid_filler_recording');
  if (filler.sound !== 'lofi') {
    const release = reserveRuntimePcm(Math.round(22050 * 240 / filler.bpm) * 8);
    try {
      const samples = generateLoopSamples(filler.sound, filler.bpm);
      const buffer = audio.createBuffer(1, samples.length, 22050);
      buffer.copyToChannel(samples, 0);
      return buffer;
    } finally { release(); }
  }
  if (!recordedBuffer) {
    assertRuntimeDecoderAvailable();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('filler_timeout')); }, 15000);
    });
    const cached: CachedFiller = { key: 'lofi', promise: Promise.resolve(undefined as unknown as AudioBuffer) };
    cached.promise = Promise.race([loadRecording(controller.signal), timeout]).finally(() => clearTimeout(timer)).then(bytes =>
      decodeRuntimeAudio(async () => bytes, LOFI_ASSET.frames * LOFI_ASSET.channels * 4, LOFI_ASSET.sampleRate, buffer => {
        if (buffer.numberOfChannels !== LOFI_ASSET.channels || buffer.sampleRate !== LOFI_ASSET.sampleRate ||
          buffer.length !== LOFI_ASSET.frames || !Number.isFinite(buffer.duration) ||
          Math.abs(buffer.duration - LOFI_ASSET.seconds) > 1 / LOFI_ASSET.sampleRate) throw new Error('filler_invalid_audio');
      }, buffer => { cached.buffer = buffer; }));
    recordedBuffer = cached;
    void cached.promise.catch(() => { if (recordedBuffer === cached) recordedBuffer = null; });
  }
  return recordedBuffer.promise;
}