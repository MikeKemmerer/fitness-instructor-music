export const MAX_RUNTIME_PCM_BYTES = 256 * 1024 * 1024;
export const RUNTIME_DECODE_TIMEOUT_MS = 30000;
const sources = new Set<() => Iterable<AudioBuffer>>();
let reservedBytes = 0;
let decodeQueue: Promise<void> = Promise.resolve();
let outstanding: { expired: boolean } | null = null;

export function registerRuntimePcm(source: () => Iterable<AudioBuffer>): () => void {
  sources.add(source);
  return () => { sources.delete(source); };
}

export function runtimePcmBytes(): number {
  const buffers = new Set([...sources].flatMap(source => [...source()]));
  return reservedBytes + [...buffers].reduce((bytes, buffer) => bytes + buffer.length * buffer.numberOfChannels * 4, 0);
}

export function estimateRuntimePcm(duration: number, channels = 2, sampleRate = 44100): number {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 360) throw new Error('audio_duration_mismatch');
  return Math.ceil((duration + 0.1) * sampleRate) * channels * 4;
}

export function reserveRuntimePcm(bytes: number): () => void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || runtimePcmBytes() + bytes > MAX_RUNTIME_PCM_BYTES) {
    throw new Error('audio_memory_limit');
  }
  reservedBytes += bytes;
  let released = false;
  return () => {
    if (!released) reservedBytes -= bytes;
    released = true;
  };
}

export function assertRuntimeDecoderAvailable(includePending = false): void {
  if (outstanding && (includePending || outstanding.expired)) throw new Error('audio_decoder_busy');
}

export function decodeRuntimeAudio(
  input: () => Promise<ArrayBuffer>,
  bytes: number,
  sampleRate: number,
  validate: (buffer: AudioBuffer) => void,
  retain: (buffer: AudioBuffer) => void,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  try { assertRuntimeDecoderAvailable(); } catch (error) { return Promise.reject(error); }
  const operation = decodeQueue.then(async () => {
    signal?.throwIfAborted();
    assertRuntimeDecoderAvailable();
    const release = reserveRuntimePcm(bytes);
    const marker = { expired: false };
    outstanding = marker;
    let timer: ReturnType<typeof setTimeout>;
    let expire: () => void;
    const work = (async () => {
      try {
        const encoded = await input();
        if (marker.expired) throw new Error('audio_decode_timeout');
        const decoder = new OfflineAudioContext(2, 1, sampleRate);
        const buffer = await decoder.decodeAudioData(encoded);
        if (marker.expired) throw new Error('audio_decode_timeout');
        validate(buffer);
        if (buffer.length * buffer.numberOfChannels * 4 > bytes) throw new Error('audio_memory_limit');
        release();
        retain(buffer);
        return buffer;
      } finally {
        release();
        if (outstanding === marker) outstanding = null;
      }
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      expire = () => {
        marker.expired = true;
        reject(new Error('audio_decode_timeout'));
      };
      timer = setTimeout(expire, RUNTIME_DECODE_TIMEOUT_MS);
      signal?.addEventListener('abort', expire, { once: true });
      if (signal?.aborted) expire();
    });
    return Promise.race([work, timeout]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', expire);
    });
  });
  decodeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}