import { describe, expect, it } from 'vitest';
import { accents, parsePreferences, themeColors } from '../frontend/src/theme';
import { contentFingerprint, duplicateDraft, sortedCues } from '../frontend/src/editor';
import { errorMessage, formatTime, t } from '../frontend/src/i18n';
import { newRoutine } from '../shared/routine';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((firstValue, secondValue) => secondValue - firstValue);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('local appearance', () => {
  it('uses Cloud for Azure storage labels without renaming translation keys', () => {
    expect(t('householdDestination')).toBe('Cloud');
    expect(t('householdFilter')).toBe('Cloud');
    expect(t('cloudSave')).toBe('Save to Cloud');
    expect(t('cloudRoutines')).toBe('Cloud routines');
    expect(t('uploadFiller')).toBe('Upload recording to Cloud');
  });
  it('uses OS mode only until a valid explicit preference exists', () => {
    expect(parsePreferences(null, true).mode).toBe('dark');
    expect(parsePreferences('{"mode":"light"}', true).mode).toBe('light');
    expect(parsePreferences('{broken').accent).toBe('teal');
  });

  it('validates stored preferences without importing unrelated data', () => {
    expect(parsePreferences('{"accent":"pink","highContrast":"true","progressHeight":900,"token":"ignored"}'))
      .toEqual({ mode: 'light', accent: 'teal', highContrast: false, progressHeight: 120, disableDemos: false });
    expect(parsePreferences('{"progressHeight":1}').progressHeight).toBe(44);
  });

  it('keeps demos enabled for existing preferences and accepts only a boolean disable flag', () => {
    expect(parsePreferences(null).disableDemos).toBe(false);
    expect(parsePreferences('{"mode":"dark"}').disableDemos).toBe(false);
    expect(parsePreferences('{"disableDemos":"true"}').disableDemos).toBe(false);
    expect(parsePreferences('{"disableDemos":true}').disableDemos).toBe(true);
    expect(parsePreferences('{"disableDemos":false}').disableDemos).toBe(false);
  });

  for (const mode of ['light', 'dark'] as const) {
    for (const accent of accents) {
      it(`${mode} ${accent} has readable accent text and controls`, () => {
        const preferences = { mode, accent, highContrast: false, progressHeight: 64 };
        const colors = themeColors(preferences);
        expect(contrast(colors.accent, colors.onAccent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.accent, mode === 'light' ? '#f4f5f4' : '#141617')).toBeGreaterThanOrEqual(3);
        const high = themeColors({ ...preferences, highContrast: true });
        expect(contrast(high.accent, high.onAccent)).toBeGreaterThanOrEqual(7);
        expect(preferences.accent).toBe(accent);
      });
    }
  }
});

describe('editor snapshot boundaries', () => {
  it('duplicates into a new unlocked identity with detached track and cue data', () => {
    const source = newRoutine();
    source.locked = true;
    source.published = true;
    source.tracks.push({ id: 'media-id', title: 'Source', duration: 30, bpm: 120, firstBeat: 1,
      bodyArea: '', cues: [{ id: 'cue-id', anchor: { kind: 'count', count: 5 }, note: '<b>Plain text</b>' }] });
    const copy = duplicateDraft(source);
    expect(copy.id).not.toBe(source.id);
    expect(copy.locked).toBe(false);
    expect(copy.published).toBe(false);
    expect(copy.tracks[0]!.id).toBe(source.tracks[0]!.id);
    copy.tracks[0]!.cues[0]!.note = 'Changed';
    expect(source.tracks[0]!.cues[0]!.note).toBe('<b>Plain text</b>');
    expect(source.locked).toBe(true);
  });

  it('detects playable edits but excludes lock and save metadata', () => {
    const routine = newRoutine();
    const original = contentFingerprint(routine);
    routine.locked = true;
    routine.revision += 1;
    expect(contentFingerprint(routine)).toBe(original);
    routine.filler.seconds += 1;
    expect(contentFingerprint(routine)).not.toBe(original);
  });

  it('previews all three anchors through the shared timing function', () => {
    const routine = newRoutine();
    routine.tracks.push({ id: 'media-id', title: 'Source', duration: 30, bpm: 120, firstBeat: 1, bodyArea: '',
      cues: [
        { id: 'count', anchor: { kind: 'count', count: 5 }, note: 'Count' },
        { id: 'time', anchor: { kind: 'timestamp', seconds: 1 }, note: 'Timestamp' },
        { id: 'interval', anchor: { kind: 'interval', seconds: 2 }, note: 'Interval' },
      ] });
    expect(sortedCues(routine.tracks[0]!).map(item => item.seconds)).toEqual([1, 2, 3]);
  });

  it('formats durations and translates runtime errors without interpreting note markup', () => {
    expect(formatTime(3671.9)).toBe('61:11');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(errorMessage(new Error('audio_interrupted'))).toBe(t('audioInterrupted'));
    expect(t('cuePreview', { time: '0:12', note: '<script>text</script>' })).toBe('0:12: <script>text</script>');
  });
});