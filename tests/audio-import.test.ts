import { describe, expect, it } from 'vitest';
import { AAC_IMPORT } from '../shared/audio-import';

describe('AAC import policy', () => {
  it('targets portable 256 kbps AAC-LC in M4A with bounded output', () => {
    expect(AAC_IMPORT).toMatchObject({ codec: 'aac', profile: 'aac_low', bitRate: 256_000,
      sampleRate: 48_000, contentType: 'audio/mp4', extension: '.m4a' });
    expect(AAC_IMPORT.maxOutputBytes).toBeGreaterThan(AAC_IMPORT.bitRate / 8 * AAC_IMPORT.maxDuration);
    expect(AAC_IMPORT.maxOutputBytes).toBeLessThan(AAC_IMPORT.maxSourceBytes);
    expect(Object.isFrozen(AAC_IMPORT)).toBe(true);
  });
});