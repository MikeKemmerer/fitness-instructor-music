import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tagsFromBytes } from '../frontend/src/audio-tags';

const title = 'Plié Séries — Warm Up';
const artist = 'Dua Lipa & Friends';

function encode(args: string[]): Uint8Array {
  return new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, ...args, 'pipe:1'], { timeout: 15000 }));
}

describe('embedded audio tags', () => {
  it.each([
    ['MP3 ID3v2.3', ['-c:a', 'libmp3lame', '-id3v2_version', '3', '-f', 'mp3']],
    ['MP3 ID3v2.4', ['-c:a', 'libmp3lame', '-id3v2_version', '4', '-f', 'mp3']],
    ['Ogg Opus', ['-c:a', 'libopus', '-f', 'ogg']],
    ['FLAC', ['-c:a', 'flac', '-f', 'flac']],
    ['WAV INFO', ['-c:a', 'pcm_s16le', '-f', 'wav']],
  ])('reads title and artist from %s', (_name, args) => {
    expect(tagsFromBytes(encode(args))).toEqual({ title, artist });
  });

  it('reads iTunes-style MP4 tags written by the M4A conversion', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fim-tags-')), 'tagged.m4a');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-map_metadata', '-1', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`,
      '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', '-y', path], { timeout: 15000 });
    expect(tagsFromBytes(new Uint8Array(readFileSync(path)))).toEqual({ title, artist });
  });

  it('falls back to ID3v1, trims control characters and ignores untagged or malformed audio', () => {
    const v1 = new Uint8Array(256);
    v1.set([...'TAG'].map(c => c.charCodeAt(0)), 128);
    v1.set([...'Old title\u0001'].map(c => c.charCodeAt(0)), 131);
    v1.set([...'Old artist'].map(c => c.charCodeAt(0)), 161);
    expect(tagsFromBytes(v1)).toEqual({ title: 'Old title', artist: 'Old artist' });
    expect(tagsFromBytes(new Uint8Array(64))).toEqual({});
    expect(tagsFromBytes(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, 1, 2]))).toEqual({});
    expect(tagsFromBytes(Uint8Array.from([...'OggS'].map(c => c.charCodeAt(0))))).toEqual({});
  });
});
