// Deterministic structural fixtures; payload is synthetic and is not a playable codec stream.
export const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
export const textBytes = (text) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
export const u32 = (value) => { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value); return result; };
export const box = (type, ...parts) => { const body = concat(...parts); return concat(u32(8 + body.length), textBytes(type), body); };
const fullBox = (type, ...parts) => box(type, u32(0), ...parts);
const setU32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value);

export function createMp4({ payloadSize = 128, moovAtEnd = false, quickTime = false, fragmented = false, omitInit = false } = {}) {
  const payload = Uint8Array.from({ length: payloadSize }, (_, index) => index * 17 % 251);
  const ftyp = box('ftyp', textBytes(quickTime ? 'qt  ' : 'isom'), u32(0), textBytes(quickTime ? 'qt  ' : 'isom'));
  const mvhd = new Uint8Array(100); setU32(mvhd, 12, 1000); setU32(mvhd, 16, 1000);
  const tkhd = new Uint8Array(84); setU32(tkhd, 12, 1);
  const mdhd = new Uint8Array(24); setU32(mdhd, 12, 1000); setU32(mdhd, 16, 1000);
  const hdlr = new Uint8Array(24); hdlr.set(textBytes('vide'), 8);
  const sample = new Uint8Array(78); sample[7] = 1; sample[25] = 16; sample[27] = 16;
  const description = box('avc1', sample, box('avcC', Uint8Array.from([1, 66, 0, 30, 255, 225, 0])));
  const dinf = box('dinf', fullBox('dref', u32(1), box('url ', u32(1))));
  const makeMovie = (payloadOffset) => box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), box('minf', dinf, box('stbl',
    fullBox('stsd', u32(1), description),
    fullBox('stts', u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(1), u32(1000)])),
    fullBox('stsc', u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(1), u32(1), u32(1)])),
    fullBox('stsz', u32(fragmented ? 0 : payloadSize), u32(fragmented ? 0 : 1)),
    fullBox('stco', u32(fragmented ? 0 : 1), ...(fragmented ? [] : [u32(payloadOffset)])),
  )))), ...(fragmented ? [box('mvex', fullBox('trex', u32(1), u32(1), u32(1000), u32(payloadSize), u32(0)))] : []));
  if (fragmented) {
    const moof = box('moof', fullBox('mfhd', u32(1)), box('traf', fullBox('tfhd', u32(1)), fullBox('trun', u32(1))));
    return concat(...(omitInit ? [] : [ftyp, makeMovie(0)]), moof, box('mdat', payload));
  }
  const movieSize = makeMovie(0).length;
  const movie = makeMovie(ftyp.length + (moovAtEnd ? 0 : movieSize) + 8);
  return concat(ftyp, ...(moovAtEnd ? [box('mdat', payload), movie] : [movie, box('mdat', payload)]));
}

const ebmlSize = (size) => {
  for (let length = 1; length <= 4; length += 1) {
    if (size < 2 ** (7 * length) - 1) {
      const result = new Uint8Array(length); let remainder = size;
      for (let index = length - 1; index >= 0; index -= 1) { result[index] = remainder & 255; remainder = Math.floor(remainder / 256); }
      result[0] |= 1 << (8 - length); return result;
    }
  }
  throw new Error('fixture too large');
};
const ebmlId = (id) => { const bytes = []; while (id) { bytes.unshift(id & 255); id = Math.floor(id / 256); } return Uint8Array.from(bytes); };
export const element = (id, ...parts) => { const body = concat(...parts); return concat(ebmlId(id), ebmlSize(body.length), body); };
export function createWebm({ matroska = false, omitTracks = false, omitPayload = false } = {}) {
  const header = element(0x1a45dfa3, element(0x4282, textBytes(matroska ? 'matroska' : 'webm')));
  const info = element(0x1549a966, element(0x2ad7b1, Uint8Array.from([15, 66, 64])));
  const tracks = element(0x1654ae6b, element(0xae, element(0xd7, Uint8Array.of(1)), element(0x73c5, Uint8Array.of(1)), element(0x83, Uint8Array.of(1)), element(0x86, textBytes('V_VP8')), element(0xe0, element(0xb0, Uint8Array.of(16)), element(0xba, Uint8Array.of(16)))));
  const cluster = element(0x1f43b675, element(0xe7, Uint8Array.of(0)), element(0xa3, Uint8Array.from([0x81, 0, 0, 0x80, 1, 2, 3])));
  return concat(header, element(0x18538067, info, ...(omitTracks ? [] : [tracks]), ...(omitPayload ? [] : [cluster])));
}

function oggPage(sequence, flags, payload) {
  const header = new Uint8Array(28); header.set(textBytes('OggS')); header[5] = flags; header[26] = 1; header[27] = payload.length;
  const view = new DataView(header.buffer); view.setUint32(14, 1, true); view.setUint32(18, sequence, true);
  const page = concat(header, payload);
  let crc = 0;
  for (const byte of page) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit += 1) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0); }
  new DataView(page.buffer).setUint32(22, crc >>> 0, true);
  return page;
}
export function createOgg({ omitEnd = false, missingBeginning = false } = {}) {
  const header = concat(textBytes('OpusHead'), Uint8Array.from([1, 1, 0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0]));
  return concat(...(missingBeginning ? [] : [oggPage(0, 2, header)]), oggPage(1, omitEnd ? 0 : 4, Uint8Array.from([0xf8, 0xff, 0xfe])));
}
