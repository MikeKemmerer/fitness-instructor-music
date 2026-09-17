import { guess } from 'web-audio-beat-detector';
import type { BpmEstimate } from '../../shared/preview-contract';
import { validFillerRecording, type FillerRecording } from '../../shared/routine';
import { getFillerRecordingBlob, getTrackBlob, MAX_DECODED_BYTES, MAX_TRACK_SECONDS } from './offline';

let analysisQueue = Promise.resolve();
let audioWorkPending = false;

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

async function audioWork<Result>(work: () => Promise<Result>, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  audioWorkPending = true;
  let pending: Promise<Result>;
  try { pending = work(); }
  catch (error) { audioWorkPending = false; throw error; }
  return bounded(pending.finally(() => { audioWorkPending = false; }), signal);
}

type Candidate = { bpm: number; firstBeat: number; score: number; window: number };

async function estimate(trackId: string, signal: AbortSignal): Promise<BpmEstimate> {
  if (audioWorkPending) throw new Error('bpm_analysis_busy');
  const blob = await bounded(getTrackBlob(trackId), signal);
  if (!blob) throw new Error('missing_audio');
  if (!blob.size || blob.size > MAX_DECODED_BYTES) throw new Error('audio_byte_limit');
  const decoder = new OfflineAudioContext(2, 1, 24000);
  const bytes = await bounded(blob.arrayBuffer(), signal);
  const audio = await audioWork(() => decoder.decodeAudioData(bytes), signal);
  if (!Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > MAX_TRACK_SECONDS) {
    throw new Error('audio_duration_limit');
  }
  if (!Number.isSafeInteger(audio.length) || audio.length <= 0 ||
    !Number.isInteger(audio.numberOfChannels) || audio.numberOfChannels < 1 || audio.numberOfChannels > 2 ||
    audio.length * audio.numberOfChannels * 4 > MAX_DECODED_BYTES) throw new Error('audio_memory_limit');
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000 ||
    Math.abs(audio.duration - audio.length / audio.sampleRate) > 1 / audio.sampleRate) throw new Error('invalid_audio');
  if (audio.duration < 8) throw new Error('bpm_no_beats');
  const stride = Math.max(1, Math.floor(audio.sampleRate * 0.005));
  const peaks = new Float32Array(Math.ceil(audio.length / stride));
  const locations = new Uint32Array(peaks.length);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  for (const samples of channels) {
    if (samples.length !== audio.length) throw new Error('invalid_audio');
    for (let index = 0; index < samples.length; index++) {
      const magnitude = Math.abs(samples[index]);
      if (!Number.isFinite(magnitude)) throw new Error('invalid_audio');
      const bin = Math.floor(index / stride);
      if (magnitude > peaks[bin]) { peaks[bin] = magnitude; locations[bin] = index; }
    }
  }
  const strongest = (grid: number, tolerance: number, start: number, finish: number, threshold: number): number => {
    const first = Math.max(Math.floor(start / stride), Math.floor((grid - tolerance) * audio.sampleRate / stride));
    const last = Math.min(peaks.length - 1, Math.ceil((grid + tolerance) * audio.sampleRate / stride));
    let selected = -1;
    for (let bin = first; bin <= last; bin++) {
      if (locations[bin] < start || locations[bin] >= finish || peaks[bin] < threshold ||
        Math.abs(locations[bin] / audio.sampleRate - grid) > tolerance) continue;
      if (selected < 0 || peaks[bin] > peaks[selected]) selected = bin;
    }
    return selected;
  };
  const windowCount = Math.min(3, Math.max(2, Math.ceil(audio.duration / 20)));
  const windowSeconds = Math.min(20, audio.duration / windowCount);
  const candidates: Candidate[] = [];
  let informativeWindows = 0;
  for (let window = 0; window < windowCount; window++) {
    signal.throwIfAborted();
    const start = Math.round(window * (audio.duration - windowSeconds) / (windowCount - 1) * audio.sampleRate);
    const finish = Math.min(audio.length, start + Math.round(windowSeconds * audio.sampleRate));
    const buffer = decoder.createBuffer(1, finish - start, audio.sampleRate);
    const samples = buffer.getChannelData(0);
    let selectedChannel = channels[0];
    let largestEnergy = 0;
    for (const channel of channels) {
      let energy = 0;
      for (let index = start; index < finish; index++) energy += channel[index] ** 2;
      if (energy > largestEnergy) { largestEnergy = energy; selectedChannel = channel; }
    }
    if (Math.sqrt(largestEnergy / samples.length) < 1e-8) continue;
    samples.set(selectedChannel.subarray(start, finish));
    const renderer = new OfflineAudioContext(1, buffer.length, audio.sampleRate);
    const source = renderer.createBufferSource();
    const filter = renderer.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 240;
    source.buffer = buffer;
    source.connect(filter).connect(renderer.destination);
    source.start();
    const filtered = await audioWork(() => renderer.startRendering(), signal);
    let positivePeak = 0;
    for (const sample of filtered.getChannelData(0)) positivePeak = Math.max(positivePeak, sample);
    if (positivePeak < 1e-10) continue;
    for (let index = 0; index < samples.length; index++) samples[index] *= 0.9 / positivePeak;
    informativeWindows++;
    let windowMaximum = 0;
    for (let bin = Math.floor(start / stride); bin < Math.ceil(finish / stride); bin++) {
      windowMaximum = Math.max(windowMaximum, peaks[bin]);
    }
    for (const settings of [{ minTempo: 40, maxTempo: 220 }, { minTempo: 90, maxTempo: 180 }]) {
      let result;
      try { result = await audioWork(() => guess(buffer, 0, buffer.duration, settings), signal); }
      catch { signal.throwIfAborted(); continue; }
      if (!Number.isFinite(result.bpm) || result.bpm < 40 || result.bpm > 220 ||
        !Number.isFinite(result.offset) || result.offset < 0) continue;
      for (const bpm of [result.bpm, result.bpm / 2, result.bpm * 2]) {
        if (bpm < 40 || bpm > 220) continue;
        const period = 60 / bpm;
        const tolerance = Math.min(0.08, period * 0.15);
        const phases = [result.offset % period];
        if (bpm < result.bpm) phases.push((result.offset + 60 / result.bpm) % period);
        for (const phase of phases) {
          let firstBeat: number | undefined;
          let lastBeat = 0;
          let observed = 0;
          let salience = 0;
          let alignment = 0;
          for (let grid = start / audio.sampleRate + phase; grid < finish / audio.sampleRate; grid += period) {
            const bin = strongest(grid, tolerance, start, finish, windowMaximum * 0.2);
            if (bin < 0) continue;
            const time = locations[bin] / audio.sampleRate;
            firstBeat ??= time;
            lastBeat = time;
            observed++;
            salience += peaks[bin] / windowMaximum;
            alignment += Math.max(0, 1 - (Math.abs(time - grid) / tolerance) ** 2);
          }
          if (firstBeat === undefined || observed < 4) continue;
          const expected = Math.round((lastBeat - firstBeat) / period) + 1;
          const coverage = Math.min(1, observed / expected);
          if (coverage < 0.6) continue;
          let totalEnergy = 0;
          let explainedEnergy = 0;
          for (let bin = Math.floor(firstBeat * audio.sampleRate / stride);
            bin <= Math.min(peaks.length - 1, Math.ceil(lastBeat * audio.sampleRate / stride)); bin++) {
            const energy = peaks[bin] ** 2;
            totalEnergy += energy;
            const distance = Math.abs(locations[bin] / audio.sampleRate - start / audio.sampleRate - phase) % period;
            if (Math.min(distance, period - distance) <= tolerance) explainedEnergy += energy;
          }
          const score = coverage * salience / observed * alignment / observed * Math.sqrt(explainedEnergy / totalEnergy);
          if (Number.isFinite(score) && score > 0.15) candidates.push({ bpm, firstBeat, score, window });
        }
      }
    }
  }
  const ranked = [...new Set(candidates.map(candidate => candidate.bpm))].map(bpm => {
    const bestByWindow = new Map<number, Candidate>();
    for (const candidate of candidates.filter(candidate => Math.abs(candidate.bpm - bpm) < 0.5)) {
      if (candidate.score > (bestByWindow.get(candidate.window)?.score ?? 0)) bestByWindow.set(candidate.window, candidate);
    }
    const matches = [...bestByWindow.values()];
    const period = 60 / bpm;
    const firstBeat = Math.min(...matches.map(candidate => candidate.firstBeat));
    const phaseConsistency = matches.reduce((total, candidate) => {
      const distance = Math.abs(candidate.firstBeat - firstBeat) % period;
      return total + Math.max(0, 1 - Math.min(distance, period - distance) / (period / 2));
    }, 0) / matches.length;
    const support = matches.length / informativeWindows;
    const score = matches.reduce((total, candidate) => total + candidate.score, 0) / matches.length *
      (0.7 + 0.3 * support) * (0.8 + 0.2 * phaseConsistency);
    return { bpm, firstBeat, score, support, phaseConsistency };
  }).sort((first, second) => second.score - first.score ||
    Number(second.bpm >= 90 && second.bpm <= 180) - Number(first.bpm >= 90 && first.bpm <= 180));
  if (!ranked.length) throw new Error('bpm_no_beats');
  const best = ranked[0];
  const period = 60 / best.bpm;
  const tolerance = Math.min(0.08, period * 0.15);
  let firstBeat = best.firstBeat;
  for (let grid = firstBeat % period; grid < firstBeat; grid += period) {
    const start = Math.floor(Math.floor(grid / 20) * 20 * audio.sampleRate);
    const finish = Math.min(audio.length, start + 20 * audio.sampleRate);
    let maximum = 0;
    for (let bin = Math.floor(start / stride); bin < Math.ceil(finish / stride); bin++) maximum = Math.max(maximum, peaks[bin]);
    if (maximum < 1e-10) continue;
    const bin = strongest(grid, tolerance, 0, audio.length, maximum * 0.35);
    if (bin < 0) continue;
    let support = 0;
    for (let beat = 1; beat <= 3; beat++) {
      if (strongest(grid + beat * period, tolerance, 0, audio.length, maximum * 0.35) >= 0) support++;
    }
    if (support >= 2) { firstBeat = locations[bin] / audio.sampleRate; break; }
  }
  const margin = (best.score - (ranked[1]?.score ?? 0)) / best.score;
  const confidence = Math.max(0, Math.min(0.9, best.score * best.support * best.phaseConsistency *
    (0.15 + 0.85 * Math.min(1, margin / 0.25))));
  const alternatives = [...new Set([best.bpm / 2, best.bpm, best.bpm * 2])].filter(bpm => bpm >= 40 && bpm <= 220);
  return { bpm: best.bpm, firstBeat, confidence, alternatives };
}

export function detectTrackBpm(trackId: string): Promise<BpmEstimate> {
  const operation = analysisQueue.then(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('bpm_timeout')), 60000);
    try { return await estimate(trackId, controller.signal); }
    finally { clearTimeout(timeout); }
  });
  analysisQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function detectFillerBpm(recording: FillerRecording): Promise<BpmEstimate> {
  if (!validFillerRecording(recording)) throw new Error('invalid_filler_recording');
  const snapshot = structuredClone(recording);
  if (!await getFillerRecordingBlob(snapshot)) throw new Error('missing_audio');
  return detectTrackBpm(`filler-${snapshot.asset.id}`);
}