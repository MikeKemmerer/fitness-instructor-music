import { AAC_IMPORT } from '../../shared/audio-import';

export type ConversionReply = { kind: 'complete'; bytes: ArrayBuffer; duration: number }
  | { kind: 'error'; error: string };

type Core = {
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string, options?: { encoding: string }): Uint8Array | string;
    stat(path: string): { size: number };
    unlink(path: string): void;
    registerDevice(id: number, operations: { write: (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number }): void;
    mkdev(path: string, mode: number, device: number): void;
  };
  exec(...args: string[]): void;
  ffprobe(...args: string[]): void;
  ret: number;
  reset(): void;
  setTimeout(milliseconds: number): void;
  setLogger(callback: (log: { message: string }) => void): void;
};
type Probe = {
  streams?: { codec_type?: string; codec_name?: string; codec_tag_string?: string; profile?: string;
    channels?: number; sample_rate?: string; duration?: string; start_time?: string;
    disposition?: { attached_pic?: unknown };
    side_data_list?: { side_data_type?: string }[] }[];
  format?: { format_name?: string; duration?: string };
  packets?: { side_data_list?: { side_data_type?: string }[] }[];
};

const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_PROBE_BYTES = 4 * 1024 * 1024;
const MAX_STREAMS = 8;
const COMMAND_TIMEOUT_MS = 180_000;
const FRAME_SECONDS = 1024 / AAC_IMPORT.sampleRate;
const inputOptions = ['-protocol_whitelist', 'file,pipe', '-max_streams', String(MAX_STREAMS),
  '-format_whitelist', 'aac,aiff,ape,asf,flac,matroska,webm,mov,mp3,ogg,wav,wv'];
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ blob: Blob; coreURL: string; wasmURL: string }>) => void) | null;
  postMessage(message: ConversionReply, transfer?: Transferable[]): void;
};
let started = false;

function fail(code: string): never { throw new Error(code); }

async function convert(blob: Blob, coreURL: string, wasmURL: string): Promise<{ bytes: ArrayBuffer; duration: number }> {
  if (!(blob instanceof Blob) || blob.size <= 0) fail('conversion_invalid_audio');
  if (blob.size > AAC_IMPORT.maxSourceBytes) fail('conversion_source_limit');
  let memoryExceeded = false;
  let protectedAudio = false;
  let commandError = false;
  let decodeError = '';
  let probeExceeded = false;
  let probeLength = 0;
  let probeLimit = 128 * 1024;
  let core: Core;
  try {
    const factory = (await import(/* @vite-ignore */ coreURL)).default;
    const response = await fetch(wasmURL, { credentials: 'omit' });
    if (!response.ok) fail('conversion_unavailable');
    core = await factory({
      mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL }))}`,
      print: () => {}, printErr: () => {},
      wasmBinary: await response.arrayBuffer(),
    });
  } catch { fail(memoryExceeded ? 'conversion_memory_limit' : 'conversion_unavailable'); }
  core.setLogger(({ message }) => {
    if (/out of memory|cannot allocate memory|memory allocation failed/i.test(message)) memoryExceeded = true;
    if (message.trim() && message.trim() !== 'Aborted()') commandError = true;
    if (/encrypt|decrypt|\bDRM\b/i.test(message)) protectedAudio = true;
  });
  const run = (kind: 'exec' | 'ffprobe', args: string[], error: string) => {
    commandError = false;
    const start = performance.now();
    core.setTimeout(COMMAND_TIMEOUT_MS);
    try { core[kind]('-hide_banner', '-v', 'error', '-max_alloc', '67108864', ...args); }
    catch {
      if (memoryExceeded) fail('conversion_memory_limit');
      if (probeExceeded) fail('conversion_invalid_audio');
      if (decodeError) fail(decodeError);
      if (performance.now() - start >= COMMAND_TIMEOUT_MS) fail('conversion_timeout');
      fail(protectedAudio ? 'conversion_protected_audio' : error);
    }
    const status = core.ret;
    core.reset();
    if (memoryExceeded) fail('conversion_memory_limit');
    if (probeExceeded) fail('conversion_invalid_audio');
    if (decodeError) fail(decodeError);
    if (performance.now() - start >= COMMAND_TIMEOUT_MS) fail('conversion_timeout');
    if ((commandError && kind !== 'ffprobe') || (status !== 0 && !(kind === 'ffprobe' && status === -1))) {
      fail(protectedAudio ? 'conversion_protected_audio' : error);
    }
  };
  const probeBytes = new Uint8Array(MAX_PROBE_BYTES);
  const probe = (path: string, packets = false): Probe => {
    probeLength = 0;
    probeLimit = packets ? MAX_PROBE_BYTES : 128 * 1024;
    run('ffprobe', [...inputOptions, ...(packets ? ['-show_packets'] : []),
      ...(path === '/output.m4a' ? ['-read_intervals', '%+#1'] : []), '-show_entries',
      packets ? 'packet=stream_index:packet_side_data=side_data_type'
        : 'stream=codec_type,codec_name,codec_tag_string,profile,channels,sample_rate,duration,start_time:stream_disposition=attached_pic:stream_side_data=side_data_type:format=format_name,duration',
      '-of', 'json=compact=1', '-o', '/probe.json', path], 'conversion_invalid_audio');
    const result = JSON.parse(new TextDecoder().decode(probeBytes.subarray(0, probeLength))) as Probe;
    if ((packets && !Array.isArray(result.packets)) || (!packets && (!Array.isArray(result.streams)
      || result.streams.length > MAX_STREAMS || result.streams.some(stream => !stream || typeof stream !== 'object')))) {
      fail('conversion_invalid_audio');
    }
    if (result.streams?.some(stream => stream.codec_tag_string === 'enca' || stream.codec_tag_string === 'encv'
      || stream.side_data_list?.some(side => /encrypt/i.test(side.side_data_type ?? '')))
      || result.packets?.some(packet => packet.side_data_list?.some(side => /encrypt/i.test(side.side_data_type ?? '')))) {
      fail('conversion_protected_audio');
    }
    if (commandError) {
      if (!packets && path === '/input.bin') probe(path, true);
      fail(protectedAudio ? 'conversion_protected_audio' : 'conversion_invalid_audio');
    }
    return result;
  };
  try {
    core.FS.writeFile('/input.bin', new Uint8Array(await blob.arrayBuffer()));
    core.FS.registerDevice(232, { write: (_stream, buffer, offset, length) => {
      if (probeLength + length > probeLimit) {
        probeExceeded = true;
        fail('conversion_invalid_audio');
      }
      probeBytes.set(buffer.subarray(offset, offset + length), probeLength);
      probeLength += length;
      return length;
    } });
    core.FS.mkdev('/probe.json', 0o600, 232);
    const source = probe('/input.bin');
    const streams = source.streams ?? [];
    if (streams.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)) {
      fail('conversion_video_not_allowed');
    }
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    if (!audio.length) fail('conversion_no_audio');
    if (audio.length !== 1) fail('conversion_multiple_audio');
    probe('/input.bin', true);
    const stream = audio[0];
    const channels = stream.channels;
    if (!channels || !Number.isInteger(channels) || channels < 1 || channels > AAC_IMPORT.maxChannels) fail('conversion_channel_limit');
    const declaredDuration = Number(stream.duration ?? (streams.some(stream => stream.codec_type === 'video') ? undefined : source.format?.duration));
    if (Number.isFinite(declaredDuration) && declaredDuration <= 0) fail('conversion_invalid_audio');
    if (declaredDuration > AAC_IMPORT.maxDuration + FRAME_SECONDS) fail('conversion_duration_limit');
    if (Math.ceil(declaredDuration * AAC_IMPORT.sampleRate) * channels * 4 > MAX_DECODED_BYTES) fail('conversion_memory_limit');
    let decodedBytes = 0;
    core.FS.registerDevice(231, { write: (_stream, _buffer, _offset, length) => {
      decodedBytes += length;
      if (decodedBytes > MAX_DECODED_BYTES) decodeError = 'conversion_memory_limit';
      if (decodedBytes / (4 * channels * AAC_IMPORT.sampleRate) > AAC_IMPORT.maxDuration) decodeError = 'conversion_duration_limit';
      if (decodeError) throw new Error(decodeError);
      return length;
    } });
    core.FS.mkdev('/meter.pcm', 0o600, 231);
    run('exec', ['-xerror', ...inputOptions, '-err_detect', 'explode', '-i', '/input.bin',
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ar', String(AAC_IMPORT.sampleRate),
      '-c:a', 'pcm_f32le', '-f', 'f32le', '/meter.pcm'], 'conversion_invalid_audio');
    const duration = decodedBytes / (4 * channels * AAC_IMPORT.sampleRate);
    if (!Number.isFinite(duration) || duration <= 0
      || (Number.isFinite(declaredDuration) && Math.abs(duration - declaredDuration) > 0.1)) fail('conversion_invalid_audio');
    run('exec', ['-xerror', ...inputOptions, '-err_detect', 'explode', '-i', '/input.bin',
      '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', '-vn', '-sn', '-dn',
      '-c:a', AAC_IMPORT.codec, '-profile:a', AAC_IMPORT.profile, '-b:a', String(AAC_IMPORT.bitRate),
      '-ar', String(AAC_IMPORT.sampleRate), '-threads', '1', '-movflags', '+faststart',
      '-use_editlist', '1', '-fs', String(AAC_IMPORT.maxOutputBytes), '-f', 'mp4', '/output.m4a'], 'conversion_failed');
    const size = core.FS.stat('/output.m4a').size;
    if (size <= 0 || size >= AAC_IMPORT.maxOutputBytes) fail('conversion_output_limit');
    const output = probe('/output.m4a');
    const encoded = output.streams?.[0];
    const outputDuration = Number(encoded?.duration);
    if (output.streams?.length !== 1 || encoded?.codec_type !== 'audio' || encoded.codec_name !== 'aac' || encoded.profile !== 'LC'
      || encoded.disposition?.attached_pic !== 0
      || encoded.channels !== channels || Number(encoded.sample_rate) !== AAC_IMPORT.sampleRate
      || !output.format?.format_name?.split(',').includes('mp4')
      || Number(encoded.start_time) !== 0 || !Number.isFinite(outputDuration)
      || Math.abs(outputDuration - duration) > FRAME_SECONDS || outputDuration > AAC_IMPORT.maxDuration) {
      fail('conversion_invalid_output');
    }
    const bytes = core.FS.readFile('/output.m4a') as Uint8Array<ArrayBuffer>;
    return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), duration };
  } finally {
    for (const path of ['/input.bin', '/output.m4a', '/probe.json', '/meter.pcm']) {
      try { core.FS.unlink(path); } catch {}
    }
  }
}

scope.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  try {
    const result = await convert(data.blob, data.coreURL, data.wasmURL);
    scope.postMessage({ kind: 'complete', ...result }, [result.bytes]);
  } catch (error) {
    const code = error instanceof Error && /^conversion_[a-z_]+$/.test(error.message) ? error.message : 'conversion_failed';
    scope.postMessage({ kind: 'error', error: code });
  }
};