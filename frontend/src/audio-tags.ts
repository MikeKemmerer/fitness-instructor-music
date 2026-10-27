export interface AudioTags { title?: string; artist?: string }

const MAX_TEXT = 300;

function clean(value: string | undefined): string | undefined {
  const text = value?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return start < 0 || start + length > bytes.length ? '' : String.fromCharCode(...bytes.subarray(start, start + length));
}

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);

function result(title?: string, artist?: string): AudioTags {
  const tags: AudioTags = {};
  const cleanTitle = clean(title);
  const cleanArtist = clean(artist);
  if (cleanTitle) tags.title = cleanTitle;
  if (cleanArtist) tags.artist = cleanArtist;
  return tags;
}

function id3Text(frame: Uint8Array): string | undefined {
  if (!frame.length) return undefined;
  const encoding = frame[0];
  const body = frame.subarray(1);
  const bigEndian = encoding === 2 || (encoding === 1 && body[0] === 0xfe && body[1] === 0xff);
  const label = encoding === 1 || encoding === 2 ? (bigEndian ? 'utf-16be' : 'utf-16le') : encoding === 3 ? 'utf-8' : 'latin1';
  return new TextDecoder(label).decode(body).split('\u0000').find(part => part.trim());
}

function id3v2(bytes: Uint8Array): AudioTags {
  const major = bytes[3]!;
  if (![2, 3, 4].includes(major) || bytes.length < 10) return {};
  const flags = bytes[5]!;
  const size = ((bytes[6]! & 127) << 21) | ((bytes[7]! & 127) << 14) | ((bytes[8]! & 127) << 7) | (bytes[9]! & 127);
  let tag = bytes.subarray(10, Math.min(bytes.length, 10 + size));
  if (flags & 0x80 && major < 4) {
    const plain: number[] = [];
    for (let index = 0; index < tag.length; index++) {
      plain.push(tag[index]!);
      if (tag[index] === 0xff && tag[index + 1] === 0) index++;
    }
    tag = Uint8Array.from(plain);
  }
  let offset = 0;
  if (flags & 0x40 && major >= 3) {
    const view = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
    if (tag.length < 4) return {};
    offset = major === 3 ? 4 + view.getUint32(0)
      : ((tag[0]! & 127) << 21) | ((tag[1]! & 127) << 14) | ((tag[2]! & 127) << 7) | (tag[3]! & 127);
  }
  const values = new Map<string, string>();
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (offset + headerLength <= tag.length) {
    const id = ascii(tag, offset, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const length = major === 2 ? (tag[offset + 3]! << 16) | (tag[offset + 4]! << 8) | tag[offset + 5]!
      : major === 3 ? new DataView(tag.buffer, tag.byteOffset + offset + 4, 4).getUint32(0)
        : ((tag[offset + 4]! & 127) << 21) | ((tag[offset + 5]! & 127) << 14) | ((tag[offset + 6]! & 127) << 7) | (tag[offset + 7]! & 127);
    const start = offset + headerLength;
    if (length <= 0 || start + length > tag.length) break;
    const compressedOrEncrypted = major > 2 && (tag[offset + 9]! & (major === 3 ? 0xc0 : 0x0c));
    if (!compressedOrEncrypted && /^(TIT2|TPE1|TPE2|TT2|TP1|TP2)$/.test(id) && !values.has(id)) {
      const skip = major === 4 && tag[offset + 9]! & 0x01 ? 4 : 0;
      const text = id3Text(tag.subarray(start + skip, start + length));
      if (text) values.set(id, text);
    }
    offset = start + length;
  }
  return result(values.get('TIT2') ?? values.get('TT2'),
    values.get('TPE1') ?? values.get('TP1') ?? values.get('TPE2') ?? values.get('TP2'));
}

function id3v1(bytes: Uint8Array): AudioTags {
  const start = bytes.length - 128;
  if (start < 0 || ascii(bytes, start, 3) !== 'TAG') return {};
  const field = (offset: number, length: number) =>
    new TextDecoder('latin1').decode(bytes.subarray(start + offset, start + offset + length)).split('\u0000')[0];
  return result(field(3, 30), field(33, 30));
}

function vorbisComments(bytes: Uint8Array): AudioTags {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) return {};
  let offset = 4 + view.getUint32(0, true);
  if (offset + 4 > bytes.length) return {};
  const count = view.getUint32(offset, true);
  offset += 4;
  const values = new Map<string, string>();
  for (let index = 0; index < count && offset + 4 <= bytes.length; index++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > bytes.length) break;
    const comment = utf8(bytes.subarray(offset, offset + length));
    offset += length;
    const separator = comment.indexOf('=');
    if (separator <= 0) continue;
    const key = comment.slice(0, separator).toUpperCase();
    if (!values.has(key)) values.set(key, comment.slice(separator + 1));
  }
  return result(values.get('TITLE'), values.get('ARTIST') ?? values.get('ALBUMARTIST') ?? values.get('ALBUM ARTIST'));
}

function ogg(bytes: Uint8Array): AudioTags {
  const packets: number[][] = [[]];
  let offset = 0;
  while (packets.length <= 2 && offset + 27 <= bytes.length && ascii(bytes, offset, 4) === 'OggS') {
    const segments = bytes[offset + 26]!;
    let data = offset + 27 + segments;
    for (let index = 0; index < segments && packets.length <= 2; index++) {
      const length = bytes[offset + 27 + index]!;
      if (data + length > bytes.length) return {};
      packets.at(-1)!.push(...bytes.subarray(data, data + length));
      data += length;
      if (length < 255 || packets.at(-1)!.length > 1_048_576) packets.push([]);
    }
    offset = data;
  }
  const comment = packets[1] ? Uint8Array.from(packets[1]) : undefined;
  if (!comment) return {};
  if (ascii(comment, 0, 8) === 'OpusTags') return vorbisComments(comment.subarray(8));
  if (comment[0] === 3 && ascii(comment, 1, 6) === 'vorbis') return vorbisComments(comment.subarray(7));
  return {};
}

function flac(bytes: Uint8Array): AudioTags {
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]!;
    const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const start = offset + 4;
    if (start + length > bytes.length) return {};
    if ((header & 127) === 4) return vorbisComments(bytes.subarray(start, start + length));
    if (header & 128) return {};
    offset = start + length;
  }
  return {};
}

function wav(bytes: Uint8Array): AudioTags {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let found: AudioTags = {};
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length) break;
    if (kind === 'LIST' && ascii(bytes, start, 4) === 'INFO') {
      let title: string | undefined;
      let artist: string | undefined;
      let item = start + 4;
      while (item + 8 <= start + length) {
        const id = ascii(bytes, item, 4);
        const size = view.getUint32(item + 4, true);
        if (item + 8 + size > start + length) break;
        const text = utf8(bytes.subarray(item + 8, item + 8 + size)).split('\u0000')[0];
        if (id === 'INAM') title = text;
        if (id === 'IART') artist = text;
        item += 8 + size + (size % 2);
      }
      found = { ...result(title, artist), ...found };
    }
    if ((kind === 'id3 ' || kind === 'ID3 ') && ascii(bytes, start, 3) === 'ID3') found = { ...id3v2(bytes.subarray(start, start + length)), ...found };
    offset = start + length + (length % 2);
  }
  return found;
}

function mp4(bytes: Uint8Array): AudioTags {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = (start: number, end: number) => {
    const found: { kind: string; start: number; end: number }[] = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || offset + size > end) break;
      found.push({ kind: ascii(bytes, offset + 4, 4), start: offset + header, end: offset + size });
      offset += size;
    }
    return found;
  };
  const child = (box: { start: number; end: number } | undefined, kind: string, skip = 0) =>
    box ? boxes(box.start + skip, box.end).find(item => item.kind === kind) : undefined;
  const moov = boxes(0, bytes.length).find(box => box.kind === 'moov');
  const meta = child(child(moov, 'udta'), 'meta');
  const ilst = child(meta, 'ilst', 4) ?? child(meta, 'ilst');
  if (!ilst) return {};
  const value = (kind: string) => {
    const data = child(boxes(ilst.start, ilst.end).find(item => item.kind === kind), 'data');
    return data && data.end - data.start > 8 ? utf8(bytes.subarray(data.start + 8, data.end)) : undefined;
  };
  return result(value('\u00a9nam'), value('\u00a9ART') ?? value('aART'));
}

/** Reads title/artist from ID3 (MP3/WAV), MP4 ilst, Ogg Opus/Vorbis, FLAC and WAV INFO tags; never throws. */
export function tagsFromBytes(bytes: Uint8Array): AudioTags {
  try {
    if (ascii(bytes, 0, 3) === 'ID3') {
      const tags = id3v2(bytes);
      return tags.title || tags.artist ? tags : id3v1(bytes);
    }
    if (ascii(bytes, 0, 4) === 'OggS') return ogg(bytes);
    if (ascii(bytes, 0, 4) === 'fLaC') return flac(bytes);
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return wav(bytes);
    if (['ftyp', 'free', 'skip', 'wide'].includes(ascii(bytes, 4, 4))) return mp4(bytes);
    return id3v1(bytes);
  } catch { return {}; }
}

export async function readAudioTags(blob: Blob): Promise<AudioTags> {
  try { return tagsFromBytes(new Uint8Array(await blob.arrayBuffer())); }
  catch { return {}; }
}
