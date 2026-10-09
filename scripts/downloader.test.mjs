import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { createMp4 } from './media-fixtures.mjs';

async function loadHelper(filename) {
  const code = ts.transpile(await readFile(new URL(`../src/downloader/${filename}.ts`, import.meta.url), 'utf8'), { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const [containerHelper, rangeHelper] = await Promise.all([loadHelper('media-container'), loadHelper('http-range-queue')]);

async function loadDownloader(fetchImpl, blobBridge = {}) {
  const source = await readFile(fileURLToPath(new URL('../src/downloader/downloader.ts', import.meta.url)), 'utf8');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const events = [];
  const saved = [];
  const pageMessages = [];
  const rangeMessages = [];
  const windowListeners = new Map();
  const rangeRequests = new Map();
  const pageControllers = new Map();
  const logs = [];
  let id = 0;
  class TestURL extends URL {
    static createObjectURL(blob) {
      const objectUrl = `blob:test-${saved.length}`;
      saved.push({ blob, filename: '' });
      return objectUrl;
    }
    static revokeObjectURL() {}
  }
  const pageBlob = blobBridge.blob || new Blob([Uint8Array.from([1, 2, 3, 4, 5])], { type: 'video/mp4' });
  const scheduleWindowTimer = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  };
  const window = {
    setTimeout: scheduleWindowTimer,
    clearTimeout,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
    postMessage(message) {
      pageMessages.push(message);
      if (message.kind === 'CANCEL_PAGE_MEDIA_RANGE') {
        pageControllers.get(message.requestId)?.abort();
        return;
      }
      const dispatch = (data) => {
        for (const listener of windowListeners.get('message') || []) listener({ source: window, data });
      };
      if (message.kind === 'FETCH_PAGE_MEDIA_RANGE') {
        const controller = new AbortController();
        pageControllers.set(message.requestId, controller);
        const init = { headers: { Range: `bytes=${message.start}-${message.end}` }, credentials: 'include', redirect: 'follow', signal: controller.signal };
        void fetchImpl(message.url, init).then(async (response) => {
          const bytes = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
          queueMicrotask(() => dispatch({
            mark: message.mark, type: 'FETCH_PAGE_MEDIA_RANGE_RESPONSE', requestId: message.requestId,
            ok: response.ok, status: response.status, finalUrl: response.url || message.url,
            redirected: Boolean(response.redirected), contentType: response.headers.get('Content-Type') || '',
            contentLength: response.headers.get('Content-Length') || String(bytes.byteLength),
            contentRange: response.headers.get('Content-Range') || '', acceptRanges: response.headers.get('Accept-Ranges') || '',
            returnedBytes: bytes.byteLength, bytes: message.responseEncoding === 'arraybuffer' ? bytes : Buffer.from(bytes).toString('base64'),
            retryable: response.status >= 300 && response.status < 400 ? false : undefined,
            code: response.status >= 300 && response.status < 400 ? 'HTTP_REDIRECT_NOT_FOLLOWED' : undefined,
            error: response.status >= 300 && response.status < 400 ? `HTTP ${response.status}` : undefined,
          }));
        }).catch((error) => queueMicrotask(() => dispatch({
          mark: message.mark, type: 'FETCH_PAGE_MEDIA_RANGE_RESPONSE', requestId: message.requestId,
          ok: false, status: 0, retryable: true, code: 'PAGE_MEDIA_FETCH_FAILED', error: error.message,
        }))).finally(() => pageControllers.delete(message.requestId));
      }
      if (message.kind === 'GET_BLOB_META') {
        queueMicrotask(() => dispatch({ mark: message.mark, kind: blobBridge.metaError ? 'BLOB_ERROR' : 'BLOB_META', requestId: message.requestId, total: blobBridge.total ?? pageBlob.size, mimeType: blobBridge.mimeType ?? pageBlob.type, cacheState: blobBridge.cacheState || 'hit', error: blobBridge.metaError?.message, code: blobBridge.metaError?.code }));
      } else if (message.kind === 'READ_BLOB') {
        if (blobBridge.readError) {
          queueMicrotask(() => dispatch({ mark: message.mark, kind: 'BLOB_ERROR', requestId: message.requestId, error: blobBridge.readError.message, code: blobBridge.readError.code || 'BLOB_READ_FAILED', objectUrlKind: 'blob', cacheState: blobBridge.cacheState || 'hit' }));
        } else {
          void pageBlob.slice(message.start, message.end + 1).arrayBuffer().then((bytes) => {
            queueMicrotask(() => dispatch({ mark: message.mark, kind: 'BLOB_PART', requestId: message.requestId, bytes, total: blobBridge.total ?? pageBlob.size, mimeType: blobBridge.mimeType ?? pageBlob.type, objectUrlKind: 'blob', cacheState: blobBridge.cacheState || 'hit' }));
          });
        }
      } else if (message.kind === 'RELEASE_BLOB') {
        queueMicrotask(() => dispatch({ mark: message.mark, kind: 'BLOB_RELEASE_RESULT', requestId: message.requestId, ok: true, released: true, objectUrlKind: 'blob', cacheState: 'miss' }));
      }
    },
  };
  const context = vm.createContext({
    module: { exports: {} },
    require: (name) => {
      if (name === './media-container') return containerHelper;
      if (name === './http-range-queue') return rangeHelper;
      if (name === '../storage/local') return { getSettings: async () => ({ chunkSizeMb: 1, maxRetries: 1 }) };
      if (name === '../utils/errors') return {
        formatError(error) {
          if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
          if (typeof error === 'string') return { name: 'Error', message: error };
          const value = error && typeof error === 'object' ? error : {};
          const nested = value.message ?? value.error?.message ?? value.error ?? '未知错误';
          return {
            name: String(value.name || 'Error'), message: String(nested), status: Number(value.status) || undefined,
            code: value.code ? String(value.code) : undefined, requestId: value.requestId ? String(value.requestId) : undefined,
          };
        },
        formatErrorLog(prefix, error, context = {}) {
          const value = error && typeof error === 'object' ? error : {};
          const name = String(value.name || (error instanceof Error ? error.name : 'Error'));
          const message = String(value.message || error || '未知错误');
          return `${prefix}: name=${name} message=${message} code=${value.code || 'n/a'} requestId=${value.requestId || 'n/a'} ${Object.entries(context).map(([key, entry]) => `${key}=${entry}`).join(' ')}`;
        },
      };
      if (name === '../utils/structured-clone') return { cloneStructuredMessage: (message) => structuredClone(message) };
      throw new Error(`Unexpected import: ${name}`);
    },
    Date, Map, Blob, URL: TestURL, ArrayBuffer, Uint8Array, AbortController, DOMException, atob, structuredClone,
    console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    crypto: { randomUUID: () => `task-${++id}` },
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    window,
    document: {
      body: { append() {} },
      createElement() {
        return {
          style: {},
          download: '',
          href: '',
          click() { saved.at(-1).filename = this.download; },
          remove() {},
        };
      },
    },
    chrome: { runtime: { sendMessage: async (message) => {
      if (message.type === 'CANCEL_MEDIA_RANGE') {
        rangeRequests.get(message.requestId)?.abort();
        return { ok: true };
      }
      if (message.type === 'FETCH_MEDIA_RANGE') {
        rangeMessages.push({ ...message });
        const controller = new AbortController();
        rangeRequests.set(message.requestId, controller);
        try {
          const response = await fetchImpl(message.url, {
            headers: { Range: `bytes=${message.start}-${message.end}` },
            credentials: 'include',
            redirect: 'follow',
            signal: controller.signal,
          });
          const contentType = response.headers.get('Content-Type') || '';
          const finalUrl = response.url || message.url;
          const isHtml = contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html';
          const isRedirect = response.status >= 300 && response.status < 400;
          if (isRedirect || isHtml) {
            return {
              ok: false,
              status: response.status,
              contentType,
              finalUrl,
              redirected: Boolean(response.redirected),
              error: isHtml ? '媒体 Range 请求返回 text/html 页面，而不是媒体数据' : `Telegram 重定向未被 fetch 跟随：HTTP ${response.status}`,
              code: isHtml ? 'NON_MEDIA_RESPONSE' : 'HTTP_REDIRECT_NOT_FOLLOWED',
              retryable: false,
              returnedBytes: 0,
            };
          }
          const bytes = response.ok ? await response.arrayBuffer() : new ArrayBuffer(0);
          return {
            ok: response.ok,
            status: response.status,
            contentType,
            finalUrl,
            redirected: Boolean(response.redirected),
            contentLength: response.headers.get('Content-Length') || '',
            contentRange: response.headers.get('Content-Range') || '',
            acceptRanges: response.headers.get('Accept-Ranges') || '',
            bytes: Buffer.from(bytes).toString('base64'),
          };
        } finally {
          rangeRequests.delete(message.requestId);
        }
      }
      events.push({ ...message.task });
      return { ok: true };
    } } },
  });
  context.exports = context.module.exports;
  const module = context.module;
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return { Downloader: module.exports.Downloader, events, saved, pageMessages, rangeMessages, logs };
}

function rangedResponse(start, requestedEnd, total, contentType = 'application/octet-stream') {
  const end = Math.min(start + 2, requestedEnd, total - 1);
  const bytes = Uint8Array.from({ length: end - start + 1 }, (_, index) => (start + index) % 256).buffer;
  return {
    ok: true,
    status: 206,
    headers: { get: (name) => name.toLowerCase() === 'content-range' ? `bytes ${start}-${end}/${total}` : name.toLowerCase() === 'content-type' ? contentType : null },
    arrayBuffer: async () => bytes,
  };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const media = {
  id: 'message-1:file-1',
  url: 'https://files.telegram-cdn.org/media.bin',
  filename: 'sample.bin',
  size: 6,
  mimeType: 'application/octet-stream',
  kind: 'file',
  messageId: 'message-1',
  peerId: 'peer-1',
  fileId: 'file-1',
  source: 'fetch',
  capturedAt: Date.now(),
};

const kVideo = (mimeType = 'video/mp4', url = 'https://web.telegram.org/k/progressive/video.bin') => ({
  ...media, url, filename: 'video.bin', size: 0, kind: 'video', mimeType, requiresPageTransport: true,
  kSingleVideo: { viewerOpenMs: 50, candidateDiscoveryMs: 20, probeMs: 30, resolvedAt: Date.now() },
});
function payloadResponse(payload, init, mime = 'video/mp4') {
  const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
  const end = Math.min(requestedEnd, payload.length - 1);
  return { ok: true, status: 206, headers: { get: (name) => ({
    'content-type': mime, 'content-range': `bytes ${start}-${end}/${payload.length}`,
    'content-length': String(end - start + 1),
  }[name.toLowerCase()] || null) }, arrayBuffer: async () => payload.slice(start, end + 1).buffer };
}

test('K 单视频 octet-stream 实际 MP4 在保存前检查容器并使用 .mp4', async () => {
  const payload = createMp4();
  const h = await loadDownloader(async (_url, init) => payloadResponse(payload, init, 'application/octet-stream'));
  await new h.Downloader().start(kVideo('application/octet-stream'));
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].filename, 'video.mp4');
  assert.equal(h.saved[0].blob.type, 'video/mp4');
  assert.deepEqual(new Uint8Array(await h.saved[0].blob.arrayBuffer()), payload);
  assert.equal(h.events.at(-1).status, 'completed');
  const container = h.logs.find(([label]) => label === '[TG Downloader][container]')[1];
  assert.equal(container.detectedContainer, 'mp4');
  assert.equal(container.standalonePlayable, true);
  assert.ok(h.pageMessages.filter(m => m.kind === 'FETCH_PAGE_MEDIA_RANGE').every(m => m.responseEncoding === 'arraybuffer'));
  assert.equal(h.rangeMessages.length, 0);
});

test('K 单视频伪 video/mp4 和缺初始化 stream 均不保存且不标 completed', async () => {
  for (const payload of [new Uint8Array(512).fill(88), createMp4({ fragmented: true, omitInit: true })]) {
    const h = await loadDownloader(async (_url, init) => payloadResponse(payload, init));
    await assert.rejects(new h.Downloader().start(kVideo('video/mp4', 'https://web.telegram.org/k/stream/video.mp4')),
      error => error.code === 'MEDIA_CONTAINER_NOT_STANDALONE');
    assert.equal(h.saved.length, 0);
    assert.equal(h.events.at(-1).status, 'failed');
    assert.equal(h.events.some(e => e.status === 'completed'), false);
  }
});

let largeVideo;
const getLargeVideo = () => largeVideo ||= createMp4({ payloadSize: 20 * 1024 * 1024 + 137 });
test('K Downloader 四分片乱序完成后保存结果与输入逐字节相同', async () => {
  const payload = getLargeVideo();
  let inFlight = 0;
  let peak = 0;
  const h = await loadDownloader(async (_url, init) => {
    const start = Number(init.headers.Range.match(/bytes=(\d+)/)[1]);
    peak = Math.max(peak, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, start ? 25 - (start / (4 * 1024 * 1024)) * 3 : 0));
    inFlight--;
    return payloadResponse(payload, init);
  });
  await new h.Downloader().start(kVideo());
  assert.equal(peak, 4);
  assert.equal(h.saved.length, 1);
  assert.equal(Buffer.compare(Buffer.from(await h.saved[0].blob.arrayBuffer()), Buffer.from(payload)), 0);
});

test('K Downloader 多 Range 暂停中止全部在途请求，恢复后按偏移保存完整文件', async () => {
  const payload = getLargeVideo();
  let resumed = false;
  let pending = 0;
  const offsets = [];
  const h = await loadDownloader(async (_url, init) => {
    const start = Number(init.headers.Range.match(/bytes=(\d+)/)[1]);
    offsets.push(start);
    if (!start || resumed) return payloadResponse(payload, init);
    pending++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      pending--; reject(new DOMException('pause', 'AbortError'));
    }, { once: true }));
  });
  const downloader = new h.Downloader();
  const initialRun = downloader.start(kVideo());
  await waitFor(() => pending === 4, 'four in-flight page ranges');
  const taskId = h.events[0].id;
  await downloader.pause(taskId);
  await initialRun;
  assert.equal(pending, 0);
  assert.equal(h.events.at(-1).status, 'paused');
  assert.equal(h.saved.length, 0);
  resumed = true;
  await downloader.resume(taskId);
  assert.equal(offsets.filter(start => start === 0).length, 1, 'retained first range must not be fetched again');
  assert.equal(Buffer.compare(Buffer.from(await h.saved[0].blob.arrayBuffer()), Buffer.from(payload)), 0);
  assert.equal(h.events.at(-1).status, 'completed');
});

test('K Downloader cancel 中止所有 Range 且不能保存/恢复已取消任务', async () => {
  const payload = getLargeVideo();
  let pending = 0;
  const h = await loadDownloader(async (_url, init) => {
    if (init.headers.Range.startsWith('bytes=0-')) return payloadResponse(payload, init);
    pending++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      pending--; reject(new DOMException('cancel', 'AbortError'));
    }, { once: true }));
  });
  const downloader = new h.Downloader();
  const rejected = assert.rejects(downloader.start(kVideo()), error => error.code === 'DOWNLOAD_CANCELLED');
  await waitFor(() => pending === 4, 'four in-flight cancellation requests');
  const taskId = h.events[0].id;
  await downloader.cancel(taskId);
  await rejected;
  await downloader.resume(taskId);
  assert.equal(pending, 0);
  assert.equal(h.saved.length, 0);
  assert.equal(h.events.some(e => e.status === 'completed'), false);
});

test('下载成功会覆盖完整状态并生成文件 Blob', async () => {
  const ranges = [];
  const harness = await loadDownloader(async (_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    ranges.push([start, requestedEnd]);
    return rangedResponse(start, requestedEnd, media.size);
  });
  const downloader = new harness.Downloader();
  await downloader.start(media);
  const statuses = harness.events.map((task) => task.status);
  for (const status of ['pending', 'resolving', 'downloading', 'completed']) assert.ok(statuses.includes(status), `missing ${status}; events=${JSON.stringify(harness.events)}`);
  assert.deepEqual(ranges.map(([start]) => start), [0, 3]);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].blob.size, media.size);
  assert.equal(harness.saved[0].filename, media.filename);
});

test('暂停后继续从已完成的 Range 偏移恢复', async () => {
  let calls = 0;
  const ranges = [];
  const harness = await loadDownloader((_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    ranges.push(start);
    calls += 1;
    if (calls === 2) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true });
      });
    }
    return Promise.resolve(rangedResponse(start, requestedEnd, media.size));
  });
  const downloader = new harness.Downloader();
  const firstRun = downloader.start(media);
  await waitFor(() => calls === 2, 'second range request');
  const taskId = harness.events[0].id;
  await downloader.pause(taskId);
  await waitFor(() => harness.events.some((task) => task.status === 'paused'), 'paused state');
  await downloader.resume(taskId);
  await firstRun;
  const statuses = harness.events.map((task) => task.status);
  assert.ok(statuses.includes('paused'));
  assert.ok(statuses.includes('completed'), JSON.stringify(harness.events));
  assert.deepEqual(ranges, [0, 3, 3]);
  assert.equal(harness.saved[0].blob.size, media.size);
});

test('网络失败超过重试次数后进入 failed', async () => {
  let calls = 0;
  const harness = await loadDownloader(async () => {
    calls += 1;
    throw new Error('simulated network failure');
  });
  const downloader = new harness.Downloader();
  await assert.rejects(downloader.start(media), /simulated network failure/);
  assert.equal(calls, 2);
  assert.equal(harness.events.at(-1).status, 'failed');
  assert.match(harness.events.at(-1).error, /simulated network failure/);
});

test('无效 Content-Range 仍失败，不会合并错位字节', async () => {
  const harness = await loadDownloader(async (_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    const wrongStart = start + 1;
    const end = Math.min(wrongStart + 2, requestedEnd, media.size - 1);
    const bytes = Uint8Array.from({ length: end - wrongStart + 1 }, (_, index) => (wrongStart + index) % 256).buffer;
    return {
      ok: true,
      status: 206,
      headers: { get: (name) => name.toLowerCase() === 'content-range' ? `bytes ${wrongStart}-${end}/${media.size}` : name.toLowerCase() === 'content-type' ? 'application/octet-stream' : null },
      arrayBuffer: async () => bytes,
    };
  });
  const downloader = new harness.Downloader();
  await assert.rejects(downloader.start(media), /范围|Content-Range/);
  assert.equal(harness.events.at(-1).status, 'failed');
  assert.match(harness.events.at(-1).error, /范围|Content-Range/);
  assert.equal(harness.saved.length, 0);
});

test('未由用户暂停触发的 AbortError 记为 failed 并向批量调用方传递', async () => {
  const harness = await loadDownloader(async () => {
    throw new DOMException('Unexpected fetch abort', 'AbortError');
  });
  const downloader = new harness.Downloader();
  await assert.rejects(downloader.start(media), (error) => error.name === 'AbortError' && error.message === 'Unexpected fetch abort');
  assert.equal(harness.events.at(-1).status, 'failed');
  assert.match(harness.events.at(-1).error, /Unexpected fetch abort/);
});

test('最终文件 MIME 和扩展名来自 Range 响应，不按 kind 强制写 mp4', async () => {
  const harness = await loadDownloader(async (_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return rangedResponse(start, requestedEnd, media.size, 'video/webm');
  });
  const downloader = new harness.Downloader();
  await downloader.start(media);
  assert.equal(harness.saved[0].blob.type, 'video/webm');
  assert.equal(harness.saved[0].filename, 'sample.webm');
});

test('实际 video Content-Type 会纠正与响应不符的缩略图扩展名', async () => {
  const harness = await loadDownloader(async (_url, init) => {
    const [start, requestedEnd] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return rangedResponse(start, requestedEnd, media.size, 'video/mp4');
  });
  const downloader = new harness.Downloader();
  await downloader.start({ ...media, filename: 'thumbnail.jpg' });
  assert.equal(harness.saved[0].blob.type, 'video/mp4');
  assert.equal(harness.saved[0].filename, 'thumbnail.mp4');
});

test('Blob size=0 时先读取 bridge 元数据，再按已知总大小读取分片', async () => {
  const bridge = new Blob([Uint8Array.from([9, 8, 7, 6, 5])], { type: 'video/mp4' });
  const harness = await loadDownloader(async () => { throw new Error('HTTP transport must not be used for blob URLs'); }, { blob: bridge, cacheState: 'hit' });
  const downloader = new harness.Downloader();
  await downloader.start({ ...media, url: 'blob:https://web.telegram.org/video', size: 0, mimeType: '' });
  assert.deepEqual(harness.pageMessages.map((message) => message.kind), ['GET_BLOB_META', 'READ_BLOB']);
  assert.equal(harness.events.at(-1).status, 'completed');
  assert.equal(harness.events.at(-1).size, bridge.size);
  assert.equal(harness.saved[0].blob.size, bridge.size);
  assert.equal(harness.saved[0].blob.type, 'video/mp4');
});

test('已知 Blob 大小保留快速路径，不请求元数据', async () => {
  const bridge = new Blob([Uint8Array.from([1, 2, 3])], { type: 'video/mp4' });
  const harness = await loadDownloader(async () => { throw new Error('HTTP transport must not be used for blob URLs'); }, { blob: bridge });
  await new harness.Downloader().start({ ...media, url: 'blob:https://web.telegram.org/video', size: bridge.size });
  assert.deepEqual(harness.pageMessages.map((message) => message.kind), ['READ_BLOB']);
  assert.equal(harness.saved[0].blob.size, bridge.size);
});

test('K Viewer pin 后 Downloader 跳过 metadata miss，读取 lease Blob 并成功后 release', async () => {
  const bridge = new Blob([Uint8Array.from([9, 8, 7, 6])], { type: 'video/mp4' });
  const harness = await loadDownloader(async () => { throw new Error('HTTP transport must not be used for pinned blobs'); }, { blob: bridge });
  const downloader = new harness.Downloader();
  await downloader.start({
    ...media, url: 'blob:https://web.telegram.org/pinned-video', size: bridge.size,
    mimeType: bridge.type, blobLeaseId: 'lease-k-1', objectUrlKind: 'blob',
  });
  const requests = harness.pageMessages.filter((message) => ['GET_BLOB_META', 'READ_BLOB', 'RELEASE_BLOB'].includes(message.kind));
  assert.deepEqual(requests.map((message) => message.kind), ['READ_BLOB', 'RELEASE_BLOB']);
  assert.equal(requests[0].leaseId, 'lease-k-1');
  assert.equal(requests[1].leaseId, 'lease-k-1');
  assert.equal(harness.events.at(-1).status, 'completed');
  assert.equal(harness.saved[0].blob.size, bridge.size);
});

test('Pinned Blob 下载失败后仍释放 lease', async () => {
  const bridge = new Blob([Uint8Array.from([1, 2, 3])], { type: 'video/mp4' });
  const harness = await loadDownloader(async () => { throw new Error('HTTP transport must not be used for pinned blobs'); }, {
    blob: bridge, readError: Object.assign(new Error('simulated pinned Blob read failure'), { code: 'BLOB_READ_FAILED' }),
  });
  await assert.rejects(harness.Downloader && new harness.Downloader().start({
    ...media, url: 'blob:https://web.telegram.org/pinned-video-failure', size: bridge.size,
    mimeType: bridge.type, blobLeaseId: 'lease-k-fail', objectUrlKind: 'blob',
  }), /simulated pinned Blob read failure/);
  const releases = harness.pageMessages.filter((message) => message.kind === 'RELEASE_BLOB');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].leaseId, 'lease-k-fail');
  assert.equal(harness.events.at(-1).status, 'failed');
});

test('Blob 元数据确认真实大小为零时才返回 BLOB_SIZE_UNKNOWN', async () => {
  const harness = await loadDownloader(async () => { throw new Error('HTTP transport must not be used for blob URLs'); }, {
    blob: new Blob([], { type: 'video/mp4' }), total: 0,
  });
  await assert.rejects(new harness.Downloader().start({ ...media, url: 'blob:https://web.telegram.org/empty', size: 0 }), (error) => error.code === 'BLOB_SIZE_UNKNOWN');
  assert.deepEqual(harness.pageMessages.map((message) => message.kind), ['GET_BLOB_META']);
  assert.equal(harness.events.at(-1).status, 'failed');
  assert.ok(harness.events.length > 0);
});

test('A progressive 地址继续走 HTTP Range，并接受重定向后的 206 响应', async () => {
  const requested = [];
  const harness = await loadDownloader(async (url, init) => {
    requested.push({ url, range: init.headers.Range, redirect: init.redirect, credentials: init.credentials });
    const [start, end] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    const response = rangedResponse(start, end, media.size, 'video/mp4');
    response.url = 'https://cdn.telegram.org/file/final/video.mp4';
    response.redirected = true;
    return response;
  });
  await new harness.Downloader().start({ ...media, url: 'https://cdn.telegram.org/file/progressive/id/video.mp4' });
  assert.ok(requested.length > 0);
  assert.ok(requested.every(({ url }) => url.includes('/progressive/')));
  assert.ok(requested.every(({ redirect }) => redirect === 'follow'));
  assert.ok(requested.every(({ credentials }) => credentials === 'include'));
  assert.ok(harness.pageMessages.some((message) => message.kind === 'FETCH_PAGE_MEDIA_RANGE'));
  assert.equal(harness.saved[0].blob.size, media.size);
});

test('A progressive HTTP 302 被标记为终止错误，不按普通 Range 错误机械重试', async () => {
  let fetchCount = 0;
  const harness = await loadDownloader(async () => {
    fetchCount += 1;
    return {
      ok: false, status: 302, url: 'https://web.telegram.org/redirect', redirected: false,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : name.toLowerCase() === 'location' ? '/login' : null },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  await assert.rejects(new harness.Downloader().start({ ...media, url: 'https://web.telegram.org/file/progressive/id/video.mp4' }), /302|重定向/);
  assert.equal(fetchCount, 1);
  assert.equal(harness.pageMessages.filter((message) => message.kind === 'FETCH_PAGE_MEDIA_RANGE').length, 1);
  assert.equal(harness.events.at(-1).status, 'failed');
});

test('K Viewer /download/ 媒体来源使用页面 Range bridge，不进入 background', async () => {
  const harness = await loadDownloader(async (_url, init) => {
    const [start, end] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return rangedResponse(start, end, media.size, 'video/mp4');
  });
  await new harness.Downloader().start({
    ...media,
    url: 'https://web.telegram.org/k/download/video.mp4',
    mimeType: 'video/mp4',
  });
  assert.ok(harness.pageMessages.some((message) => message.kind === 'FETCH_PAGE_MEDIA_RANGE'));
  assert.equal(harness.rangeMessages.length, 0);
  assert.equal(harness.saved.length, 1);
});

test('已通过 K Viewer 页面预检的普通 URL 保持页面 Range transport', async () => {
  const harness = await loadDownloader(async (_url, init) => {
    const [start, end] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return rangedResponse(start, end, media.size, 'video/mp4');
  });
  await new harness.Downloader().start({
    ...media,
    url: 'https://cdn.telegram.org/media/opaque-id',
    mimeType: 'video/mp4',
    requiresPageTransport: true,
  });
  assert.ok(harness.pageMessages.some((message) => message.kind === 'FETCH_PAGE_MEDIA_RANGE'));
  assert.equal(harness.rangeMessages.length, 0);
  assert.equal(harness.saved.length, 1);
});

test('Background Range 的 302/HTML 失败只请求一次，不触发普通错误重试', async () => {
  let fetchCount = 0;
  const harness = await loadDownloader(async () => {
    fetchCount += 1;
    return {
      ok: false, status: 302, url: 'https://web.telegram.org/login', redirected: false,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : name.toLowerCase() === 'location' ? '/login' : null },
      arrayBuffer: async () => { throw new Error('HTML response must not be read as media bytes'); },
    };
  });
  await assert.rejects(new harness.Downloader().start(media), /302|重定向|text\/html/);
  assert.equal(fetchCount, 1);
  assert.equal(harness.rangeMessages.length, 1);
  assert.equal(harness.rangeMessages[0].type, 'FETCH_MEDIA_RANGE');
  assert.equal(harness.events.at(-1).status, 'failed');
  assert.equal(harness.saved.length, 0);
});

