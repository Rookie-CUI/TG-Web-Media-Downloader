import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { createMp4, createWebm, createOgg, box, u32, textBytes } from './media-fixtures.mjs';

const code = ts.transpile(await readFile(new URL('../src/downloader/media-container.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { inspectMediaContainer, filenameWithContainer } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('actual MP4 structure overrides an octet-stream hint; filename comes from container', async () => {
  const result = await inspectMediaContainer(new Blob([createMp4()], { type: 'application/octet-stream' }));
  assert.equal(result.standalonePlayable, true, result.reason);
  assert.equal(result.detectedContainer, 'mp4');
  assert.equal(result.firstBox, 'ftyp');
  assert.equal(result.finalMime, 'video/mp4');
  assert.equal(filenameWithContainer('video.bin', result.finalExtension), 'video.mp4');
});

test('video/mp4 declaration does not make arbitrary bytes or ftyp-only data a valid file', async () => {
  for (const bytes of [textBytes('<html>login</html>'), box('ftyp', textBytes('isom'), u32(0), textBytes('isom'))]) {
    const result = await inspectMediaContainer(new Blob([bytes], { type: 'video/mp4' }));
    assert.equal(result.standalonePlayable, false);
  }
});

test('fragment without init is rejected and initialized fragment is distinguished from a progressive file', async () => {
  const result = await inspectMediaContainer(new Blob([createMp4({ fragmented: true, omitInit: true })]));
  assert.equal(result.fragmented, true);
  assert.equal(result.standalonePlayable, false);
  assert.equal(result.reason, 'FRAGMENT_MISSING_INITIALIZATION');
  const initialized = await inspectMediaContainer(new Blob([createMp4({ fragmented: true })]));
  assert.equal(initialized.fragmented, true);
  assert.equal(initialized.standalonePlayable, true, initialized.reason);
});

test('moov at file tail is inspected sparsely rather than rejected for absence in first KB', async () => {
  const bytes = createMp4({ payloadSize: 2 * 1024 * 1024, moovAtEnd: true });
  let inspected = 0;
  const result = await inspectMediaContainer({ size: bytes.length, read: async (start, end) => {
    inspected += end - start;
    return bytes.slice(start, end).buffer;
  } });
  assert.equal(result.standalonePlayable, true, result.reason);
  assert.ok(inspected < 16384, `metadata inspection read ${inspected} bytes`);
});

test('truncated MP4 box and sample offset outside mdat are rejected', async () => {
  const bytes = createMp4();
  assert.equal((await inspectMediaContainer(new Blob([bytes.slice(0, -1)]))).standalonePlayable, false);
  const offset = Buffer.from(bytes).indexOf('stco');
  new DataView(bytes.buffer).setUint32(offset + 12, bytes.length + 100);
  assert.equal((await inspectMediaContainer(new Blob([bytes]))).reason, 'CHUNK_OUTSIDE_MEDIA_PAYLOAD');
});

test('QuickTime, WebM, Matroska and Ogg are identified using bytes', async () => {
  for (const [bytes, expected] of [
    [createMp4({ quickTime: true }), 'quicktime'], [createWebm(), 'webm'],
    [createWebm({ matroska: true }), 'matroska'], [createOgg(), 'ogg'],
  ]) {
    const result = await inspectMediaContainer(new Blob([bytes]));
    assert.equal(result.detectedContainer, expected);
    assert.equal(result.standalonePlayable, true, result.reason);
  }
});

test('WebM without tracks/payload and Ogg without beginning/end are rejected', async () => {
  for (const bytes of [createWebm({ omitTracks: true }), createWebm({ omitPayload: true }), createOgg({ omitEnd: true }), createOgg({ missingBeginning: true })]) {
    assert.equal((await inspectMediaContainer(new Blob([bytes]))).standalonePlayable, false);
  }
});
