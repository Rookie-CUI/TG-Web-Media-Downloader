import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const code = ts.transpile(await readFile(new URL('../src/telegram/k-viewer-source.ts', import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { waitForKViewerHttpSource } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const candidate = (path) => ({ url: `https://web.telegram.org/k/${path}/video.mp4`, source: 'fetch', contentType: 'video/mp4' });
const set = (captured) => ({ menu: [], viewer: [], captured, performance: [] });
const valid = (entry) => ({ ok: true, status: 206, finalUrl: entry.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/9000' });

test('ready progressive candidate returns immediately, with no timeout sleep or lower-priority probe', async () => {
  let sleeps = 0;
  const probes = [];
  const result = await waitForKViewerHttpSource(async () => set([candidate('stream'), candidate('download'), candidate('progressive')]),
    6500, 180, async () => { sleeps++; }, async (entry) => { probes.push(entry.url); return valid(entry); });
  assert.equal(result.polls, 1);
  assert.equal(sleeps, 0);
  assert.equal(probes.length, 1);
  assert.match(result.candidate.url, /progressive/);
});

test('failed candidate is immediately followed by next candidate in same poll', async () => {
  const probes = [];
  const result = await waitForKViewerHttpSource(async () => set([candidate('progressive'), candidate('download')]),
    6500, 180, async () => { throw new Error('must not sleep between available candidates'); }, async (entry) => {
      probes.push(entry.url);
      return entry.url.includes('/progressive/') ? { ok: false, status: 302, contentType: 'text/html' } : valid(entry);
    });
  assert.equal(result.polls, 1);
  assert.equal(probes.length, 2);
  assert.match(result.candidate.url, /download/);
});

test('stream requires standalone structure proof and cannot outrank a download source', async () => {
  const result = await waitForKViewerHttpSource(async () => set([candidate('stream'), candidate('download')]),
    100, 1, async () => {}, async (entry) => valid(entry));
  assert.match(result.candidate.url, /download/);
  for (const extra of [{}, { standalonePlayable: false }, { standalonePlayable: true, fragmented: true }]) {
    const rejected = await waitForKViewerHttpSource(async () => set([candidate('stream')]),
      0, 1, async () => {}, async entry => ({ ...valid(entry), ...extra }));
    assert.equal(rejected.candidate, null);
  }
  const accepted = await waitForKViewerHttpSource(async () => set([candidate('stream')]),
    0, 1, async () => {}, async entry => ({ ...valid(entry), standalonePlayable: true, fragmented: false }));
  assert.ok(accepted.candidate);
});
