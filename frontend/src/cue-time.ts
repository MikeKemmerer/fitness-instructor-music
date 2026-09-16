export function parseCueTime(text: string): number | null {
  const value = text.trim();
  if (!/^(?:\d+(?:\.\d+)?|\d+:\d{2}(?:\.\d+)?)$/.test(value)) return null;
  const parts = value.split(':');
  const seconds = Number(parts.at(-1));
  if (parts.length === 2 && seconds >= 60) return null;
  const result = parts.length === 2 ? Number(parts[0]) * 60 + seconds : seconds;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function formatCueTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  let decimal = String(seconds);
  if (decimal.includes('e-')) {
    const [coefficient, exponent] = decimal.split('e-');
    decimal = `0.${'0'.repeat(Number(exponent) - 1)}${coefficient!.replace('.', '')}`;
  }
  const [whole, fraction] = decimal.split('.');
  if (decimal.includes('e')) return decimal;
  const minutes = Math.floor(Number(whole) / 60);
  const remainder = String(Number(whole) % 60).padStart(2, '0');
  return `${minutes}:${remainder}.${fraction ?? '0'}`;
}