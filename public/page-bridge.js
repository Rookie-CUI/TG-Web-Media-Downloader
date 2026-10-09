(() => {
  const MARK = '__TG_PERSONAL_MEDIA_V1__';
  const bridgeInstalledAt = Date.now();
  const objectUrls = new Map();
  const objectUrlHistory = new Map();
  const revokedBlobs = new Map();
  const pageRangeRequests = new Map();
  const recentMediaUrls = [];
  const audioInstances = [];
  const MAX_CAPTURED_OBJECT_URLS = 80;
  const MAX_OBJECT_URL_HISTORY = 200;
  let createObjectURLHookInstalled = false;
  let fetchHookInstalled = false;
  let xhrHookInstalled = false;
  let capturedObjectUrlCount = 0;
  let capturedMediaUrlCount = 0;
  const publish = (detail) => window.postMessage({ mark: MARK, kind: 'MEDIA', messageId: crypto.randomUUID(), detail }, '*');

  const getBridgeStatus = () => ({
    bridgeInstalledAt,
    createObjectURLHookInstalled,
    fetchHookInstalled,
    xhrHookInstalled,
    capturedObjectUrlCount,
    capturedMediaUrlCount,
  });

  function rememberObjectUrl(url, metadata) {
    objectUrlHistory.delete(url);
    objectUrlHistory.set(url, { ...metadata });
    while (objectUrlHistory.size > MAX_OBJECT_URL_HISTORY) objectUrlHistory.delete(objectUrlHistory.keys().next().value);
  }

  function trimObjectUrls(protectedUrl) {
    while (objectUrls.size > MAX_CAPTURED_OBJECT_URLS) {
      const evictable = [...objectUrls.entries()].find(([url, entry]) => url !== protectedUrl && entry.leases.size === 0);
      if (!evictable) return;
      objectUrls.delete(evictable[0]);
      const history = objectUrlHistory.get(evictable[0]);
      if (history) rememberObjectUrl(evictable[0], { ...history, hasObjectReference: false, evictedAt: Date.now() });
    }
  }

  function classifyObjectUrl(value) {
    if (typeof Blob === 'function' && value instanceof Blob) return { kind: 'blob', blob: value, size: value.size, mimeType: value.type || '' };
    const mediaSourceConstructors = [window.MediaSource, window.ManagedMediaSource].filter((ctor) => typeof ctor === 'function');
    if (mediaSourceConstructors.some((ctor) => value instanceof ctor) || /MediaSource$/.test(value?.constructor?.name || '')) {
      return { kind: 'media-source', blob: null, size: 0, mimeType: '' };
    }
    return { kind: 'unknown', blob: null, size: 0, mimeType: '' };
  }

  const isTrackedMediaUrl = (url, contentType = '') => {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (lower.startsWith('blob:')) return true;
    if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|#|$)/.test(lower)) return false;
    return lower.includes('/progressive/') || lower.includes('/stream/') || lower.includes('/download/') ||
      /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|opus|aac|mpeg|mpga|wav|flac|weba)(\?|#|$)/.test(lower) ||
      /^(video|audio)\//i.test(contentType) ||
      (lower.includes('document') && !lower.includes('videoplay'));
  };

  const trackMediaUrl = (url, source, metadata = {}) => {
    if (!isTrackedMediaUrl(url, metadata.contentType || '')) return;
    capturedMediaUrlCount += 1;
    recentMediaUrls.push({ url, time: Date.now(), source, capturedRealm: 'main-window', ...metadata });
    if (recentMediaUrls.length > 300) recentMediaUrls.splice(0, recentMediaUrls.length - 300);
    publish({ url, source, ...metadata });
  };

  const getTrackedMediaUrlsSince = (since) => {
    const items = recentMediaUrls.filter((item) => item.time >= since);
    for (const { audio, createdAt } of audioInstances) {
      const url = audio.currentSrc || audio.src;
      if (!url || !isTrackedMediaUrl(url)) continue;
      const assignedAt = Number(audio.dataset?.tgDownloaderSrcAt || createdAt);
      if (assignedAt < since && audio.paused) continue;
      items.push({ url, time: assignedAt, source: 'audio-instance' });
    }
    const byUrl = new Map();
    for (const item of items.sort((a, b) => a.time - b.time)) {
      const previous = byUrl.get(item.url);
      byUrl.set(item.url, previous ? {
        ...previous,
        ...item,
        contentType: item.contentType || previous.contentType || '',
        status: item.status || previous.status || 0,
        objectUrlKind: item.objectUrlKind || previous.objectUrlKind,
      } : item);
    }
    return [...byUrl.values()].sort((a, b) => a.time - b.time);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'TG_DOWNLOADER_GET_BRIDGE_STATUS' && event.data.mark === MARK) {
      window.postMessage({
        mark: MARK,
        type: 'TG_DOWNLOADER_BRIDGE_STATUS_RESPONSE',
        requestId: event.data.requestId,
        status: getBridgeStatus(),
      }, '*');
      return;
    }
    if (event.data.type !== 'TG_DOWNLOADER_GET_MEDIA_URLS' && event.data.type !== 'TG_DOWNLOADER_GET_AUDIO_SRCS') return;
    const since = typeof event.data.since === 'number' ? event.data.since : 0;
    const items = getTrackedMediaUrlsSince(since);
    window.postMessage({
      type: 'TG_DOWNLOADER_MEDIA_URLS_RESPONSE',
      messageId: event.data.requestId || crypto.randomUUID(),
      requestId: event.data.requestId,
      items,
      urls: items.map((item) => item.url),
    }, '*');
  });

  if (!window.__tgDownloaderAudioCtorHook) {
    window.__tgDownloaderAudioCtorHook = true;
    const OriginalAudio = window.Audio;
    window.Audio = function (...args) {
      const audio = new OriginalAudio(...args);
      audioInstances.push({ audio, createdAt: Date.now() });
      if (audioInstances.length > 80) audioInstances.shift();
      const url = audio.currentSrc || audio.src;
      if (url) trackMediaUrl(url, 'audio-instance');
      return audio;
    };
    window.Audio.prototype = OriginalAudio.prototype;
  }

  if (!window.__tgDownloaderMediaSrcHook) {
    window.__tgDownloaderMediaSrcHook = true;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (descriptor?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set(value) {
          trackMediaUrl(value, 'src');
          try { this.dataset.tgDownloaderSrcAt = String(Date.now()); } catch { /* ignore */ }
          return descriptor.set.call(this, value);
        },
      });
    }
  }

  if (!window.__tgDownloaderSetAttributeHook) {
    window.__tgDownloaderSetAttributeHook = true;
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (name === 'src' && value && (this instanceof HTMLMediaElement || this.tagName === 'AUDIO' || this.tagName === 'VIDEO')) {
        trackMediaUrl(String(value), 'setAttribute');
        try { this.dataset.tgDownloaderSrcAt = String(Date.now()); } catch { /* ignore */ }
      }
      return originalSetAttribute.call(this, name, value);
    };
  }

  const originalCreate = URL.createObjectURL.bind(URL);
  const createObjectURLWrapper = (value) => {
    const url = originalCreate(value);
    const object = classifyObjectUrl(value);
    const createdAt = Date.now();
    revokedBlobs.delete(url);
    capturedObjectUrlCount += 1;
    const history = {
      kind: object.kind, size: object.size, mimeType: object.mimeType,
      createdAt, createdAfterBridge: createdAt >= bridgeInstalledAt,
      capturedRealm: 'main-window', hasObjectReference: object.kind === 'blob' && Boolean(object.blob),
      revoked: false,
    };
    objectUrls.set(url, { ...object, ...history, revoked: false, leases: new Set() });
    rememberObjectUrl(url, history);
    trimObjectUrls(url);
    trackMediaUrl(url, 'object-url', {
      objectUrlKind: object.kind,
      mimeType: object.mimeType,
      size: object.size,
      createdAfterBridge: true,
      capturedRealm: 'main-window',
    });
    console.info('[TG Downloader][blob] object URL captured', {
      urlType: 'blob', objectUrlKind: object.kind, cacheState: 'hit',
      createdAfterBridge: true, capturedRealm: 'main-window', hasObjectReference: history.hasObjectReference,
      size: object.size, mimeType: object.mimeType,
    });
    return url;
  };
  try {
    URL.createObjectURL = createObjectURLWrapper;
    createObjectURLHookInstalled = URL.createObjectURL === createObjectURLWrapper;
  } catch {
    createObjectURLHookInstalled = false;
  }
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => {
    const entry = objectUrls.get(url);
    const history = objectUrlHistory.get(url);
    revokedBlobs.set(url, entry?.kind || history?.kind || 'unknown');
    while (revokedBlobs.size > 200) revokedBlobs.delete(revokedBlobs.keys().next().value);
    if (entry) {
      entry.revoked = true;
      const retainedByLease = Boolean(entry.blob) && entry.leases.size > 0;
      rememberObjectUrl(url, { ...history, revoked: true, hasObjectReference: retainedByLease });
      if (entry.leases.size === 0) objectUrls.delete(url);
      console.info('[TG Downloader][blob] object URL revoked', {
        urlType: 'blob', objectUrlKind: entry.kind, cacheState: 'hit',
        createdAfterBridge: entry.createdAfterBridge, capturedRealm: entry.capturedRealm,
        hasObjectReference: retainedByLease,
        activeLeases: entry.leases.size,
      });
    }
    originalRevoke(url);
  };

  const originalFetch = window.fetch;
  const fetchWrapper = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const request = originalFetch.call(this, input, init);
    if (!url) return request;
    return Promise.resolve(request).then((response) => {
      const metadata = {
        status: Number(response.status) || 0,
        contentType: response.headers?.get?.('Content-Type') || '',
        redirected: Boolean(response.redirected),
      };
      trackMediaUrl(url, 'fetch', metadata);
      if (response.url && response.url !== url) trackMediaUrl(response.url, 'fetch-response', metadata);
      return response;
    });
  };
  try {
    window.fetch = fetchWrapper;
    fetchHookInstalled = window.fetch === fetchWrapper;
  } catch {
    fetchHookInstalled = false;
  }

  const xhrUrlByRequest = new WeakMap();
  const XMLHttpRequestConstructor = window.XMLHttpRequest || globalThis.XMLHttpRequest;
  const xhrPrototype = XMLHttpRequestConstructor?.prototype;
  if (xhrPrototype?.open && xhrPrototype?.send) {
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;
    const openWrapper = function (method, url, ...args) {
      try { xhrUrlByRequest.set(this, new URL(String(url), window.location.href).href); } catch { xhrUrlByRequest.set(this, String(url || '')); }
      return originalOpen.call(this, method, url, ...args);
    };
    const sendWrapper = function (...args) {
      const request = this;
      const url = xhrUrlByRequest.get(request);
      if (url) {
        request.addEventListener('loadend', () => {
          let contentType = '';
          try { contentType = request.getResponseHeader('Content-Type') || ''; } catch { /* ignore unavailable headers */ }
          const metadata = { status: Number(request.status) || 0, contentType };
          trackMediaUrl(url, 'xhr', metadata);
          if (request.responseURL && request.responseURL !== url) trackMediaUrl(request.responseURL, 'xhr-response', metadata);
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };
    try {
      xhrPrototype.open = openWrapper;
      xhrPrototype.send = sendWrapper;
      xhrHookInstalled = xhrPrototype.open === openWrapper && xhrPrototype.send === sendWrapper;
    } catch {
      xhrHookInstalled = false;
    }
  }

  console.info('[TG Downloader][bridge] installed', getBridgeStatus());

  function blobError(message, code, objectUrlKind, cacheState, extra = {}) {
    return Object.assign(new Error(message), { code, objectUrlKind, cacheState, ...extra });
  }

  async function resolveBlob(url, leaseId) {
    let entry = objectUrls.get(url);
    const history = objectUrlHistory.get(url);
    const cacheState = entry ? 'hit' : 'miss';
    const objectUrlKind = entry?.kind || history?.kind || revokedBlobs.get(url) || 'unknown';
    const diagnostics = {
      createdAfterBridge: typeof history?.createdAfterBridge === 'boolean' ? history.createdAfterBridge : null,
      capturedRealm: history?.capturedRealm || 'unknown',
      hasObjectReference: Boolean(entry?.kind === 'blob' && entry.blob),
      size: Number(entry?.blob?.size ?? history?.size) || 0,
      mimeType: String(entry?.blob?.type || history?.mimeType || ''),
    };
    if (entry) {
      objectUrls.delete(url);
      objectUrls.set(url, entry);
    }
    if (entry?.kind === 'media-source') {
      throw blobError('MediaSource object URL 是播放源，不能作为完整 Blob 文件读取', 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', 'media-source', cacheState, diagnostics);
    }
    if (entry?.kind === 'unknown') {
      throw blobError('object URL 的底层对象未被识别为 Blob', 'BLOB_REFERENCE_NOT_CAPTURED', 'unknown', cacheState, diagnostics);
    }
    if (!entry && objectUrlKind === 'media-source') {
      throw blobError('MediaSource object URL 是播放源，不能作为完整 Blob 文件读取', 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', objectUrlKind, cacheState, diagnostics);
    }
    if (leaseId && !entry?.leases.has(leaseId)) {
      throw blobError('Blob lease 不存在或已释放', 'BLOB_LEASE_INVALID', objectUrlKind, cacheState, diagnostics);
    }
    if (revokedBlobs.has(url) && !leaseId) {
      throw blobError('Blob URL 在 pin 前已被 Telegram 撤销', 'BLOB_REVOKED_BEFORE_PIN', objectUrlKind, cacheState, diagnostics);
    }
    if (!entry && history && history.hasObjectReference === false) {
      const revoked = history.revoked === true;
      throw blobError(
        revoked ? 'Blob URL 在 pin 前已被 Telegram 撤销' : 'Blob 对象引用已不在 bridge 缓存中',
        revoked ? 'BLOB_REVOKED_BEFORE_PIN' : 'BLOB_REFERENCE_NOT_CAPTURED',
        objectUrlKind, cacheState, diagnostics,
      );
    }
    if (entry?.blob) {
      if (!entry.revoked || (leaseId && entry.leases.has(leaseId))) return { blob: entry.blob, entry, cacheState };
      throw blobError('Blob URL 已撤销且没有有效 lease', 'BLOB_REVOKED_BEFORE_PIN', objectUrlKind, cacheState, diagnostics);
    }
    if (revokedBlobs.has(url)) {
      throw blobError('Blob URL 在 pin 前已被 Telegram 撤销，且缓存引用不可用', 'BLOB_REVOKED_BEFORE_PIN', objectUrlKind, cacheState, diagnostics);
    }
    try {
      const response = await originalFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      entry = { kind: 'blob', blob, size: blob.size, mimeType: blob.type || '', revoked: false, leases: new Set() };
      objectUrls.set(url, entry);
      trimObjectUrls(url);
      return { blob, entry, cacheState };
    } catch (error) {
      const reason = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
      throw blobError(`Blob reference was not captured; fallback fetch failed: ${reason}`, 'BLOB_REFERENCE_NOT_CAPTURED', objectUrlKind, cacheState, diagnostics);
    }
  }

  function pinBlob(url, requestId) {
    const entry = objectUrls.get(url);
    const history = objectUrlHistory.get(url);
    const cacheState = entry ? 'hit' : 'miss';
    const objectUrlKind = entry?.kind || history?.kind || revokedBlobs.get(url) || 'unknown';
    const diagnostic = {
      objectUrlKind,
      cacheState,
      createdAfterBridge: typeof history?.createdAfterBridge === 'boolean' ? history.createdAfterBridge : null,
      capturedRealm: history?.capturedRealm || 'unknown',
      hasObjectReference: Boolean(entry?.kind === 'blob' && entry.blob),
      size: Number(entry?.blob?.size ?? history?.size) || 0,
      mimeType: String(entry?.blob?.type || history?.mimeType || ''),
    };
    console.info('[TG Downloader][blob] pin request', { urlType: 'blob', ...diagnostic });
    if (!entry && objectUrlKind === 'media-source') {
      return { ok: false, requestId, code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', ...diagnostic, error: 'MediaSource object URL 仅用于播放，不能作为完整下载文件' };
    }
    if (!entry) {
      const wasRevoked = revokedBlobs.has(url) || history?.revoked;
      const code = wasRevoked ? 'BLOB_REVOKED_BEFORE_PIN' : 'BLOB_REFERENCE_NOT_CAPTURED';
      return {
        ok: false, requestId, code, ...diagnostic,
        error: wasRevoked ? 'Blob URL 在 pin 前已被 Telegram 撤销' : '未捕获到该 Blob URL 的对象引用',
      };
    }
    if (entry.kind === 'media-source') {
      return { ok: false, requestId, code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', ...diagnostic, error: 'MediaSource object URL 仅用于播放，不能作为完整下载文件' };
    }
    if (entry.kind !== 'blob' || !entry.blob) {
      return { ok: false, requestId, code: 'BLOB_REFERENCE_NOT_CAPTURED', ...diagnostic, error: 'object URL 没有可 pin 的真实 Blob 引用' };
    }
    if (entry.revoked && entry.leases.size === 0) {
      return { ok: false, requestId, code: 'BLOB_REVOKED_BEFORE_PIN', ...diagnostic, error: 'Blob URL 在 pin 前已被 Telegram 撤销' };
    }
    if (!Number.isSafeInteger(entry.blob.size) || entry.blob.size <= 0) {
      return { ok: false, requestId, code: 'BLOB_SIZE_UNKNOWN', ...diagnostic, error: '捕获到的 Blob 没有有效文件大小' };
    }
    const leaseId = crypto.randomUUID();
    entry.leases.add(leaseId);
    objectUrls.delete(url);
    objectUrls.set(url, entry);
    const result = {
      ok: true, requestId, leaseId, ...diagnostic,
      size: entry.blob.size, mimeType: entry.blob.type || '', objectUrlKind: entry.kind, cacheState,
      hasObjectReference: true,
    };
    console.info('[TG Downloader][blob] pin result', { urlType: 'blob', ...diagnostic, size: result.size, hasLease: true });
    return result;
  }

  function releaseBlob(url, leaseId, requestId) {
    const entry = objectUrls.get(url);
    if (!entry || !leaseId || !entry.leases.has(leaseId)) {
      console.info('[TG Downloader][blob] release', { urlType: 'blob', objectUrlKind: entry?.kind || 'unknown', cacheState: entry ? 'hit' : 'miss', released: false });
      return { ok: false, requestId, code: 'BLOB_LEASE_INVALID', error: 'Blob lease 不存在或已释放' };
    }
    entry.leases.delete(leaseId);
    if (entry.revoked && entry.leases.size === 0) objectUrls.delete(url);
    trimObjectUrls();
    console.info('[TG Downloader][blob] release', { urlType: 'blob', objectUrlKind: entry.kind, cacheState: 'hit', released: true, activeLeases: entry.leases.size });
    return { ok: true, requestId, released: true, objectUrlKind: entry.kind, cacheState: objectUrls.has(url) ? 'hit' : 'miss' };
  }

  function isAllowedTelegramUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const allowed = host === 'web.telegram.org' || host === 'telegram.org' || host.endsWith('.telegram.org') ||
        host === 'telegram-cdn.org' || host.endsWith('.telegram-cdn.org') || host === 't.me' || host.endsWith('.t.me');
      return url.protocol === 'https:' && allowed;
    } catch {
      return false;
    }
  }

  function encodeBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  async function preflightKViewerMediaSource(data) {
    const { requestId, url } = data;
    if (!requestId || !isAllowedTelegramUrl(url)) {
      window.postMessage({
        mark: MARK, type: 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE', requestId,
        ok: false, status: 0, contentType: '', contentRange: '', code: 'TELEGRAM_URL_NOT_ALLOWED',
      }, '*');
      return;
    }

    const controller = new AbortController();
    pageRangeRequests.set(requestId, controller);
    let status = 0;
    let finalUrl = url;
    let contentType = '';
    let contentRange = '';
    let redirected = false;
    let code = 'K_VIEWER_HTTP_SOURCE_REJECTED';
    let contentLength = '';
    try {
      const response = await originalFetch.call(window, url, {
        credentials: 'include',
        redirect: 'follow',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      status = response.status;
      finalUrl = response.url || url;
      redirected = Boolean(response.redirected);
      contentType = response.headers.get('Content-Type') || '';
      contentRange = response.headers.get('Content-Range') || '';
      contentLength = response.headers.get('Content-Length') || '';

      const mime = contentType.split(';', 1)[0].trim().toLowerCase();
      const finalPath = new URL(finalUrl).pathname.toLowerCase();
      const rangeMatch = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(contentRange.trim());
      const validRange = status === 206 && Boolean(rangeMatch) && Number(rangeMatch[2]) > Number(rangeMatch[1]);
      const mediaMime = /^(video|audio)\//.test(mime) ||
        /^application\/(mp4|ogg|x-matroska|vnd\.apple\.mpegurl)(?:$|\+)/.test(mime);
      const mediaPath = /\/(progressive|stream)\//.test(finalPath) ||
        /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|opus|aac|mpeg|mpga|wav|flac|weba)$/.test(finalPath);

      if (!isAllowedTelegramUrl(finalUrl)) code = 'TELEGRAM_REDIRECT_NOT_ALLOWED';
      else if (status >= 300 && status < 400) code = 'HTTP_REDIRECT_NOT_FOLLOWED';
      else if (![200, 206].includes(status)) code = 'K_VIEWER_PREFLIGHT_HTTP_FAILED';
      else if (mime.startsWith('text/')) code = 'NON_MEDIA_RESPONSE';
      else if (mime.startsWith('image/')) code = 'NON_VIDEO_MEDIA_RESPONSE';
      else if (status === 206 && !validRange) code = 'INVALID_CONTENT_RANGE';
      else if (!mediaMime && !mediaPath) code = 'FINAL_MEDIA_TYPE_UNVERIFIED';
      else {
        code = '';
        try { await response.body?.cancel(); } catch { /* Headers are sufficient; never read the media body. */ }
        window.postMessage({
          mark: MARK, type: 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE', requestId,
          ok: true, status, finalUrl, redirected, contentType, contentRange, contentLength, code: '',
        }, '*');
        return;
      }
      try { await response.body?.cancel(); } catch { /* The rejected response body is deliberately not consumed. */ }
      window.postMessage({
        mark: MARK, type: 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE', requestId,
        ok: false, status, finalUrl: isAllowedTelegramUrl(finalUrl) ? finalUrl : '',
        redirected, contentType, contentRange, contentLength, code,
      }, '*');
    } catch (error) {
      const aborted = controller.signal.aborted;
      const errorCode = aborted ? 'PREFLIGHT_CANCELLED' : 'K_VIEWER_PREFLIGHT_FAILED';
      window.postMessage({
        mark: MARK, type: 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE', requestId,
        ok: false, status, finalUrl: isAllowedTelegramUrl(finalUrl) ? finalUrl : '',
        redirected, contentType, contentRange, contentLength, code: errorCode,
      }, '*');
    } finally {
      if (pageRangeRequests.get(requestId) === controller) pageRangeRequests.delete(requestId);
    }
  }

  async function fetchPageMediaRange(data) {
    const { requestId, url, start, end } = data;
    if (!requestId || !isAllowedTelegramUrl(url) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      window.postMessage({
        mark: MARK, type: 'FETCH_PAGE_MEDIA_RANGE_RESPONSE', requestId, ok: false, status: 0,
        code: 'TELEGRAM_URL_NOT_ALLOWED', retryable: false, error: '仅允许 Telegram allowlist 中的 HTTPS Range 请求',
      }, '*');
      return;
    }

    const controller = new AbortController();
    pageRangeRequests.set(requestId, controller);
    let status = 0;
    let finalUrl = url;
    let contentType = '';
    let contentLength = '';
    let contentRange = '';
    let acceptRanges = '';
    let redirected = false;
    try {
      const response = await originalFetch.call(window, url, {
        credentials: 'include', redirect: 'follow',
        headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal,
      });
      status = response.status;
      finalUrl = response.url || url;
      redirected = Boolean(response.redirected);
      contentType = response.headers.get('Content-Type') || '';
      contentLength = response.headers.get('Content-Length') || '';
      contentRange = response.headers.get('Content-Range') || '';
      acceptRanges = response.headers.get('Accept-Ranges') || '';

      if (!isAllowedTelegramUrl(finalUrl)) {
        throw Object.assign(new Error('Telegram 媒体重定向目标不在允许域名内'), { code: 'TELEGRAM_REDIRECT_NOT_ALLOWED' });
      }
      if (status >= 300 && status < 400) {
        throw Object.assign(new Error(`Telegram 重定向未被页面 fetch 跟随：HTTP ${status}`), { code: 'HTTP_REDIRECT_NOT_FOLLOWED' });
      }
      if (contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html') {
        throw Object.assign(new Error('媒体 Range 请求返回 text/html 页面，而不是媒体数据'), { code: 'NON_MEDIA_RESPONSE' });
      }
      if (!response.ok) throw Object.assign(new Error(`媒体请求失败：HTTP ${status}`), { code: 'MEDIA_HTTP_FAILED' });

      let buffer;
      const limit = data.maxResponseBytes;
      if (limit !== undefined) {
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 8 * 1024 * 1024) {
          throw Object.assign(new Error('页面容器探测响应上限无效'), { code: 'INVALID_RESPONSE_LIMIT' });
        }
        if (Number(contentLength) > limit) {
          await response.body?.cancel();
          throw Object.assign(new Error('页面容器探测响应超出上限'), { code: 'PAGE_RESPONSE_TOO_LARGE' });
        }
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const parts = [];
          let received = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.byteLength;
              if (received > limit) {
                await reader.cancel();
                throw Object.assign(new Error('页面容器探测响应超出上限'), { code: 'PAGE_RESPONSE_TOO_LARGE' });
              }
              parts.push(value);
            }
            const collected = new Uint8Array(received);
            let offset = 0;
            for (const part of parts) { collected.set(part, offset); offset += part.byteLength; }
            buffer = collected.buffer;
          } finally { reader.releaseLock(); }
        } else {
          buffer = await response.arrayBuffer();
          if (buffer.byteLength > limit) throw Object.assign(new Error('页面容器探测响应超出上限'), { code: 'PAGE_RESPONSE_TOO_LARGE' });
        }
      } else buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // K single-video ranges use a transferable buffer; legacy callers keep their existing encoding.
      const binaryResponse = data.responseEncoding === 'arraybuffer';
      window.postMessage({
        mark: MARK, type: 'FETCH_PAGE_MEDIA_RANGE_RESPONSE', requestId, ok: true, status,
        finalUrl, redirected, contentType, contentLength: contentLength || String(bytes.byteLength),
        contentRange, acceptRanges, returnedBytes: bytes.byteLength,
        bytes: binaryResponse ? bytes.buffer : encodeBase64(bytes),
      }, '*', binaryResponse ? [bytes.buffer] : []);
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PAGE_MEDIA_FETCH_FAILED';
      const retryable = code === 'PAGE_MEDIA_FETCH_FAILED' || code === 'MEDIA_HTTP_FAILED';
      window.postMessage({
        mark: MARK, type: 'FETCH_PAGE_MEDIA_RANGE_RESPONSE', requestId, ok: false, status,
        finalUrl, redirected, contentType, contentLength, contentRange, acceptRanges,
        returnedBytes: 0, retryable, code, error: message,
      }, '*');
    } finally {
      if (pageRangeRequests.get(requestId) === controller) pageRangeRequests.delete(requestId);
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.mark !== MARK) return;
    const { requestId, url } = event.data;
    const kind = event.data.kind;
    if (kind === 'CANCEL_PAGE_MEDIA_RANGE') {
      pageRangeRequests.get(String(requestId || ''))?.abort();
      return;
    }
    if (kind === 'PREFLIGHT_K_VIEWER_MEDIA_SOURCE') {
      await preflightKViewerMediaSource(event.data);
      return;
    }
    if (kind === 'FETCH_PAGE_MEDIA_RANGE') {
      await fetchPageMediaRange(event.data);
      return;
    }
    if (kind === 'PIN_BLOB') {
      window.postMessage({ mark: MARK, kind: 'BLOB_PIN_RESULT', ...pinBlob(String(url || ''), requestId) }, '*');
      return;
    }
    if (kind === 'RELEASE_BLOB') {
      window.postMessage({ mark: MARK, kind: 'BLOB_RELEASE_RESULT', ...releaseBlob(String(url || ''), String(event.data.leaseId || ''), requestId) }, '*');
      return;
    }
    if (!requestId || !url?.startsWith('blob:')) return;
    if (kind !== 'GET_BLOB_META' && kind !== 'READ_BLOB') return;
    if (kind === 'READ_BLOB') {
      const { start, end } = event.data;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return;
    }
    let cacheState = 'miss';
    let objectUrlKind = objectUrls.get(url)?.kind || 'unknown';
    try {
      const resolved = await resolveBlob(url, String(event.data.leaseId || ''));
      const { blob } = resolved;
      cacheState = resolved.cacheState;
      objectUrlKind = resolved.entry.kind;
      if (kind === 'GET_BLOB_META') {
        window.postMessage({ mark: MARK, kind: 'BLOB_META', messageId: requestId, requestId, total: blob.size, mimeType: blob.type || '', cacheState, objectUrlKind }, '*');
        return;
      }
      if (!Number.isSafeInteger(blob.size) || blob.size <= 0) throw Object.assign(new Error('页面 Blob 大小未知或为零'), { code: 'BLOB_SIZE_UNKNOWN' });
      const bytes = await blob.slice(event.data.start, event.data.end + 1).arrayBuffer();
      if (!bytes.byteLength) throw Object.assign(new Error('页面 Blob 分片为空'), { code: 'BLOB_PART_EMPTY' });
      window.postMessage({ mark: MARK, kind: 'BLOB_PART', messageId: requestId, requestId, bytes, total: blob.size, mimeType: blob.type || '', cacheState, objectUrlKind }, '*', [bytes]);
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'BLOB_READ_FAILED';
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) || 0 : 0;
      cacheState = error && typeof error === 'object' && 'cacheState' in error ? String(error.cacheState) : cacheState;
      objectUrlKind = error && typeof error === 'object' && 'objectUrlKind' in error ? String(error.objectUrlKind) : objectUrlKind;
      const createdAfterBridge = error && typeof error === 'object' && 'createdAfterBridge' in error ? error.createdAfterBridge : null;
      const capturedRealm = error && typeof error === 'object' && 'capturedRealm' in error ? String(error.capturedRealm) : 'unknown';
      const hasObjectReference = error && typeof error === 'object' && 'hasObjectReference' in error ? error.hasObjectReference === true : false;
      const size = error && typeof error === 'object' && 'size' in error ? Number(error.size) || 0 : 0;
      const mimeType = error && typeof error === 'object' && 'mimeType' in error ? String(error.mimeType) : '';
      console.error('[TG Downloader][blob] read failed', { urlType: 'blob', objectUrlKind, cacheState, code, requestId, stage: kind === 'GET_BLOB_META' ? 'metadata' : 'read' });
      window.postMessage({ mark: MARK, kind: 'BLOB_ERROR', messageId: requestId, requestId, error: message, code, status, cacheState, objectUrlKind, createdAfterBridge, capturedRealm, hasObjectReference, size, mimeType }, '*');
    }
  });
})();
