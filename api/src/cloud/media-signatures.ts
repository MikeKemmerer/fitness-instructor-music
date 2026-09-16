import { ApiError } from './config';

function unsupported(): never { throw new ApiError(415, 'unsupported_media'); }

export function validateAdts(prefix: Buffer, assetBytes: number): void {
  let offset = 0;
  let frames = 0;
  let configuration: string | undefined;
  while (offset < assetBytes) {
    if (offset + 7 > prefix.length) {
      if (frames >= 2 && prefix.length === 65536 && prefix.length < assetBytes && assetBytes - offset >= 7) return;
      unsupported();
    }
    const flags = prefix[offset + 1]!;
    const profile = prefix[offset + 2]! >> 6;
    const rate = (prefix[offset + 2]! >> 2) & 15;
    const channels = ((prefix[offset + 2]! & 1) << 2) | (prefix[offset + 3]! >> 6);
    const headerBytes = flags & 1 ? 7 : 9;
    const frameBytes = ((prefix[offset + 3]! & 3) << 11) | (prefix[offset + 4]! << 3) | (prefix[offset + 5]! >> 5);
    if (prefix[offset] !== 255 || (flags & 246) !== 240 || profile === 3 || rate > 12 ||
        ![1, 2].includes(channels) || (prefix[offset + 6]! & 3) !== 0 ||
        frameBytes <= headerBytes || offset + frameBytes > assetBytes) unsupported();
    const current = `${flags & 8}:${profile}:${rate}:${channels}`;
    if (configuration !== undefined && configuration !== current) unsupported();
    configuration = current;
    if (offset + frameBytes > prefix.length) {
      if (frames >= 2 && prefix.length === 65536 && offset + headerBytes <= prefix.length) return;
      unsupported();
    }
    offset += frameBytes;
    frames++;
  }
  if (frames < 2) unsupported();
}

export function validateMp4(prefix: Buffer, assetBytes: number): void {
  let offset = 0;
  while (offset + 8 <= prefix.length) {
    const kind = prefix.toString('latin1', offset + 4, offset + 8);
    let size = prefix.readUInt32BE(offset);
    let headerBytes = 8;
    if (size === 1) {
      if (offset + 16 > prefix.length) unsupported();
      const extendedSize = prefix.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(assetBytes - offset)) unsupported();
      size = Number(extendedSize);
      headerBytes = 16;
    } else if (size === 0) size = assetBytes - offset;
    if (size < headerBytes || offset + size > assetBytes || offset + size > prefix.length) unsupported();
    if (kind === 'ftyp') {
      if (size < headerBytes + 8 || (size - headerBytes) % 4 ||
          !['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'].includes(prefix.toString('latin1', offset + headerBytes, offset + headerBytes + 4))) unsupported();
      return;
    }
    if (!['free', 'skip', 'wide'].includes(kind)) unsupported();
    offset += size;
  }
  unsupported();
}

interface EbmlElement { id: number; start: number; end: number; unknown: boolean }

function vint(prefix: Buffer, offset: number, limit: number, identifier = false) {
  if (offset >= limit || offset >= prefix.length) unsupported();
  const first = prefix[offset]!;
  let marker = 128;
  let length = 1;
  while (marker && !(first & marker)) { marker >>= 1; length++; }
  if (!marker || length > (identifier ? 4 : 8) || offset + length > limit || offset + length > prefix.length) unsupported();
  let value = identifier ? first : first & (marker - 1);
  let unknown = (first & (marker - 1)) === marker - 1;
  for (let index = 1; index < length; index++) {
    const byte = prefix[offset + index]!;
    value = value * 256 + byte;
    unknown = unknown && byte === 255;
  }
  if ((!unknown || identifier) && !Number.isSafeInteger(value)) unsupported();
  return { value: unknown && !identifier ? 0 : value, length, unknown: !identifier && unknown };
}

function element(prefix: Buffer, offset: number, limit: number): EbmlElement {
  const id = vint(prefix, offset, limit, true);
  const size = vint(prefix, offset + id.length, limit);
  const start = offset + id.length + size.length;
  const end = size.unknown ? limit : start + size.value;
  if (!Number.isSafeInteger(end) || end > limit) unsupported();
  return { id: id.value, start, end, unknown: size.unknown };
}

function children(prefix: Buffer, parent: EbmlElement): EbmlElement[] {
  if (parent.unknown || parent.end > prefix.length) unsupported();
  const result: EbmlElement[] = [];
  let offset = parent.start;
  while (offset < parent.end) {
    const child = element(prefix, offset, parent.end);
    if (child.unknown) unsupported();
    result.push(child);
    offset = child.end;
  }
  return result;
}

function single(fields: EbmlElement[], id: number): EbmlElement | undefined {
  const matches = fields.filter(field => field.id === id);
  if (matches.length > 1) unsupported();
  return matches[0];
}

function unsigned(prefix: Buffer, field: EbmlElement): number {
  const length = field.end - field.start;
  if (length < 1 || length > 8) unsupported();
  let value = 0;
  for (let offset = field.start; offset < field.end; offset++) value = value * 256 + prefix[offset]!;
  return value;
}

function frequency(prefix: Buffer, field: EbmlElement): void {
  const length = field.end - field.start;
  if (length !== 4 && length !== 8) unsupported();
  const value = length === 4 ? prefix.readFloatBE(field.start) : prefix.readDoubleBE(field.start);
  if (!Number.isFinite(value) || value < 8000 || value > 96000) unsupported();
}

function validateTracks(prefix: Buffer, tracks: EbmlElement): void {
  const entries = children(prefix, tracks);
  const numbers = new Set<number>();
  let count = 0;
  for (const entry of entries) {
    if (entry.id === 0xec || entry.id === 0xbf) continue;
    if (entry.id !== 0xae) unsupported();
    const fields = children(prefix, entry);
    if (fields.some(field => field.id === 0x6d80 || field.id === 0xe0)) unsupported();
    const number = single(fields, 0xd7);
    const uid = single(fields, 0x73c5);
    const type = single(fields, 0x83);
    const codec = single(fields, 0x86);
    const audio = single(fields, 0xe1);
    if (!number || !uid || !type || !codec || !audio || unsigned(prefix, type) !== 2 || unsigned(prefix, uid) <= 0) unsupported();
    const trackNumber = unsigned(prefix, number);
    if (!Number.isSafeInteger(trackNumber) || trackNumber < 1 || numbers.has(trackNumber)) unsupported();
    numbers.add(trackNumber);
    if (!['A_VORBIS', 'A_OPUS', 'A_AAC'].includes(prefix.toString('latin1', codec.start, codec.end))) unsupported();
    const properties = children(prefix, audio);
    const channels = single(properties, 0x9f);
    const rate = single(properties, 0xb5);
    const outputRate = single(properties, 0x78b5);
    if (channels && ![1, 2].includes(unsigned(prefix, channels))) unsupported();
    if (rate) frequency(prefix, rate);
    if (outputRate) frequency(prefix, outputRate);
    count++;
  }
  if (!count) unsupported();
}

export function validateWebm(prefix: Buffer, assetBytes: number): void {
  const header = element(prefix, 0, assetBytes);
  if (header.id !== 0x1a45dfa3) unsupported();
  const fields = children(prefix, header);
  const docType = single(fields, 0x4282);
  if (!docType || prefix.toString('latin1', docType.start, docType.end) !== 'webm') unsupported();
  for (const [id, maximum] of [[0x4286, 1], [0x42f7, 1], [0x42f2, 4], [0x42f3, 8], [0x4287, 4], [0x4285, 4]] as const) {
    const field = single(fields, id);
    if (field && (unsigned(prefix, field) < 1 || unsigned(prefix, field) > maximum)) unsupported();
  }
  let offset = header.end;
  let segment = element(prefix, offset, assetBytes);
  while (segment.id === 0xec || segment.id === 0xbf) {
    if (segment.unknown || segment.end > prefix.length) unsupported();
    offset = segment.end;
    segment = element(prefix, offset, assetBytes);
  }
  if (segment.id !== 0x18538067) unsupported();
  offset = segment.start;
  let foundTracks = false;
  while (offset < segment.end) {
    const child = element(prefix, offset, segment.end);
    if (child.id === 0x1f43b675) {
      if (!foundTracks) unsupported();
      return;
    }
    if (child.unknown || child.end > prefix.length) unsupported();
    if (child.id === 0x1654ae6b) {
      if (foundTracks) unsupported();
      validateTracks(prefix, child);
      foundTracks = true;
    }
    offset = child.end;
  }
  if (!foundTracks) unsupported();
}