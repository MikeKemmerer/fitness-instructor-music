import type { Filler, FillerRecording } from '../../shared/routine';
import { formatNumber, t } from './i18n';
import { element, field, numberInput, selectInput } from './ui';

export function fillerControls(filler: Filler, recordings: () => FillerRecording[], changed: () => void,
  editable: () => boolean, held = false): HTMLElement {
  const fields = element('fieldset', 'field-grid');
  fields.disabled = !editable();
  const mutate = (change: () => void) => { if (editable()) { change(); sync(); changed(); } };
  const mode = selectInput(filler.mode, (held ? ['hold'] as const : ['none', 'timed', 'hold'] as const)
    .map(value => ({ value, label: t(value) })), value => mutate(() => { filler.mode = value; }));
  const duration = numberInput(filler.seconds, 0, 600, value => mutate(() => { filler.seconds = value; }));
  const bpm = numberInput(filler.bpm, 40, 220, value => mutate(() => { filler.bpm = value; }));
  const choices = [...recordings()];
  if (filler.recording && !choices.some(value => value.id === filler.recording!.id)) choices.push(filler.recording);
  const sound = selectInput<string>(filler.recording ? `recording:${filler.recording.id}` : filler.sound,
    [...(['lofi', 'soft', 'bright', 'drums'] as const).map(value => ({ value, label: t(value) })),
      ...choices.map(recording => ({ value: `recording:${recording.id}`, label: recording.name }))], value => mutate(() => {
      const recording = choices.find(item => `recording:${item.id}` === value);
      if (recording) { filler.sound = 'recording'; filler.recording = structuredClone(recording); }
      else if (['lofi', 'soft', 'bright', 'drums'].includes(value)) {
        filler.sound = value as Filler['sound']; delete filler.recording;
      }
    }));
  const gain = numberInput(filler.gain ?? 1, 0, 1.5, value => mutate(() => { filler.gain = value; }));
  gain.step = '0.05';
  const level = element('output', 'muted');
  const sync = () => {
    duration.disabled = filler.mode !== 'timed';
    bpm.disabled = ['recording', 'lofi'].includes(filler.sound) || filler.mode === 'none';
    sound.disabled = filler.mode === 'none';
    level.textContent = t('gainDb', { db: (filler.gain ?? 1) === 0 ? '-inf' : formatNumber(20 * Math.log10(filler.gain ?? 1)),
      percent: formatNumber((filler.gain ?? 1) * 100) });
  };
  fields.append(field(t('fillerMode'), mode), field(t('fillerSound'), sound), field(t('fillerDuration'), duration),
    field(t('fillerBpm'), bpm), field(t('fillerGain'), gain), level);
  sync();
  return fields;
}