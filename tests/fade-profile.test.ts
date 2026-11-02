import { describe, expect, it } from 'vitest';
import { analyzeFadeProfile, sweetTransition, validFadeProfile, type FadeProfile } from '../frontend/src/fade-profile';

const rate = 8000;
function song(seconds: number, level: (time: number) => number): Float32Array[] {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let index = 0; index < samples.length; index++) {
    const time = index / rate;
    samples[index] = level(time) * Math.sin(2 * Math.PI * 220 * time);
  }
  return [samples, samples.slice()];
}
const profile = (start: number[], end: number[]): FadeProfile => ({ v: 1, step: 0.1, start, end });

describe('fade profile analysis', () => {
  it('measures a fade-out and leading silence relative to the body level', () => {
    // 1 s silence, 50 s at full level, 8 s linear fade, 3 s silence.
    const result = analyzeFadeProfile(song(62, time => time < 1 ? 0 : time < 51 ? 0.5 : time < 59 ? 0.5 * (59 - time) / 8 : 0), rate);
    expect(validFadeProfile(result)).toBe(true);
    expect(result.start[0]).toBeLessThan(-45);
    expect(result.start[20]).toBeGreaterThan(-1);
    expect(result.end[0]).toBeLessThan(-45);
    expect(result.end[120]).toBeGreaterThan(-1);
    const quiet = result.end.findIndex(level => level >= -18);
    expect(quiet * 0.1).toBeGreaterThan(3);
    expect(quiet * 0.1).toBeLessThan(5);
  });

  it('rejects malformed stored profiles', () => {
    expect(validFadeProfile({ v: 1, step: 0.1, start: [0], end: [Number.NaN] })).toBe(false);
    expect(validFadeProfile({ v: 2, step: 0.1, start: [0], end: [0] })).toBe(false);
    expect(validFadeProfile(null)).toBe(false);
  });
});

describe('sweet transitions', () => {
  const loudStart = profile([0, ...Array(100).fill(0)], [0]);

  it('cuts a quiet tail and overlaps the natural fade-out up to the longest fade', () => {
    const tail = [...Array(60).fill(-30), ...Array(60).fill(-10), ...Array(100).fill(0)];
    const result = sweetTransition({ duration: 200, profile: profile([0], tail) }, { duration: 180, profile: loudStart }, 4);
    expect(result.cut).toBeCloseTo(194);
    expect(result.fade).toBe(4);
    expect(result.lead).toBe(0);
  });

  it('uses a short blend for an abrupt ending and skips the next song leading silence', () => {
    const result = sweetTransition({ duration: 200, profile: profile([0], [-60, ...Array(100).fill(0)]) },
      { duration: 180, profile: profile([...Array(15).fill(-60), ...Array(100).fill(0)], [0]) }, 8);
    expect(result.cut).toBeCloseTo(199.9);
    expect(result.fade).toBe(0.5);
    expect(result.lead).toBeCloseTo(1.5);
  });

  it('lets a quiet intro play under the outgoing song for up to half the longest fade', () => {
    const intro = [...Array(60).fill(-12), ...Array(100).fill(0)];
    const result = sweetTransition({ duration: 200, profile: profile([0], Array(100).fill(0)) },
      { duration: 180, profile: profile(intro, [0]) }, 8);
    expect(result.fade).toBe(4);
  });

  it('never cuts before the last cue or more than 30 seconds', () => {
    const silentTail = Array(450).fill(-60);
    expect(sweetTransition({ duration: 200, profile: profile([0], silentTail) }, { duration: 180, profile: loudStart }, 8).cut).toBe(170);
    expect(sweetTransition({ duration: 200, profile: profile([0], silentTail), lastCue: 190 }, { duration: 180, profile: loudStart }, 8).cut)
      .toBe(190.5);
  });
});
