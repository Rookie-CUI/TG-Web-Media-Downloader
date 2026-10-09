import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

async function loadBridge(fetchImpl = async () => ({ ok: false, status: 404, blob: async () => new Blob() }), options = {}) {
  const source = await readFile(fileURLToPath(new URL('../public/page-bridge.js', import.meta.url)), 'utf8');
  const listeners = new Map();
  const messages = [];
  const logs = [];
  let urlId = 0;
  class FakeElement {
    setAttribute() {}
  }
  class FakeMediaSource {}
  class FakeMediaElement extends FakeElement {}
  class FakeXMLHttpRequest {
    constructor() { this.listeners = new Map(); this.status = 206; this.responseURL = ''; this.responseHeaders = { 'content-type': 'video/mp4' }; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    open(_method, url) { this.requestUrl = url; }
    send() {
      this.responseURL = this.requestUrl;
      for (const listener of this.listeners.get('loadend') || []) listener();
    }
    getResponseHeader(name) { return this.responseHeaders[name.toLowerCase()] || null; }
  }
  class FakeAudio extends FakeMediaElement {
    constructor() { super(); this.currentSrc = ''; this.src = ''; this.paused = true; this.dataset = {}; }
  }
  class FakeURL extends URL {
    static createObjectURL() { return `blob:https://web.telegram.org/test-${++urlId}`; }
    static revokeObjectURL() {}
  }
  const preexistingUrl = options.preexistingBlob ? FakeURL.createObjectURL(options.preexistingBlob) : null;
  const window = {
    Audio: FakeAudio,
    MediaSource: FakeMediaSource,
    XMLHttpRequest: FakeXMLHttpRequest,
    location: { href: 'https://web.telegram.org/k/' },
    fetch: fetchImpl,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    postMessage(message, _origin, transfer = []) { messages.push(transfer.length ? structuredClone(message, { transfer }) : message); },
  };
  const context = vm.createContext({
    window,
    preexistingUrl,
    URL: FakeURL,
    Blob,
    MediaSource: FakeMediaSource,
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    AbortController,
    btoa,
    crypto: { randomUUID: () => `bridge-${++urlId}` },
    Date,
    Map,
    Set,
    console: {
      info(...args) { logs.push(args); },
      warn(...args) { logs.push(args); },
      error(...args) { logs.push(args); },
    },
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return {
    window,
    preexistingUrl,
    messages,
    logs,
    createObjectURL: (value) => FakeURL.createObjectURL(value),
    revokeObjectURL: (url) => FakeURL.revokeObjectURL(url),
    async request(kind, url, requestId = `request-${messages.length}`, extra = {}) {
      const listener = listeners.get('message').find((entry) => entry.constructor.name === 'AsyncFunction');
      await listener({ source: window, data: { mark: '__TG_PERSONAL_MEDIA_V1__', kind, requestId, url, start: 0, end: 1023, ...extra } });
      return messages.at(-1);
    },
    async requestPageRange(url, options = {}) {
      const listener = listeners.get('message').find((entry) => entry.constructor.name === 'AsyncFunction');
      const data = {
        mark: '__TG_PERSONAL_MEDIA_V1__', kind: 'FETCH_PAGE_MEDIA_RANGE',
        requestId: options.requestId || `page-range-${messages.length}`, url,
        start: options.start ?? 0, end: options.end ?? 3,
        responseEncoding: options.responseEncoding,
        maxResponseBytes: options.maxResponseBytes,
      };
      await listener({ source: window, data });
      return messages.at(-1);
    },
    async requestKViewerPreflight(url, requestId = `k-preflight-${messages.length}`) {
      const listener = listeners.get('message').find((entry) => entry.constructor.name === 'AsyncFunction');
      await listener({ source: window, data: {
        mark: '__TG_PERSONAL_MEDIA_V1__', kind: 'PREFLIGHT_K_VIEWER_MEDIA_SOURCE', requestId, url,
      } });
      return messages.at(-1);
    },
    getRecentMediaUrls(since, requestId = `recent-media-${messages.length}`) {
      const listener = listeners.get('message').find((entry) => entry.constructor.name !== 'AsyncFunction');
      listener({ source: window, data: { type: 'TG_DOWNLOADER_GET_MEDIA_URLS', requestId, since } });
      return messages.at(-1);
    },
    requestStatus(requestId = `bridge-status-${messages.length}`) {
      const listener = listeners.get('message').find((entry) => entry.constructor.name !== 'AsyncFunction');
      listener({ source: window, data: { mark: '__TG_PERSONAL_MEDIA_V1__', type: 'TG_DOWNLOADER_GET_BRIDGE_STATUS', requestId } });
      return messages.at(-1);
    },
  };
}

test('BLOB_META 命中 createObjectURL 捕获缓存并返回真实 size/MIME', async () => {
  const bridge = await loadBridge();
  const blob = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/mp4' });
  const url = bridge.createObjectURL(blob);
  // URL creation invokes the page hook that stores the exact Blob object.
  const capturedUrl = bridge.messages.at(-1)?.detail?.url;
  assert.equal(capturedUrl, url);
  const response = await bridge.request('GET_BLOB_META', url, 'meta-hit');
  assert.equal(response.kind, 'BLOB_META');
  assert.equal(response.requestId, 'meta-hit');
  assert.equal(response.total, blob.size);
  assert.equal(response.mimeType, 'video/mp4');
  assert.equal(response.cacheState, 'hit');
});

test('MAIN page bridge 在 Blob 创建前安装 hook，并报告可 pin 的对象引用', async () => {
  const bridge = await loadBridge();
  const installed = bridge.requestStatus('status-before-create');
  assert.equal(installed.type, 'TG_DOWNLOADER_BRIDGE_STATUS_RESPONSE');
  assert.equal(installed.status.createObjectURLHookInstalled, true);
  assert.equal(installed.status.fetchHookInstalled, true);
  assert.equal(installed.status.xhrHookInstalled, true);
  assert.equal(installed.status.capturedObjectUrlCount, 0);

  const blob = new Blob([Uint8Array.from([1, 2, 3])], { type: 'video/mp4' });
  const url = bridge.createObjectURL(blob);
  const pin = await bridge.request('PIN_BLOB', url, 'pin-created-after-bridge');
  assert.equal(pin.ok, true);
  assert.equal(pin.createdAfterBridge, true);
  assert.equal(pin.capturedRealm, 'main-window');
  assert.equal(pin.hasObjectReference, true);
  assert.equal(pin.size, blob.size);
  assert.equal(pin.mimeType, 'video/mp4');
  assert.equal(bridge.requestStatus('status-after-create').status.capturedObjectUrlCount, 1);
});

test('page bridge 的 Blob 诊断日志不包含完整 blob URL', async () => {
  const bridge = await loadBridge();
  const url = bridge.createObjectURL(new Blob([Uint8Array.from([7, 8])], { type: 'video/mp4' }));
  await bridge.request('PIN_BLOB', url, 'pin-redacted-log');
  assert.equal(JSON.stringify(bridge.logs).includes(url), false);
  assert.ok(bridge.logs.some(([message, details]) => message === '[TG Downloader][blob] object URL captured' && details?.objectUrlKind === 'blob'));
  assert.ok(bridge.logs.some(([message, details]) => message === '[TG Downloader][blob] pin result' && details?.hasObjectReference === true));
});

test('bridge 安装前创建的 Blob URL 不会被伪装为缓存命中或触发 fetch 回退', async () => {
  let fetchCount = 0;
  const bridge = await loadBridge(async () => { fetchCount += 1; throw new Error('pre-existing object must not be fetched'); }, {
    preexistingBlob: new Blob([Uint8Array.from([4, 5])], { type: 'video/mp4' }),
  });
  const pin = await bridge.request('PIN_BLOB', bridge.preexistingUrl, 'pin-before-bridge');
  assert.equal(pin.ok, false);
  assert.equal(pin.code, 'BLOB_REFERENCE_NOT_CAPTURED');
  assert.equal(pin.cacheState, 'miss');
  assert.equal(pin.createdAfterBridge, null);
  assert.equal(pin.capturedRealm, 'unknown');
  assert.equal(pin.hasObjectReference, false);
  assert.equal(fetchCount, 0);
});

test('BLOB_META 缓存未命中时通过页面 fetch(blobUrl) 回退并缓存结果', async () => {
  const fallback = new Blob([Uint8Array.from([5, 6, 7])], { type: 'image/webp' });
  const fetched = [];
  const bridge = await loadBridge(async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, blob: async () => fallback };
  });
  const url = 'blob:https://web.telegram.org/fallback';
  const first = await bridge.request('GET_BLOB_META', url, 'meta-miss');
  assert.equal(first.kind, 'BLOB_META');
  assert.equal(first.total, fallback.size);
  assert.equal(first.mimeType, 'image/webp');
  assert.equal(first.cacheState, 'miss');
  assert.deepEqual(fetched, [url]);
  const second = await bridge.request('GET_BLOB_META', url, 'meta-now-hit');
  assert.equal(second.cacheState, 'hit');
  assert.deepEqual(fetched, [url]);
});

test('真实 Blob 在 Viewer 关闭前 pin 后，即使 revoke 仍可读取；release 后才释放引用', async () => {
  const bridge = await loadBridge();
  const blob = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/mp4' });
  const url = bridge.createObjectURL(blob);
  const pin = await bridge.request('PIN_BLOB', url, 'pin-1');
  assert.equal(pin.kind, 'BLOB_PIN_RESULT');
  assert.equal(pin.ok, true);
  assert.equal(pin.objectUrlKind, 'blob');
  assert.equal(pin.cacheState, 'hit');
  assert.equal(pin.size, blob.size);
  assert.equal(pin.mimeType, 'video/mp4');
  assert.ok(pin.leaseId);

  bridge.revokeObjectURL(url);
  const part = await bridge.request('READ_BLOB', url, 'read-pinned', { leaseId: pin.leaseId, start: 0, end: 3 });
  assert.equal(part.kind, 'BLOB_PART');
  assert.equal(part.total, blob.size);
  assert.deepEqual(Buffer.from(part.bytes), Buffer.from([1, 2, 3, 4]));

  const released = await bridge.request('RELEASE_BLOB', url, 'release-1', { leaseId: pin.leaseId });
  assert.equal(released.kind, 'BLOB_RELEASE_RESULT');
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  const afterRelease = await bridge.request('GET_BLOB_META', url, 'meta-after-release');
  assert.equal(afterRelease.kind, 'BLOB_ERROR');
  assert.equal(afterRelease.code, 'BLOB_REVOKED_BEFORE_PIN');
  assert.equal(afterRelease.objectUrlKind, 'blob');
});

test('MediaSource object URL 明确分类并拒绝 pin，不尝试 fetch(blobUrl)', async () => {
  let fetchCount = 0;
  const bridge = await loadBridge(async () => { fetchCount += 1; throw new Error('fetch must not run for MediaSource'); });
  const url = bridge.createObjectURL(new bridge.window.MediaSource());
  const pin = await bridge.request('PIN_BLOB', url, 'pin-media-source');
  assert.equal(pin.kind, 'BLOB_PIN_RESULT');
  assert.equal(pin.ok, false);
  assert.equal(pin.objectUrlKind, 'media-source');
  assert.equal(pin.code, 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE');
  assert.equal(pin.cacheState, 'hit');
  assert.equal(fetchCount, 0);
  const meta = await bridge.request('GET_BLOB_META', url, 'meta-media-source');
  assert.equal(meta.kind, 'BLOB_ERROR');
  assert.equal(meta.code, 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE');
  assert.equal(meta.objectUrlKind, 'media-source');
  assert.equal(fetchCount, 0);
});

test('blob cache miss 且 fetch 失败返回明确的 BLOB_REFERENCE_NOT_CAPTURED', async () => {
  let fetchCount = 0;
  const bridge = await loadBridge(async () => { fetchCount += 1; throw new TypeError('Failed to fetch'); });
  const response = await bridge.request('GET_BLOB_META', 'blob:https://web.telegram.org/not-captured', 'meta-not-captured');
  assert.equal(fetchCount, 1);
  assert.equal(response.kind, 'BLOB_ERROR');
  assert.equal(response.code, 'BLOB_REFERENCE_NOT_CAPTURED');
  assert.equal(response.cacheState, 'miss');
  assert.equal(response.objectUrlKind, 'unknown');
  assert.match(response.error, /reference was not captured/i);
});

test('页面 fetch 捕获本轮 Viewer 的 Telegram 视频 HTTP 地址和响应 MIME', async () => {
  const mediaUrl = 'https://cdn.telegram.org/file/clip.mp4';
  const bridge = await loadBridge(async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'video/mp4' : null },
  }));
  await bridge.window.fetch(mediaUrl);
  const result = bridge.getRecentMediaUrls(Date.now() - 1000, 'viewer-capture');
  assert.equal(result.type, 'TG_DOWNLOADER_MEDIA_URLS_RESPONSE');
  assert.equal(result.requestId, 'viewer-capture');
  assert.deepEqual(JSON.parse(JSON.stringify(result.items.map(({ url, contentType, source }) => ({ url, contentType, source })))), [
    { url: mediaUrl, contentType: 'video/mp4', source: 'fetch' },
  ]);
});

test('MAIN page bridge 捕获当前 window 的 XHR Telegram 视频请求和 MIME', async () => {
  const bridge = await loadBridge();
  const xhr = new bridge.window.XMLHttpRequest();
  xhr.open('GET', 'https://cdn.telegram.org/file/progressive/video.mp4');
  xhr.send();
  const result = bridge.getRecentMediaUrls(Date.now() - 1000, 'xhr-viewer-capture');
  const item = result.items.find((candidate) => candidate.source === 'xhr');
  assert.equal(item.url, 'https://cdn.telegram.org/file/progressive/video.mp4');
  assert.equal(item.contentType, 'video/mp4');
});

test('真实零字节 Blob 元数据返回 size=0，由 Downloader 决定失败', async () => {
  const bridge = await loadBridge();
  const blob = new Blob([], { type: 'video/mp4' });
  const url = bridge.createObjectURL(blob);
  const response = await bridge.request('GET_BLOB_META', url, 'meta-empty');
  assert.equal(response.kind, 'BLOB_META');
  assert.equal(response.total, 0);
  assert.equal(response.mimeType, 'video/mp4');
});

test('页面 HTTP bridge 使用 credentials 并显式 follow Telegram progressive 重定向，返回最终 206 元数据', async () => {
  const requests = [];
  const bytes = Uint8Array.from([1, 2, 3, 4]).buffer;
  const bridge = await loadBridge(async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true, status: 206, url: 'https://cdn.telegram.org/file/final.mp4', redirected: true,
      headers: { get: (name) => ({
        'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/12', 'accept-ranges': 'bytes',
      }[name.toLowerCase()] || null) },
      arrayBuffer: async () => bytes,
    };
  });
  const response = await bridge.requestPageRange('https://web.telegram.org/file/progressive/id/video.mp4');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.redirect, 'follow');
  assert.equal(response.type, 'FETCH_PAGE_MEDIA_RANGE_RESPONSE');
  assert.equal(response.ok, true);
  assert.equal(response.status, 206);
  assert.equal(response.finalUrl, 'https://cdn.telegram.org/file/final.mp4');
  assert.equal(response.redirected, true);
  assert.equal(response.contentType, 'video/mp4');
  assert.equal(response.contentRange, 'bytes 0-3/12');
  assert.equal(response.returnedBytes, 4);
  assert.deepEqual(Buffer.from(response.bytes, 'base64'), Buffer.from(bytes));
});

test('页面 HTTP bridge 支持最终 200 全量响应', async () => {
  const bridge = await loadBridge(async () => ({
    ok: true, status: 200, url: 'https://cdn.telegram.org/file/video.mp4', redirected: false,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'video/mp4' : name.toLowerCase() === 'content-length' ? '3' : null },
    arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer,
  }));
  const response = await bridge.requestPageRange('https://web.telegram.org/file/progressive/id/video.mp4');
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.contentType, 'video/mp4');
  assert.equal(response.returnedBytes, 3);
});

test('页面 HTTP bridge 把 text/html 识别成不可重试的非媒体失败', async () => {
  const bridge = await loadBridge(async () => ({
    ok: true, status: 200, url: 'https://cdn.telegram.org/login', redirected: true,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    arrayBuffer: async () => { throw new Error('HTML body should not be read as media bytes'); },
  }));
  const response = await bridge.requestPageRange('https://web.telegram.org/file/progressive/id/video.mp4');
  assert.equal(response.ok, false);
  assert.equal(response.code, 'NON_MEDIA_RESPONSE');
  assert.equal(response.retryable, false);
  assert.equal(response.status, 200);
});

test('页面 HTTP bridge 把未跟随的 302 标记为不可重试且不读取 HTML body', async () => {
  const bridge = await loadBridge(async () => ({
    ok: false, status: 302, url: 'https://web.telegram.org/login', redirected: false,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : name.toLowerCase() === 'location' ? '/login' : null },
    arrayBuffer: async () => { throw new Error('redirect body must not be read as media bytes'); },
  }));
  const response = await bridge.requestPageRange('https://web.telegram.org/file/progressive/id/video.mp4');
  assert.equal(response.ok, false);
  assert.equal(response.status, 302);
  assert.equal(response.code, 'HTTP_REDIRECT_NOT_FOLLOWED');
  assert.equal(response.retryable, false);
});

test('页面 HTTP bridge 在发送 fetch 前拒绝非 Telegram allowlist URL', async () => {
  let fetchCount = 0;
  const bridge = await loadBridge(async () => { fetchCount += 1; throw new Error('must not fetch'); });
  const response = await bridge.requestPageRange('https://evil.example/progressive/video');
  assert.equal(fetchCount, 0);
  assert.equal(response.ok, false);
  assert.equal(response.code, 'TELEGRAM_URL_NOT_ALLOWED');
  assert.equal(response.retryable, false);
});

test('页面 HTTP bridge 在 redirect 后拒绝 Telegram allowlist 外的最终 URL', async () => {
  const bridge = await loadBridge(async () => ({
    ok: true, status: 206, url: 'https://evil.example/media.bin', redirected: true,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'video/mp4' : null },
    arrayBuffer: async () => Uint8Array.from([1, 2]).buffer,
  }));
  const response = await bridge.requestPageRange('https://web.telegram.org/file/progressive/id/video.mp4');
  assert.equal(response.ok, false);
  assert.equal(response.code, 'TELEGRAM_REDIRECT_NOT_ALLOWED');
  assert.equal(response.retryable, false);
  assert.equal(response.finalUrl, 'https://evil.example/media.bin');
});

test('K Viewer 轻量预检使用凭据、Range 0-0、follow 并取消响应体而不读取媒体', async () => {
  const requests = [];
  let bodyCancelled = 0;
  const bridge = await loadBridge(async (url, init) => {
    requests.push({ url, init });
    return {
      status: 206, url: 'https://cdn.telegram.org/file/progressive/final.mp4', redirected: true,
      headers: { get: (name) => ({
        'content-type': 'video/mp4', 'content-range': 'bytes 0-0/4096',
      }[name.toLowerCase()] || null) },
      body: { cancel: async () => { bodyCancelled += 1; } },
      arrayBuffer: async () => { throw new Error('preflight must never read media bytes'); },
    };
  });
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/file/progressive/source.mp4');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.credentials, 'include');
  assert.equal(requests[0].init.redirect, 'follow');
  assert.equal(requests[0].init.headers.Range, 'bytes=0-0');
  assert.equal(response.type, 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE');
  assert.equal(response.ok, true);
  assert.equal(response.status, 206);
  assert.equal(response.finalUrl, 'https://cdn.telegram.org/file/progressive/final.mp4');
  assert.equal(response.contentType, 'video/mp4');
  assert.equal(response.contentRange, 'bytes 0-0/4096');
  assert.equal(bodyCancelled, 1);
});

test('K Viewer 预检的 302 + text/html 返回拒绝结果，不抛错也不读取响应体', async () => {
  let bodyCancelled = 0;
  const bridge = await loadBridge(async () => ({
    status: 302, url: 'https://web.telegram.org/login', redirected: false,
    headers: { get: (name) => ({ 'content-type': 'text/html', location: '/login' }[name.toLowerCase()] || null) },
    body: { cancel: async () => { bodyCancelled += 1; } },
    arrayBuffer: async () => { throw new Error('redirect body must not be read'); },
  }));
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/file/progressive/source');
  assert.equal(response.ok, false);
  assert.equal(response.status, 302);
  assert.equal(response.contentType, 'text/html');
  assert.equal(response.code, 'HTTP_REDIRECT_NOT_FOLLOWED');
  assert.equal(bodyCancelled, 1);
});

test('K Viewer 预检拒绝非 allowlist 重定向目标', async () => {
  const bridge = await loadBridge(async () => ({
    status: 206, url: 'https://evil.example/media.mp4', redirected: true,
    headers: { get: (name) => ({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/10' }[name.toLowerCase()] || null) },
    body: { cancel: async () => {} },
  }));
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/file/progressive/source');
  assert.equal(response.ok, false);
  assert.equal(response.code, 'TELEGRAM_REDIRECT_NOT_ALLOWED');
  assert.equal(response.finalUrl, '');
});

test('K Viewer 预检拒绝缺少合法 Content-Range 的 206', async () => {
  const bridge = await loadBridge(async () => ({
    status: 206, url: 'https://cdn.telegram.org/file/progressive/video.mp4', redirected: true,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'video/mp4' : null },
    body: { cancel: async () => {} },
  }));
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/file/progressive/source.mp4');
  assert.equal(response.ok, false);
  assert.equal(response.code, 'INVALID_CONTENT_RANGE');
});

test('K Viewer /download/ 路径加通用二进制 MIME 不能单独证明视频来源', async () => {
  const bridge = await loadBridge(async () => ({
    status: 206, url: 'https://web.telegram.org/k/download/opaque-id', redirected: false,
    headers: { get: (name) => ({ 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-0/1024' }[name.toLowerCase()] || null) },
    body: { cancel: async () => {} },
  }));
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/k/download/opaque-id');
  assert.equal(response.ok, false);
  assert.equal(response.code, 'FINAL_MEDIA_TYPE_UNVERIFIED');
});

test('K Viewer /download/ 来源有明确视频 MIME 和合法范围时可通过页面预检', async () => {
  const bridge = await loadBridge(async () => ({
    status: 206, url: 'https://cdn.telegram.org/k/download/video', redirected: true,
    headers: { get: (name) => ({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-0/1024' }[name.toLowerCase()] || null) },
    body: { cancel: async () => {} },
  }));
  const response = await bridge.requestKViewerPreflight('https://web.telegram.org/k/download/video');
  assert.equal(response.ok, true);
  assert.equal(response.status, 206);
  assert.equal(response.contentRange, 'bytes 0-0/1024');
});

test('K 页面 Range 可转移 ArrayBuffer 字节，旧调用仍保持 Base64', async () => {
  const expected = Uint8Array.from([1, 2, 254, 255]);
  const bridge = await loadBridge(async () => ({
    ok: true, status: 206, url: 'https://web.telegram.org/k/progressive/id',
    headers: { get: name => ({ 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/4' }[name.toLowerCase()] || null) },
    arrayBuffer: async () => expected.slice().buffer,
  }));
  const binary = await bridge.requestPageRange('https://web.telegram.org/k/progressive/id', { responseEncoding: 'arraybuffer' });
  assert.deepEqual(new Uint8Array(binary.bytes), expected);
  const legacy = await bridge.requestPageRange('https://web.telegram.org/k/progressive/id');
  assert.equal(typeof legacy.bytes, 'string');
});

test('容器 sparse probe 在服务器忽略 Range 时按上限取消响应流', async () => {
  let cancelled = false;
  const bridge = await loadBridge(async () => ({
    ok: true, status: 200, url: 'https://web.telegram.org/k/stream/id',
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'video/mp4' : null },
    body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(1024) }),
      cancel: async () => { cancelled = true; }, releaseLock() {} }) },
  }));
  const response = await bridge.requestPageRange('https://web.telegram.org/k/stream/id', { responseEncoding: 'arraybuffer', maxResponseBytes: 1024 });
  assert.equal(cancelled, true);
  assert.equal(response.ok, false);
  assert.equal(response.code, 'PAGE_RESPONSE_TOO_LARGE');
});
