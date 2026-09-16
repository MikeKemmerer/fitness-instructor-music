export const AAC_IMPORT = Object.freeze({
  codec: 'aac',
  profile: 'aac_low',
  bitRate: 256_000,
  sampleRate: 48_000,
  contentType: 'audio/mp4',
  extension: '.m4a',
  maxSourceBytes: 32 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxDuration: 360,
  maxChannels: 2,
});