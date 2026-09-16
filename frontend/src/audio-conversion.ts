import { AAC_IMPORT } from '../../shared/audio-import';
import coreURL from './assets/codecs/ffmpeg-audio-core.js?url';
import wasmURL from './assets/codecs/ffmpeg-audio-core.wasm?url';
import type { ConversionReply } from './audio-conversion.worker';

let queue: Promise<void> = Promise.resolve();
const TOTAL_TIMEOUT_MS = 300_000;

export function convertToM4a(file: File, options?: { signal?: AbortSignal }): Promise<{ blob: Blob; duration: number }> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(new Error('conversion_aborted'));
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return Promise.reject(new Error('conversion_invalid_audio'));
  if (file.size > AAC_IMPORT.maxSourceBytes) return Promise.reject(new Error('conversion_source_limit'));
  const predecessor = queue;
  let release!: () => void;
  queue = new Promise<void>(resolve => { release = resolve; });
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: string, result?: { blob: Blob; duration: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      worker = undefined;
      void predecessor.then(release);
      if (error) reject(new Error(error));
      else resolve(result!);
    };
    const abort = () => finish('conversion_aborted');
    const timer = setTimeout(() => finish('conversion_timeout'), TOTAL_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    void predecessor.then(() => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      try {
        worker = new Worker(new URL('./audio-conversion.worker.ts', import.meta.url), { type: 'module' });
        worker.onerror = event => { event.preventDefault(); finish('conversion_worker_failed'); };
        worker.onmessageerror = () => finish('conversion_worker_failed');
        worker.onmessage = ({ data }: MessageEvent<ConversionReply>) => {
          if (data.kind === 'error') { finish(data.error); return; }
          if (data.kind !== 'complete' || !(data.bytes instanceof ArrayBuffer)
            || data.bytes.byteLength <= 0 || data.bytes.byteLength > AAC_IMPORT.maxOutputBytes
            || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > AAC_IMPORT.maxDuration) {
            finish('conversion_invalid_output'); return;
          }
          finish(undefined, { blob: new Blob([data.bytes], { type: AAC_IMPORT.contentType }), duration: data.duration });
        };
        worker.postMessage({ blob: file.slice(0, file.size), coreURL, wasmURL });
      } catch { finish('conversion_unavailable'); }
    });
  });
}