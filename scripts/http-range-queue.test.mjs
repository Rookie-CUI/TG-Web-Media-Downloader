import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/downloader/http-range-queue.ts', import.meta.url), 'utf8');
const compiled = ts.transpile(source, { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
const { createHttpRangeState, downloadHttpRangeQueue } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sample = Uint8Array.from({ length: 73 }, (_, i) => (i * 41 + 3) % 256);

function part(data, start, requestedEnd, overrides = {}) {
  const end = Math.min(requestedEnd, data.length - 1);
  return {
    ok: true, status: 206, bytes: data.slice(start, end + 1).buffer,
    contentType: 'application/octet-stream', contentLength: String(end - start + 1),
    contentRange: `bytes ${start}-${end}/${data.length}`, ...overrides,
  };
}

function options(request, overrides = {}) {
  return { request, signal: new AbortController().signal, chunkSize: 16, concurrency: 4, maxRetries: 1, ...overrides };
}

function joined(result) {
  const output = new Uint8Array(result.total);
  let offset = 0;
  for (const chunk of result.chunks) {
    output.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return output;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('four bounded Range workers return byte-identical ordered output despite reverse completion order', async () => {
  const state = createHttpRangeState();
  const pending = [];
  const completionOrder = [];
  const reported = [];
  let inFlight = 0;
  let peak = 0;
  let progressInFlight = 0;
  let progressPeak = 0;
  const running = downloadHttpRangeQueue(state, options(async (start, end) => {
    if (!start) return part(sample, start, end);
    inFlight++;
    peak = Math.max(peak, inFlight);
    const gate = deferred();
    pending.push({ start, gate });
    await gate.promise;
    inFlight--;
    completionOrder.push(start);
    return part(sample, start, end);
  }, {
    concurrency: 20,
    onProgress: async received => {
      progressPeak = Math.max(progressPeak, ++progressInFlight);
      await tick();
      reported.push(received);
      progressInFlight--;
    },
  }));
  while (pending.length < 4) await tick();
  for (const request of [...pending].reverse()) {
    request.gate.resolve();
    await tick();
  }
  const result = await running;
  assert.equal(peak, 4);
  assert.equal(progressPeak, 1);
  assert.deepEqual(completionOrder, [64, 48, 32, 16]);
  assert.deepEqual(joined(result), sample);
  assert.deepEqual([...reported].sort((a, b) => a - b), reported);
  assert.equal(reported.at(-1), sample.length);
});

test('only the transient failed range is retried', async () => {
  const attempts = new Map();
  const result = await downloadHttpRangeQueue(createHttpRangeState(), options(async (start, end) => {
    attempts.set(start, (attempts.get(start) || 0) + 1);
    if (start === 32 && attempts.get(start) === 1) {
      return { ok: false, status: 503, bytes: new ArrayBuffer(0), retryable: true };
    }
    return part(sample, start, end);
  }));
  assert.deepEqual(joined(result), sample);
  assert.equal(attempts.get(32), 2);
  for (const [offset, count] of attempts) if (offset !== 32) assert.equal(count, 1);
});

test('pause aborts four in-flight ranges and resume requests only gaps without corrupting retained bytes', async () => {
  const state = createHttpRangeState();
  const controller = new AbortController();
  const pending = [];
  const abortedOffsets = [];
  const first = downloadHttpRangeQueue(state, options(async (start, end, signal) => {
    if (!start) return part(sample, start, end);
    return new Promise((resolve, reject) => {
      const onAbort = () => { abortedOffsets.push(start); reject(new DOMException('paused', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.push({ start, finish: () => { signal.removeEventListener('abort', onAbort); resolve(part(sample, start, end)); } });
    });
  }, { signal: controller.signal }));
  const rejection = assert.rejects(first, error => error.name === 'AbortError');
  while (pending.length < 4) await tick();
  pending.find(item => item.start === 48).finish();
  while (!state.parts.has(48)) await tick();
  controller.abort();
  await rejection;
  assert.deepEqual([...state.parts.keys()].sort((a, b) => a - b), [0, 48]);
  assert.deepEqual(abortedOffsets.sort((a, b) => a - b), [16, 32, 64]);
  const resumedOffsets = [];
  const result = await downloadHttpRangeQueue(state, options(async (start, end) => {
    resumedOffsets.push(start);
    return part(sample, start, end);
  }));
  assert.deepEqual(resumedOffsets.sort((a, b) => a - b), [16, 32, 64]);
  assert.deepEqual(joined(result), sample);
});

test('cancel rejects, retains no late bytes, and a fresh cancelled state starts no request', async () => {
  const controller = new AbortController();
  const state = createHttpRangeState();
  const gate = deferred();
  const running = downloadHttpRangeQueue(state, options(async (start, end) => {
    if (!start) return part(sample, start, end);
    await gate.promise; // Simulate a transport that ignores cancellation.
    return part(sample, start, end);
  }, { signal: controller.signal }));
  const rejection = assert.rejects(running, error => error.name === 'AbortError');
  while (state.parts.size !== 1) await tick();
  controller.abort();
  await rejection;
  gate.resolve();
  await tick();
  assert.deepEqual([...state.parts.keys()], [0]);
  let requests = 0;
  await assert.rejects(downloadHttpRangeQueue(createHttpRangeState(), options(async () => { requests++; }, { signal: controller.signal })), error => error.name === 'AbortError');
  assert.equal(requests, 0);
});

test('short valid 206 responses continue within each assigned range until no holes remain', async () => {
  const calls = [];
  const result = await downloadHttpRangeQueue(createHttpRangeState(), options(async (start, end) => {
    calls.push({ start, end });
    return part(sample, start, Math.min(start + 4, end));
  }));
  assert.deepEqual(joined(result), sample);
  assert.equal(new Set(calls.map(call => call.start)).size, calls.length);
  assert.ok(calls.some(call => call.start === 5));
});

test('initial full HTTP 200 is accepted only with a complete matching body and no partial-range header', async () => {
  let requests = 0;
  const result = await downloadHttpRangeQueue(createHttpRangeState(), options(async () => {
    requests++;
    return { ok: true, status: 200, bytes: sample.buffer, contentLength: String(sample.length), contentType: 'video/mp4' };
  }));
  assert.equal(requests, 1);
  assert.deepEqual(joined(result), sample);
  for (const invalid of [
    { contentLength: undefined },
    { contentLength: String(sample.length + 1) },
    { contentRange: `bytes 0-${sample.length - 1}/${sample.length + 20}` },
  ]) {
    await assert.rejects(downloadHttpRangeQueue(createHttpRangeState(), options(async () => ({
      ok: true, status: 200, bytes: sample.buffer, contentLength: String(sample.length), ...invalid,
    }))), error => ['RANGE_NOT_HONORED', 'CONTENT_LENGTH_MISMATCH'].includes(error.code));
  }
});

test('invalid Content-Range, wrong byte lengths, total changes and later HTTP 200 are terminal without retries', async () => {
  const cases = [
    { override: { contentRange: 'bytes 17-31/73' }, code: 'INVALID_CONTENT_RANGE' },
    { override: { contentRange: 'bytes 16-32/73' }, code: 'INVALID_CONTENT_RANGE' },
    { override: { contentRange: 'bytes 16-30/73' }, code: 'INVALID_CONTENT_RANGE' },
    { override: { contentRange: 'bytes 16-31/*' }, code: 'INVALID_CONTENT_RANGE' },
    { override: { contentRange: 'bytes 16-31/9007199254740992' }, code: 'INVALID_CONTENT_RANGE' },
    { override: { contentRange: 'bytes 16-31/74' }, code: 'CONTENT_RANGE_TOTAL_CHANGED' },
    { override: { contentLength: '15' }, code: 'CONTENT_LENGTH_MISMATCH' },
    { override: { status: 200, contentRange: '' }, code: 'RANGE_NOT_HONORED' },
    { override: { status: 302 }, code: 'HTTP_REDIRECT_NOT_FOLLOWED' },
    { override: { contentType: 'text/html' }, code: 'NON_MEDIA_RESPONSE' },
  ];
  for (const entry of cases) {
    let requests = 0;
    const state = createHttpRangeState();
    await assert.rejects(downloadHttpRangeQueue(state, options(async (start, end) => {
      if (start === 16) requests++;
      return part(sample, start, end, start === 16 ? entry.override : {});
    }, { maxRetries: 3 })), error => error.code === entry.code);
    assert.equal(requests, 1, entry.code);
    assert.equal(state.parts.has(16), false, entry.code);
  }
});

test('terminal protocol failure cancels sibling transports before the queue rejects', async () => {
  const cancellations = [];
  const gate = deferred();
  let siblings = 0;
  const state = createHttpRangeState();
  const running = downloadHttpRangeQueue(state, options(async (start, end, signal) => {
    if (!start) return part(sample, start, end);
    if (start === 16) {
      await gate.promise;
      return part(sample, start, end, { contentRange: 'bytes 16-31/999' });
    }
    siblings++;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { cancellations.push(start); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    });
  }));
  const rejected = assert.rejects(running, error => error.code === 'CONTENT_RANGE_TOTAL_CHANGED');
  while (siblings < 3) await tick();
  gate.resolve();
  await rejected;
  assert.deepEqual(cancellations.sort((a, b) => a - b), [32, 48, 64]);
  assert.deepEqual([...state.parts.keys()], [0]);
});
