import type { LoudnessEstimate } from '../../shared/preview-contract';
import { getTrackBlob, MAX_DECODED_BYTES, MAX_TRACK_SECONDS } from './offline';
import { hostedInvalidationEvent, hostedResetKey, hostedUserKey } from './hosted-session';
import type { LoudnessMessage, LoudnessReply } from './loudness.worker';

const DEADLINE_MS = 60000;
const CHUNK_FRAMES = 32768;
const cache = new Map<string, { sha256: string; integratedLufs: number; peakDbfs: number }>();
let queue = Promise.resolve();
let invalidated = false;
let listening = false;
let decoding = false;
let hostedOwner: string | null | undefined;
let active: AbortController | undefined;

function invalidate(): void {
  invalidated = true;
  cache.clear();
  active?.abort(new Error('hosted_session_invalidated'));
}

function captureIdentity(): () => void {
  if (!listening) {
    window.addEventListener(hostedInvalidationEvent, invalidate);
    window.addEventListener('pagehide', invalidate);
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (event.key === null || ((event.key === hostedUserKey || event.key === hostedResetKey) &&
        event.oldValue !== event.newValue)) invalidate();
    });
    listening = true;
  }
  const hosted = import.meta.env.VITE_HOSTED_PILOT === 'true';
  const owner = hosted ? window.localStorage.getItem(hostedUserKey) : null;
  if (hosted && hostedOwner === undefined) hostedOwner = owner;
  return () => {
    if (invalidated || (hosted && (!owner?.trim() || hostedOwner !== owner || window.localStorage.getItem(hostedUserKey) !== owner ||
      window.localStorage.getItem(hostedResetKey) !== null))) {
      invalidate();
      throw new Error('hosted_session_invalidated');
    }
  };
}

async function bounded<Result>(work: Promise<Result>, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

function probe(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TRACK_SECONDS) {
        reject(new Error('audio_duration_limit'));
      } else resolve();
    };
    audio.onerror = () => { cleanup(); reject(new Error('unsupported_audio')); };
    signal.addEventListener('abort', abort, { once: true });
    audio.preload = 'metadata';
    audio.src = url;
  });
}

function recommendLoudness(integratedLufs: number, peakDbfs: number): LoudnessEstimate {
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(peakDbfs)) throw new Error('loudness_no_signal');
  const targetLufs = Math.max(-11, Math.min(-5, integratedLufs));
  const desired = 10 ** ((targetLufs - integratedLufs) / 20);
  const headroom = 10 ** ((-1 - peakDbfs) / 20);
  if (!Number.isFinite(desired) || !Number.isFinite(headroom)) throw new Error('invalid_loudness');
  const recommendedGain = desired > 1 ? Math.max(1, Math.min(1.25, desired, headroom))
    : desired < 1 ? Math.min(desired, headroom) : 1;
  return { integratedLufs, peakDbfs, targetLufs, recommendedGain, limited: recommendedGain < desired,
    clippingRisk: peakDbfs + 20 * Math.log10(recommendedGain) > -1 + 1e-9 };
}

async function estimate(trackId: string, assertIdentity: () => void): Promise<LoudnessEstimate> {
  assertIdentity();
  const controller = new AbortController();
  const { signal } = controller;
  active = controller;
  const timeout = setTimeout(() => controller.abort(new Error('loudness_timeout')), DEADLINE_MS);
  let worker: Worker | undefined;
  const check = () => { signal.throwIfAborted(); assertIdentity(); };
  try {
    const blob = await bounded(getTrackBlob(trackId), signal);
    check();
    if (!blob) { cache.delete(trackId); throw new Error('missing_audio'); }
    if (!blob.size || blob.size > MAX_DECODED_BYTES) throw new Error('audio_byte_limit');
    const bytes = await bounded(blob.arrayBuffer(), signal);
    const digest = await bounded(crypto.subtle.digest('SHA-256', bytes), signal);
    check();
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    const saved = cache.get(trackId);
    if (saved?.sha256 === sha256) return recommendLoudness(saved.integratedLufs, saved.peakDbfs);
    if (decoding) throw new Error('loudness_decoder_busy');
    await probe(blob, signal);
    check();
    const decoder = new OfflineAudioContext(2, 1, 44100);
    decoding = true;
    let decode: Promise<AudioBuffer>;
    try { decode = decoder.decodeAudioData(bytes); }
    catch { decoding = false; throw new Error('unsupported_audio'); }
    const audio = await bounded(decode.then(result => {
      decoding = false;
      return result;
    }, () => {
      decoding = false;
      throw new Error('unsupported_audio');
    }), signal);
    check();
    if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_TRACK_SECONDS) {
      throw new Error('audio_duration_limit');
    }
    if (!Number.isSafeInteger(audio.length) || audio.length <= 0 ||
      !Number.isInteger(audio.numberOfChannels) || audio.numberOfChannels < 1 || audio.numberOfChannels > 2 ||
      audio.length * audio.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
    if (!Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000 ||
      audio.length / audio.sampleRate > MAX_TRACK_SECONDS ||
      Math.abs(audio.duration - audio.length / audio.sampleRate) > 1 / audio.sampleRate) throw new Error('invalid_audio');
    const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
    if (channels.some(samples => samples.length !== audio.length)) throw new Error('invalid_audio');
    worker = new Worker(new URL('./loudness.worker.ts', import.meta.url), { type: 'module' });
    const request = async (message: LoudnessMessage, transfer: Transferable[] = []): Promise<LoudnessReply> => {
      check();
      const reply = await bounded(new Promise<LoudnessReply>((resolve, reject) => {
        worker!.onmessage = (event: MessageEvent<LoudnessReply>) => {
          if (event.data?.kind === 'error') reject(new Error(event.data.error));
          else resolve(event.data);
        };
        worker!.onerror = event => { event.preventDefault(); reject(new Error('loudness_unavailable')); };
        worker!.onmessageerror = () => reject(new Error('invalid_loudness'));
        worker!.postMessage(message, transfer);
      }), signal);
      check();
      return reply;
    };
    const ready = await request({ kind: 'start', frames: audio.length, channels: channels.length, sampleRate: audio.sampleRate });
    if (ready?.kind !== 'ready') throw new Error('invalid_loudness');
    for (let offset = 0; offset < audio.length; offset += CHUNK_FRAMES) {
      await bounded(new Promise<void>(resolve => setTimeout(resolve, 0)), signal);
      check();
      const samples = channels.map(channel => channel.slice(offset, Math.min(audio.length, offset + CHUNK_FRAMES)));
      const reply = await request({ kind: 'samples', offset, samples }, samples.map(channel => channel.buffer));
      if (reply?.kind !== 'ready') throw new Error('invalid_loudness');
    }
    const result = await request({ kind: 'finish' });
    if (result?.kind !== 'result') throw new Error('invalid_loudness');
    const value = recommendLoudness(result.integratedLufs, result.peakDbfs);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(trackId, { sha256, integratedLufs: result.integratedLufs, peakDbfs: result.peakDbfs });
    return { ...value };
  } finally {
    clearTimeout(timeout);
    worker?.terminate();
    if (active === controller) active = undefined;
  }
}

export async function analyzeTrackLoudness(trackId: string): Promise<LoudnessEstimate> {
  if (typeof trackId !== 'string' || !trackId.trim()) throw new Error('invalid_track_id');
  const assertIdentity = captureIdentity();
  assertIdentity();
  const operation = queue.then(() => estimate(trackId, assertIdentity));
  queue = operation.then(() => undefined, () => undefined);
  return operation;
}