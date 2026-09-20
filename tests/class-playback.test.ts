import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { resolve } from 'node:path';

// Vite's /@fs/ route requires forward slashes; resolve() returns backslashes on Windows.
const fsImportPath = (path: string) => resolve(path).replaceAll('\\', '/');
import type * as Offline from '../frontend/src/offline';
import type * as Playback from '../frontend/src/player';
import type * as Routine from '../shared/routine';
import type * as ClassPlan from '../shared/class-plan';

let server: ViteDevServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await createServer({ configFile: resolve('frontend/vite.config.ts'), root: resolve('frontend'),
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'class-audio-test', configureServer(instance) {
      instance.middlewares.use('/class-audio-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><title>Class audio</title><script type="module">
          import * as offline from '/src/offline.ts';
          import * as playback from '/src/player.ts';
          import * as routine from '/@fs/${fsImportPath('shared/routine.ts')}';
          import * as classPlan from '/@fs/${fsImportPath('shared/class-plan.ts')}';
          globalThis.classAudioTest = { ...offline, ...playback, ...routine, ...classPlan };
        </script>`);
      });
    } }] });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto(`${server.resolvedUrls!.local[0]}class-audio-test`);
  await page.waitForFunction(() => 'classAudioTest' in globalThis);
}, 60000);

afterAll(async () => { await browser?.close(); await server?.close(); });

it('renders four class phases through one engine with distinct recorded loops, retained fades and source gains', async () => {
  const result = await page.evaluate(async () => {
    const api = (globalThis as unknown as { classAudioTest: typeof Offline & typeof Playback & typeof Routine & typeof ClassPlan }).classAudioTest;
    const song = await api.storeTrack(new File([api.generateDemoWav(3, 120, 'drums')], 'synthetic-song.wav', { type: 'audio/wav' }));
    const walkOut = await api.storeTrack(new File([api.generateDemoWav(3, 100, 'soft')], 'synthetic-exit.wav', { type: 'audio/wav' }));
    const before = await api.addFillerRecording(new File([api.generateDemoWav(0.5, 80, 'soft')], 'synthetic-before.wav', { type: 'audio/wav' }));
    const after = await api.addFillerRecording(new File([api.generateDemoWav(0.5, 160, 'drums')], 'synthetic-after.wav', { type: 'audio/wav' }));
    const originalContext = globalThis.AudioContext;
    const originalFrame = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    const originalInterval = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const originalFetch = globalThis.fetch;
    const hash = async (id: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await (await api.getTrackBlob(id))!.arrayBuffer()))).join(',');
    const originalHashes = await Promise.all([song.id, walkOut.id, `filler-${before.asset.id}`, `filler-${after.asset.id}`].map(hash));
    globalThis.fetch = async () => { throw new Error('network_forbidden'); };
    const traces: Array<{ phases: string[]; contexts: number; silent: boolean; classElapsed: number }> = [];
    const render = async (gains: number[], duck = false) => {
      const renderer = new OfflineAudioContext(1, 8 * 44100, 44100);
      const suspend = renderer.suspend.bind(renderer);
      const resume = renderer.resume.bind(renderer);
      const checkpoints = [1, 3.75, 4.25, 7.5].map(seconds => suspend(seconds));
      let contexts = 0;
      let frame: FrameRequestCallback | undefined;
      let starts = 0;
      const createSource = renderer.createBufferSource.bind(renderer);
      renderer.createBufferSource = () => {
        const source = createSource();
        const start = source.start.bind(source);
        source.start = (...args) => { starts++; start(...args); };
        return source;
      };
      Object.defineProperties(renderer, { state: { get: () => 'running' }, resume: { value: async () => undefined },
        suspend: { value: async () => undefined }, close: { value: async () => undefined } });
      globalThis.AudioContext = function () { contexts++; return renderer; } as unknown as typeof AudioContext;
      globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
      globalThis.cancelAnimationFrame = () => { frame = undefined; };
      globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
      globalThis.clearInterval = () => undefined;
      const player = api.createPlayer();
      let state: import('../shared/player-contract').PlayerState;
      player.subscribe(value => { state = value; });
      const routine = api.newRoutine();
      routine.tracks = [{ ...song, gain: gains[1], cues: [{ id: 'start', note: 'Routine cue', anchor: { kind: 'timestamp', seconds: 0 }, beep: false }] }];
      routine.filler.mode = 'none';
      routine.beepEvery = routine.beepRemaining = 0;
      const audio: ClassPlan.ClassAudio = {
        crossfade: 0.5,
        before: { mode: 'hold', seconds: 0, sound: 'recording', recording: before, bpm: 200, gain: gains[0] },
        after: { mode: 'hold', seconds: 0, sound: 'recording', recording: after, bpm: 50, gain: gains[2] },
        walkOut: { ...api.newMusicPlaylist(), tracks: [{ ...walkOut, gain: gains[3], cues: [] }] },
      };
      try {
        await player.load(routine, audio);
        const silent = starts === 0;
        player.setVolume(1);
        player.setDucked(duck);
        await player.play();
        const phases = [state!.phase!];
        const rendering = renderer.startRendering();
        await checkpoints[0];
        frame?.(0);
        await player.advance();
        phases.push(state!.phase!);
        await resume();
        await checkpoints[1];
        frame?.(0);
        phases.push(state!.phase!);
        const classElapsed = state!.classElapsed;
        await resume();
        await checkpoints[2];
        frame?.(0);
        await player.advance();
        phases.push(state!.phase!);
        if (state!.classElapsed !== classElapsed) throw new Error('outside_class_clock_moved');
        await resume();
        await checkpoints[3];
        frame?.(0);
        phases.push(state!.phase!);
        await resume();
        traces.push({ phases, contexts, silent, classElapsed });
        return (await rendering).getChannelData(0).slice();
      } finally { player.dispose(); }
    };
    try {
      const isolated: Float32Array[] = [];
      for (let source = 0; source < 4; source++) isolated.push(await render([0, 1, 2, 3].map(index => index === source ? 1 : 0)));
      const gains = [0.2, 0.4, 0.6, 0.8];
      const mixed = await render(gains);
      const ducked = await render(gains, true);
      let difference = 0;
      let duckDifference = 0;
      for (let index = 4410; index < mixed.length; index++) {
        const expected = isolated.reduce((sum, samples, source) => sum + samples[index] * gains[source], 0);
        difference = Math.max(difference, Math.abs(mixed[index] - expected));
        if (index > 44100) duckDifference = Math.max(duckDifference, Math.abs(ducked[index] - mixed[index] * 0.25));
      }
      const peak = (samples: Float32Array, first: number, last: number) => samples.slice(Math.floor(first * 44100), Math.floor(last * 44100))
        .reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
      const peaks = isolated.map((samples, index) => peak(samples, [0.1, 1.1, 3.8, 4.4][index], [0.9, 3.4, 4.1, 6.9][index]));
      const overlapPeaks = [[0, 1, 1.05, 1.45], [1, 2, 3.55, 3.9], [2, 3, 4.3, 4.7]].map(([outgoing, incoming, first, last]) =>
        [peak(isolated[outgoing], first, last), peak(isolated[incoming], first, last)]);
      const hashes = await Promise.all([song.id, walkOut.id, `filler-${before.asset.id}`, `filler-${after.asset.id}`].map(hash));
      return { difference, duckDifference, peaks, overlapPeaks, traces, unchanged: hashes.every((value, index) => value === originalHashes[index]) };
    } finally {
      globalThis.AudioContext = originalContext;
      globalThis.requestAnimationFrame = originalFrame;
      globalThis.cancelAnimationFrame = originalCancel;
      globalThis.setInterval = originalInterval;
      globalThis.clearInterval = originalClear;
      globalThis.fetch = originalFetch;
    }
  });
  expect(result.difference).toBeLessThan(1e-7);
  expect(result.duckDifference).toBeLessThan(1e-7);
  expect(result.unchanged).toBe(true);
  for (const peak of [...result.peaks, ...result.overlapPeaks.flat()]) expect(peak).toBeGreaterThan(0.00001);
  for (const trace of result.traces) {
    expect(trace).toMatchObject({ contexts: 1, silent: true, phases: ['before', 'routine', 'after', 'walk-out', 'finished'] });
    expect(trace.classElapsed).toBeCloseTo(2.5, 2);
  }
}, 60000);