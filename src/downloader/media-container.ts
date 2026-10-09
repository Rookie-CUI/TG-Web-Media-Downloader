/** Byte-based container validation. This proves container structure, not codec decoding. */
export interface MediaContainerInspection {
  detectedContainer: string;
  finalMime: string;
  finalExtension: string;
  firstBox: string;
  standalonePlayable: boolean;
  fragmented: boolean;
  reason: string;
}

export type MediaContainerSource = Blob | {
  size: number;
  read(start: number, endExclusive: number): Promise<ArrayBuffer>;
};

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const uint32 = (bytes: Uint8Array, offset = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
const uint64 = (bytes: Uint8Array, offset = 0) => {
  const value = uint32(bytes, offset) * 0x100000000 + uint32(bytes, offset + 4);
  if (!Number.isSafeInteger(value)) throw new Error('UNSAFE_CONTAINER_OFFSET');
  return value;
};

class Reader {
  readonly size: number;
  private bytesRead = 0;
  private reads = 0;
  constructor(private readonly source: MediaContainerSource) { this.size = source.size; }
  async read(start: number, length: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > this.size) throw new Error('TRUNCATED_CONTAINER');
    if ((this.bytesRead += length) > 8 * 1024 * 1024 || ++this.reads > 50000) throw new Error('CONTAINER_INSPECTION_LIMIT');
    const data = 'read' in this.source
      ? await this.source.read(start, start + length)
      : await this.source.slice(start, start + length).arrayBuffer();
    if (data.byteLength !== length) throw new Error('TRUNCATED_CONTAINER_READ');
    return new Uint8Array(data);
  }
}

interface Box { type: string; start: number; body: number; end: number }
async function boxes(reader: Reader, start: number, end: number): Promise<Box[]> {
  const result: Box[] = [];
  while (start < end) {
    if (result.length >= 10000 || end - start < 8) throw new Error('INVALID_ISO_BOX_BOUNDARY');
    const header = await reader.read(start, 8);
    const type = ascii(header.subarray(4, 8));
    let size = uint32(header);
    let headerSize = 8;
    if (size === 1) { size = uint64(await reader.read(start + 8, 8)); headerSize = 16; }
    if (size === 0) size = end - start;
    if (size < headerSize || start + size > end) throw new Error('TRUNCATED_ISO_BOX');
    result.push({ type, start, body: start + headerSize, end: start + size });
    start += size;
  }
  return result;
}
const requiredBox = (list: Box[], type: string) => {
  const box = list.find((entry) => entry.type === type);
  if (!box) throw new Error(`MISSING_${type.toUpperCase()}`);
  return box;
};
async function boxBytes(reader: Reader, box: Box, offset: number, length: number) {
  if (box.body + offset + length > box.end) throw new Error(`TRUNCATED_${box.type.toUpperCase()}`);
  return reader.read(box.body + offset, length);
}
async function children(reader: Reader, box: Box) { return boxes(reader, box.body, box.end); }
async function tableCount(reader: Reader, box: Box, entrySize: number, countOffset = 4) {
  const count = uint32(await boxBytes(reader, box, countOffset, 4));
  if (box.body + countOffset + 4 + count * entrySize > box.end) throw new Error(`TRUNCATED_${box.type.toUpperCase()}_TABLE`);
  return count;
}

async function inspectIso(reader: Reader, result: MediaContainerInspection) {
  const top = await boxes(reader, 0, reader.size);
  result.firstBox = top[0]?.type || '';
  result.fragmented = top.some((box) => box.type === 'moof' || box.type === 'styp');
  const ftyp = top.find((box) => box.type === 'ftyp');
  let quickTime = !ftyp;
  if (ftyp) {
    const brand = ascii(await boxBytes(reader, ftyp, 0, 4));
    if (ftyp.end - ftyp.body < 8 || (ftyp.end - ftyp.body) % 4 !== 0) throw new Error('INVALID_FTYP');
    quickTime = brand === 'qt  ';
  }
  result.detectedContainer = quickTime ? 'quicktime' : 'mp4';
  result.finalExtension = quickTime ? 'mov' : 'mp4';
  result.finalMime = quickTime ? 'video/quicktime' : 'video/mp4';
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw new Error(result.fragmented ? 'FRAGMENT_MISSING_INITIALIZATION' : 'MISSING_MOOV');
  const movie = await children(reader, moov);
  const mvhd = requiredBox(movie, 'mvhd');
  const movieVersion = (await boxBytes(reader, mvhd, 0, 1))[0];
  if (movieVersion > 1 || mvhd.end - mvhd.body < (movieVersion === 1 ? 112 : 100)) throw new Error('INVALID_MVHD');
  const mediaData = top.filter((box) => box.type === 'mdat' && box.end > box.body);
  if (!mediaData.length) throw new Error('MISSING_MEDIA_PAYLOAD');
  const isPayloadOffset = (offset: number) => mediaData.some((box) => offset >= box.body && offset < box.end);
  const tracks = movie.filter((box) => box.type === 'trak');
  const trackIds = new Set<number>();
  let audioTracks = 0;
  let videoTracks = 0;
  let nonemptyTracks = 0;
  for (const track of tracks) {
    const entries = await children(reader, track);
    const tkhd = requiredBox(entries, 'tkhd');
    const version = (await boxBytes(reader, tkhd, 0, 1))[0];
    if (version > 1 || tkhd.end - tkhd.body < (version === 1 ? 96 : 84)) throw new Error('INVALID_TKHD');
    const trackId = uint32(await boxBytes(reader, tkhd, version === 1 ? 20 : 12, 4));
    if (!trackId || trackIds.has(trackId)) throw new Error('INVALID_TRACK_ID');
    trackIds.add(trackId);
    const media = await children(reader, requiredBox(entries, 'mdia'));
    const mdhd = requiredBox(media, 'mdhd');
    const mediaVersion = (await boxBytes(reader, mdhd, 0, 1))[0];
    if (mediaVersion > 1 || mdhd.end - mdhd.body < (mediaVersion === 1 ? 36 : 24)) throw new Error('INVALID_MDHD');
    const timescale = uint32(await boxBytes(reader, mdhd, mediaVersion === 1 ? 20 : 12, 4));
    if (!timescale) throw new Error('INVALID_MEDIA_TIMESCALE');
    const handler = ascii(await boxBytes(reader, requiredBox(media, 'hdlr'), 8, 4));
    if (handler !== 'vide' && handler !== 'soun') continue;
    if (handler === 'vide') videoTracks += 1; else audioTracks += 1;
    const minf = await children(reader, requiredBox(media, 'minf'));
    const dataInfo = await children(reader, requiredBox(minf, 'dinf'));
    const dref = requiredBox(dataInfo, 'dref');
    const referenceCount = uint32(await boxBytes(reader, dref, 4, 4));
    const references = await boxes(reader, dref.body + 8, dref.end);
    if (!referenceCount || referenceCount !== references.length) throw new Error('INVALID_DATA_REFERENCES');
    const table = await children(reader, requiredBox(minf, 'stbl'));
    const stsd = requiredBox(table, 'stsd');
    const descriptionCount = uint32(await boxBytes(reader, stsd, 4, 4));
    const descriptions = await boxes(reader, stsd.body + 8, stsd.end);
    if (!descriptionCount || descriptions.length !== descriptionCount) throw new Error('MISSING_SAMPLE_DESCRIPTION');
    for (const description of descriptions) {
      if (description.type === 'encv' || description.type === 'enca') throw new Error('ENCRYPTED_MEDIA_UNSUPPORTED');
      if (description.end - description.body < (handler === 'vide' ? 78 : 28)) throw new Error('TRUNCATED_SAMPLE_DESCRIPTION');
      const reference = await boxBytes(reader, description, 6, 2);
      const referenceIndex = reference[0] * 256 + reference[1];
      const dataReference = references[referenceIndex - 1];
      if (!dataReference) throw new Error('INVALID_SAMPLE_DATA_REFERENCE');
      if (!(uint32(await boxBytes(reader, dataReference, 0, 4)) & 1)) throw new Error('EXTERNAL_MEDIA_REFERENCE');
      if (handler === 'vide') {
        const dimensions = await boxBytes(reader, description, 24, 4);
        if (!(dimensions[0] * 256 + dimensions[1]) || !(dimensions[2] * 256 + dimensions[3])) throw new Error('INVALID_VIDEO_DIMENSIONS');
        const codecConfig: Record<string, { box: string; size: number }> = {
          avc1: { box: 'avcC', size: 7 }, avc3: { box: 'avcC', size: 7 },
          hvc1: { box: 'hvcC', size: 23 }, hev1: { box: 'hvcC', size: 23 },
          av01: { box: 'av1C', size: 4 }, vp09: { box: 'vpcC', size: 12 },
        };
        const config = codecConfig[description.type];
        if (config) {
          const descriptor = requiredBox(await boxes(reader, description.body + 78, description.end), config.box);
          await boxBytes(reader, descriptor, 0, config.size);
        }
      }
    }
    const timeCount = await tableCount(reader, requiredBox(table, 'stts'), 8);
    const chunkCount = await tableCount(reader, requiredBox(table, 'stsc'), 12);
    const sizeTable = table.find((box) => box.type === 'stsz' || box.type === 'stz2');
    if (!sizeTable) throw new Error('MISSING_SAMPLE_SIZES');
    const sampleCount = uint32(await boxBytes(reader, sizeTable, 8, 4));
    if (sizeTable.type === 'stsz') {
      const fixedSize = uint32(await boxBytes(reader, sizeTable, 4, 4));
      if (!fixedSize && sizeTable.body + 12 + sampleCount * 4 > sizeTable.end) throw new Error('TRUNCATED_SAMPLE_SIZES');
    } else {
      const fieldSize = (await boxBytes(reader, sizeTable, 7, 1))[0];
      if (![4, 8, 16].includes(fieldSize) || sizeTable.body + 12 + Math.ceil(sampleCount * fieldSize / 8) > sizeTable.end) throw new Error('INVALID_COMPACT_SAMPLE_SIZES');
    }
    const offsets = table.find((box) => box.type === 'stco' || box.type === 'co64');
    if (!offsets) throw new Error('MISSING_CHUNK_OFFSETS');
    const offsetWidth = offsets.type === 'co64' ? 8 : 4;
    const offsetCount = await tableCount(reader, offsets, offsetWidth);
    if (sampleCount) {
      if (!timeCount || !chunkCount || !offsetCount) throw new Error('INCOMPLETE_SAMPLE_TABLES');
      // Validate boundary chunks without loading potentially huge sample tables.
      for (const index of new Set([0, offsetCount - 1])) {
        const value = await boxBytes(reader, offsets, 8 + index * offsetWidth, offsetWidth);
        if (!isPayloadOffset(offsetWidth === 8 ? uint64(value) : uint32(value))) throw new Error('CHUNK_OUTSIDE_MEDIA_PAYLOAD');
      }
      nonemptyTracks += 1;
    }
  }
  if (!videoTracks && !audioTracks) throw new Error('MISSING_AUDIO_VIDEO_TRACK');
  if (!videoTracks && !quickTime) { result.finalExtension = 'm4a'; result.finalMime = 'audio/mp4'; }
  const fragments = top.filter((box) => box.type === 'moof');
  if (fragments.length) {
    const mvex = movie.find((box) => box.type === 'mvex');
    if (!mvex) throw new Error('FRAGMENT_MISSING_INITIALIZATION');
    const defaults = await children(reader, mvex);
    for (const trackId of trackIds) {
      let initialized = false;
      for (const trex of defaults.filter((box) => box.type === 'trex')) {
        if (trex.end - trex.body < 24) throw new Error('TRUNCATED_TREX');
        if (uint32(await boxBytes(reader, trex, 4, 4)) === trackId) initialized = true;
      }
      if (!initialized) throw new Error('FRAGMENT_TRACK_NOT_INITIALIZED');
    }
    for (const fragment of fragments) {
      if (fragment.start < moov.end) throw new Error('FRAGMENT_BEFORE_INITIALIZATION');
      const next = top[top.indexOf(fragment) + 1];
      if (!next || next.type !== 'mdat' || next.end === next.body) throw new Error('FRAGMENT_MISSING_MEDIA_PAYLOAD');
      const content = await children(reader, fragment);
      const mfhd = requiredBox(content, 'mfhd');
      await boxBytes(reader, mfhd, 0, 8);
      let samples = 0;
      for (const traf of content.filter((box) => box.type === 'traf')) {
        const fragmentTrack = await children(reader, traf);
        const tfhd = requiredBox(fragmentTrack, 'tfhd');
        const id = uint32(await boxBytes(reader, tfhd, 4, 4));
        if (!trackIds.has(id)) throw new Error('FRAGMENT_UNKNOWN_TRACK');
        for (const trun of fragmentTrack.filter((box) => box.type === 'trun')) {
          const header = await boxBytes(reader, trun, 0, 8);
          const flags = uint32(header) & 0xffffff;
          const count = uint32(header, 4);
          const perSample = [0x100, 0x200, 0x400, 0x800].filter((flag) => flags & flag).length * 4;
          const extra = (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
          if (trun.body + 8 + extra + count * perSample > trun.end) throw new Error('TRUNCATED_FRAGMENT_SAMPLES');
          samples += count;
        }
      }
      if (!samples) throw new Error('EMPTY_MEDIA_FRAGMENT');
    }
  } else if (!nonemptyTracks) throw new Error('MISSING_MEDIA_SAMPLES');
}

interface Element { id: number; body: number; end: number; unknownSize: boolean }
async function vint(reader: Reader, start: number, end: number, keepMarker: boolean) {
  if (start >= end) throw new Error('TRUNCATED_EBML');
  const first = (await reader.read(start, 1))[0];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > (keepMarker ? 4 : 8) || start + length > end) throw new Error('INVALID_EBML_VINT');
  const bytes = await reader.read(start, length);
  let value = keepMarker ? bytes[0] : bytes[0] & ((1 << (8 - length)) - 1);
  let unknown = !keepMarker && value === ((1 << (8 - length)) - 1);
  for (let index = 1; index < bytes.length; index += 1) { value = value * 256 + bytes[index]; unknown &&= bytes[index] === 255; }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error('UNSAFE_EBML_SIZE');
  return { value, length, unknown };
}
async function elements(reader: Reader, start: number, end: number, allowUnknown = false): Promise<Element[]> {
  const result: Element[] = [];
  while (start < end) {
    if (result.length >= 10000) throw new Error('EBML_ELEMENT_LIMIT');
    const id = await vint(reader, start, end, true);
    const size = await vint(reader, start + id.length, end, false);
    const body = start + id.length + size.length;
    if (size.unknown && !allowUnknown) throw new Error('UNKNOWN_EBML_ELEMENT_SIZE');
    const elementEnd = size.unknown ? end : body + size.value;
    if (elementEnd > end) throw new Error('TRUNCATED_EBML_ELEMENT');
    result.push({ id: id.value, body, end: elementEnd, unknownSize: size.unknown });
    start = elementEnd;
  }
  return result;
}
async function integer(reader: Reader, element: Element) {
  const bytes = await reader.read(element.body, element.end - element.body);
  if (!bytes.length || bytes.length > 8) throw new Error('INVALID_EBML_INTEGER');
  let result = 0;
  for (const byte of bytes) result = result * 256 + byte;
  return result;
}
async function inspectEbml(reader: Reader, result: MediaContainerInspection) {
  result.firstBox = 'EBML';
  const top = await elements(reader, 0, reader.size, true);
  const header = top[0];
  if (header.id !== 0x1a45dfa3 || header.unknownSize) throw new Error('INVALID_EBML_HEADER');
  const metadata = await elements(reader, header.body, header.end);
  const docType = metadata.find((element) => element.id === 0x4282);
  if (!docType || docType.end - docType.body > 16) throw new Error('MISSING_EBML_DOCTYPE');
  const type = ascii(await reader.read(docType.body, docType.end - docType.body));
  if (type !== 'webm' && type !== 'matroska') throw new Error('UNSUPPORTED_EBML_DOCTYPE');
  result.detectedContainer = type === 'webm' ? 'webm' : 'matroska';
  result.finalExtension = type === 'webm' ? 'webm' : 'mkv';
  result.finalMime = type === 'webm' ? 'video/webm' : 'video/x-matroska';
  const segment = top.find((element) => element.id === 0x18538067);
  if (!segment) throw new Error('MISSING_EBML_SEGMENT');
  // Unknown-size clusters need an incremental demuxer; reject rather than guess their boundaries.
  const content = await elements(reader, segment.body, segment.end);
  if (!content.some((element) => element.id === 0x1549a966)) throw new Error('MISSING_EBML_INFO');
  const tracks = content.find((element) => element.id === 0x1654ae6b);
  if (!tracks) throw new Error('MISSING_EBML_TRACKS');
  const trackIds = new Set<number>();
  let hasVideo = false;
  for (const entry of await elements(reader, tracks.body, tracks.end)) {
    if (entry.id !== 0xae) continue;
    const fields = await elements(reader, entry.body, entry.end);
    const number = fields.find((field) => field.id === 0xd7);
    const typeField = fields.find((field) => field.id === 0x83);
    const codec = fields.find((field) => field.id === 0x86);
    if (!number || !typeField || !codec || codec.body === codec.end) throw new Error('INCOMPLETE_EBML_TRACK');
    const trackType = await integer(reader, typeField);
    if (trackType !== 1 && trackType !== 2) continue;
    const id = await integer(reader, number);
    if (!id || trackIds.has(id)) throw new Error('INVALID_EBML_TRACK_ID');
    trackIds.add(id);
    hasVideo ||= trackType === 1;
  }
  if (!trackIds.size) throw new Error('MISSING_AUDIO_VIDEO_TRACK');
  if (!hasVideo && type === 'webm') result.finalMime = 'audio/webm';
  const clusters = content.filter((element) => element.id === 0x1f43b675);
  let payloads = 0;
  for (const cluster of clusters) {
    const fields = await elements(reader, cluster.body, cluster.end);
    if (!fields.some((field) => field.id === 0xe7)) throw new Error('MISSING_CLUSTER_TIMESTAMP');
    for (const field of fields) {
      const blocks = field.id === 0xa0 ? await elements(reader, field.body, field.end) : [field];
      for (const block of blocks.filter((item) => item.id === 0xa3 || item.id === 0xa1)) {
        const track = await vint(reader, block.body, block.end, false);
        if (!trackIds.has(track.value) || block.end - block.body <= track.length + 3) throw new Error('INVALID_EBML_MEDIA_BLOCK');
        payloads += 1;
      }
    }
  }
  if (!payloads) throw new Error('MISSING_MEDIA_PAYLOAD');
}

async function inspectOgg(reader: Reader, result: MediaContainerInspection) {
  result.detectedContainer = 'ogg'; result.finalMime = 'application/ogg'; result.finalExtension = 'ogg'; result.firstBox = 'OggS';
  const streams = new Map<number, { sequence: number; ended: boolean; hasPayload: boolean; continued: boolean }>();
  let offset = 0;
  let audio = false;
  let video = false;
  while (offset < reader.size) {
    const header = await reader.read(offset, 27);
    if (ascii(header.subarray(0, 4)) !== 'OggS' || header[4] !== 0 || (header[5] & ~7)) throw new Error('INVALID_OGG_HEADER');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const serial = view.getUint32(14, true);
    const sequence = view.getUint32(18, true);
    const laces = await reader.read(offset + 27, header[26]);
    const size = laces.reduce((sum, value) => sum + value, 0);
    const payloadStart = offset + 27 + laces.length;
    if (payloadStart + size > reader.size) throw new Error('TRUNCATED_OGG_PAGE');
    const bos = Boolean(header[5] & 2); const eos = Boolean(header[5] & 4);
    let stream = streams.get(serial);
    if (bos) {
      if (stream || sequence !== 0 || (header[5] & 1) || size < 8) throw new Error('INVALID_OGG_BOS');
      stream = { sequence: -1, ended: false, hasPayload: false, continued: false };
      streams.set(serial, stream);
      const magic = ascii(await reader.read(payloadStart, Math.min(size, 16)));
      if (magic.startsWith('OpusHead') || magic.startsWith('\u0001vorbis') || magic.startsWith('Speex   ') || magic.startsWith('\u007fFLAC')) audio = true;
      else if (magic.startsWith('\u0080theora')) video = true;
      else throw new Error('UNSUPPORTED_OGG_CODEC_HEADER');
    }
    if (!stream || stream.ended || sequence !== stream.sequence + 1 || Boolean(header[5] & 1) !== stream.continued) throw new Error('INCOMPLETE_OGG_STREAM');
    stream.sequence = sequence; stream.ended = eos;
    stream.continued = laces.length > 0 && laces[laces.length - 1] === 255;
    if (!bos && size > 0) stream.hasPayload = true;
    if (eos && stream.continued) throw new Error('TRUNCATED_OGG_PACKET');
    offset = payloadStart + size;
  }
  if (!streams.size || [...streams.values()].some((stream) => !stream.ended || !stream.hasPayload)) throw new Error('INCOMPLETE_OGG_STREAM');
  result.finalMime = video ? 'video/ogg' : audio ? 'audio/ogg' : 'application/ogg';
  result.finalExtension = video ? 'ogv' : 'ogg';
}

export async function inspectMediaContainer(source: MediaContainerSource): Promise<MediaContainerInspection> {
  const result: MediaContainerInspection = { detectedContainer: 'unknown', finalMime: '', finalExtension: '', firstBox: '', standalonePlayable: false, fragmented: false, reason: '' };
  try {
    const reader = new Reader(source);
    if (!Number.isSafeInteger(reader.size) || reader.size < 8) throw new Error('EMPTY_OR_TRUNCATED_MEDIA');
    const prefix = await reader.read(0, Math.min(16, reader.size));
    const first = ascii(prefix.subarray(0, 4));
    const boxType = ascii(prefix.subarray(4, 8));
    if (['ftyp', 'styp', 'moof', 'moov', 'mdat', 'wide', 'free', 'skip', 'sidx'].includes(boxType)) await inspectIso(reader, result);
    else if (uint32(prefix) === 0x1a45dfa3) await inspectEbml(reader, result);
    else if (first === 'OggS') await inspectOgg(reader, result);
    else throw new Error('UNRECOGNIZED_MEDIA_CONTAINER');
    result.standalonePlayable = true;
    result.reason = 'STRUCTURAL_CONTAINER_VALIDATION_PASSED';
  } catch (error) {
    result.reason = error instanceof Error ? error.message : 'CONTAINER_INSPECTION_FAILED';
  }
  return result;
}

export function filenameWithContainer(filename: string, extension: string) {
  const safeExtension = extension.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{2,5}$/.test(safeExtension)) throw new Error('INVALID_CONTAINER_EXTENSION');
  const lastSeparator = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const dot = filename.lastIndexOf('.');
  const base = dot > lastSeparator + 1 ? filename.slice(0, dot) : filename;
  return `${base || 'media'}.${safeExtension}`;
}
