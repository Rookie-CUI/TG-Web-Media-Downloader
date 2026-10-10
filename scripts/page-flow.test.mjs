import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

async function loadFlow() {
  const source = await read('../src/telegram/download-flow.ts');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports = {};
  const context = vm.createContext({ module: { exports }, exports, require() { throw new Error('Unexpected import'); } });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return context.module.exports;
}

async function loadStandaloneTypeScript(path) {
  const source = await read(path);
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports = {};
  const context = vm.createContext({ module: { exports }, exports, URL });
  vm.runInContext(`(function(exports, module) { ${compiled}\n})(exports, module);`, context);
  return context.module.exports;
}

async function loadTypeScriptModule(path, dependencies = {}, globals = {}) {
  const source = await read(path);
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const module = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected import ${name}`);
  };
  const context = vm.createContext({ module, exports: module.exports, require, console, URL, ...globals });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return context.module.exports;
}

async function loadSingleSession(globals = {}) {
  const filename = await loadStandaloneTypeScript('../src/utils/filename.ts');
  const errors = await loadStandaloneTypeScript('../src/utils/errors.ts');
  let id = 0;
  return loadTypeScriptModule('../src/telegram/single-download-session.ts', {
    '../utils/filename': filename,
    '../utils/errors': errors,
  }, { crypto: { randomUUID: () => `session-${++id}` }, ...globals });
}

async function loadResolverForDom(globals) {
  const kViewerSource = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  return loadTypeScriptModule('../src/telegram/original-media-resolver.ts', {
    './adapter': {},
    './download-flow': {},
    '../utils/filename': {},
    '../utils/errors': { formatError: (error) => ({ message: error?.message || String(error) }), formatErrorLog: (prefix) => prefix },
    './captured-media-registry': { enrichCapturedMedia: (value) => value },
    '../downloader/media-container': {},
    './k-viewer-source': kViewerSource,
    './single-download-session': {},
  }, globals);
}

async function loadResolverIntegration(globals = {}) {
  const [kViewerSource, filename, errors, singleSession] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'),
    loadStandaloneTypeScript('../src/utils/filename.ts'),
    loadStandaloneTypeScript('../src/utils/errors.ts'),
    loadSingleSession(),
  ]);
  return loadTypeScriptModule('../src/telegram/original-media-resolver.ts', {
    './adapter': {
      detectTelegramVersion: () => 'K', messageSelector: () => '.message', getMessageId: () => 'mid-card',
      classifyMessage: () => 'video', classifySidebarMedia: () => 'video',
    },
    './download-flow': {},
    '../utils/filename': filename,
    '../utils/errors': errors,
    './captured-media-registry': { enrichCapturedMedia: (value) => value },
    '../downloader/media-container': { inspectMediaContainer: async () => ({ playable: true, fragmented: false }) },
    './k-viewer-source': kViewerSource,
    './single-download-session': singleSession,
  }, globals);
}

const item = (url, messageId = 'mid-1') => ({
  id: `${messageId}:${url}`, url, filename: 'media.bin', mimeType: 'application/octet-stream', size: 1,
  kind: 'video', messageId, peerId: 'peer-1', fileId: '', source: 'dom', capturedAt: 1,
});

test('页面解析层不导入 Downloader，content 仅有一个 Downloader.start 出口', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const content = await read('../src/content/index.ts');
  // Container inspection is pure validation; only the task-running Downloader is forbidden here.
  assert.doesNotMatch(resolver, /from ['"]\.\.\/downloader(?:\/downloader)?['"]/);
  assert.doesNotMatch(resolver, /\.start\s*\(/);
  assert.equal((content.match(/downloader\.start\s*\(/g) || []).length, 1);
  assert.match(content, /async function downloadItem\(item: MediaItem\)/);
  assert.doesNotMatch(content, /installShadowApp|TGDownloaderShadowDOM\.show/);
});

test('普通 Download 解析一个 MediaItem 后只提交一次', async () => {
  const { resolveAndDownloadMedia } = await loadFlow();
  const calls = [];
  const downloaded = await resolveAndDownloadMedia(async () => [item('https://cdn.telegram.org/a')], async (media) => calls.push(media), 'mid-1', false);
  assert.equal(downloaded.length, 1);
  assert.equal(calls.length, 1);
});

test('普通消息按钮统一为 Download 且不再调用 DOM 类型分类器', async () => {
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.doesNotMatch(enhancer, /import \{[^}]*classifyMessage/);
  assert.doesNotMatch(enhancer, /TEXT\.(?:image|video|force)/);
  assert.equal((enhancer.match(/addText\(button, TEXT\.download, 'download\.buttons\.download'\)/g) || []).length >= 2, true);
  assert.match(enhancer, /findMessageAttachments\(message, version\)/);
});

test('AttachmentSession 严格按 baseline、startedAt、activate 顺序执行', async () => {
  const { runMessageDownloadSession } = await loadSingleSession();
  const order = [];
  let now = 100;
  const media = { ...item('https://web.telegram.org/progressive/a.mp4'), mimeType: 'video/mp4' };
  const result = await runMessageDownloadSession({
    messageId: 'mid-order', caption: '', attachments: [{ key: 'a0', index: 0, activationElement: {} }],
    now: () => { order.push('startedAt'); return ++now; }, createId: () => 'sid',
    readBaseline: async () => { order.push('baseline'); return []; },
    resolveAttachment: async (_session, start) => { order.push('activate'); await start(media); return media; },
    download: async () => { order.push('download'); },
  });
  assert.deepEqual(order.slice(-4), ['baseline', 'startedAt', 'activate', 'download']);
  assert.equal(result.successCount, 1);
});

test('baseline URL A 被排除，当前会话新增 URL B 被选择', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const decision = selectSingleDownloadCandidate([
    { url: 'https://web.telegram.org/progressive/A.mp4', source: 'fetch', capturedAt: 90, mimeType: 'video/mp4', origin: 'bridge', validated: true },
    { url: 'https://web.telegram.org/progressive/B.mp4', source: 'fetch', capturedAt: 110, mimeType: 'video/mp4', origin: 'bridge', validated: true },
  ], { startedAt: 100, baselineUrls: new Set(['https://web.telegram.org/progressive/A.mp4']) }, true);
  assert.equal(decision.selected.url, 'https://web.telegram.org/progressive/B.mp4');
});

test('相册预加载 URL 只有在当前 active slide 拥有时可穿过 baseline', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const urlB = 'https://web.telegram.org/progressive/B.mp4';
  const urlC = 'https://web.telegram.org/progressive/C.mp4';
  const session = { startedAt: 200, baselineUrls: new Set([urlB, urlC]) };
  const attachment1 = selectSingleDownloadCandidate([
    { url: urlB, source: 'viewer-element', capturedAt: 210, mimeType: 'video/mp4', origin: 'viewer', validated: true, activeViewerMainMedia: true },
    { url: urlC, source: 'preload', capturedAt: 190, mimeType: 'video/mp4', origin: 'bridge', validated: true },
  ], session, true);
  assert.equal(attachment1.selected.url, urlB);
  assert.ok(attachment1.rejected.some((entry) => entry.candidate.url === urlC && entry.reason === 'baseline-url'));

  const attachment2 = selectSingleDownloadCandidate([
    { url: urlC, source: 'viewer-element', capturedAt: 220, mimeType: 'video/mp4', origin: 'viewer', validated: true, activeViewerMainMedia: true },
  ], session, true);
  assert.equal(attachment2.selected.url, urlC);
});

test('card-local 相对 stream URL 会按页面地址解析，encoded JSON 只提供安全 metadata', async () => {
  const { normalizeCardLocalMediaUrl, parseCardLocalStreamMetadata } = await loadResolverForDom({
    window: { location: { href: 'https://web.telegram.org/k/' } }, URL,
  });
  const encoded = encodeURIComponent(JSON.stringify({
    size: 8897142, mimeType: 'video/mp4', fileName: 'clip.mp4', access_hash: 'must-not-escape',
  }));
  const url = normalizeCardLocalMediaUrl(`stream/${encoded}`, 'https://web.telegram.org/k/');
  assert.equal(url, `https://web.telegram.org/k/stream/${encoded}`);
  assert.deepEqual(JSON.parse(JSON.stringify(parseCardLocalStreamMetadata(url))), {
    size: 8897142, mimeType: 'video/mp4', fileName: 'clip.mp4',
  });
  assert.equal(normalizeCardLocalMediaUrl('/photo/thumb.jpg', 'https://web.telegram.org/k/'), '');
});

test('当前 card 的 direct stream 预检通过后直接交给 Downloader，不打开 Viewer 或原生下载', async () => {
  const raw = `stream/${encodeURIComponent(JSON.stringify({ size: 2048, mimeType: 'video/mp4', fileName: 'direct.mp4' }))}`;
  class FakeVideo {
    constructor() { this.tagName = 'VIDEO'; this.currentSrc = ''; this.src = ''; this.dataset = {}; this.poster = ''; }
    getAttribute(name) { return name === 'src' ? raw : name === 'type' ? 'video/mp4' : null; }
    querySelector() { return null; }
    closest(selector) { return selector === '.message' ? card : null; }
    matches(selector) { return selector.split(',').some((part) => part.trim() === 'video'); }
  }
  const video = new FakeVideo();
  const card = {
    tagName: 'DIV',
    getAttribute(name) { return name === 'data-mid' ? 'mid-card' : name === 'data-peer-id' ? 'peer-card' : null; },
    matches() { return false; }, closest() { return this; },
    querySelector(selector) {
      if (selector.includes('video')) return video;
      return null;
    },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; },
  };
  const fakeWindow = { location: { href: 'https://web.telegram.org/k/' }, setTimeout, clearTimeout };
  const { TelegramMediaResolver } = await loadResolverIntegration({
    window: fakeWindow, location: fakeWindow.location, document: { querySelector: () => null }, URL, crypto,
  });
  const resolver = new TelegramMediaResolver();
  let viewerOpenCalls = 0;
  let nativeDownloadCalls = 0;
  let downloaderCalls = 0;
  resolver.preflightKViewerHttpCandidate = async (candidate) => ({
    ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4',
    contentRange: 'bytes 0-1023/2048', contentLength: 1024, standalonePlayable: true, fragmented: false,
  });
  resolver.waitForViewer = async () => { viewerOpenCalls += 1; return null; };
  resolver.triggerKViewerNativeDownload = async () => { nativeDownloadCalls += 1; return true; };
  const resolved = await resolver.resolveSingleAttachment({
    sessionId: 'session-card', messageId: 'mid-card', attachmentIndex: 0, attachmentKey: 'mid-card',
    activationElement: card, startedAt: 100, baselineUrls: new Set([`https://web.telegram.org/k/${raw}`]),
  }, async () => { downloaderCalls += 1; });
  assert.equal(resolved.kind, 'video');
  assert.equal(resolved.requiresPageTransport, true);
  assert.ok(resolved.kSingleVideo);
  assert.equal(resolved.filename, 'direct.mp4');
  assert.equal(downloaderCalls, 1);
  assert.equal(viewerOpenCalls, 0);
  assert.equal(nativeDownloadCalls, 0);
});

test('card stream metadata 即使合法，page preflight 失败也不能建立下载项', async () => {
  const raw = `stream/${encodeURIComponent(JSON.stringify({ size: 9999, mimeType: 'video/mp4', fileName: 'unverified.mp4' }))}`;
  const video = {
    currentSrc: '', getAttribute(name) { return name === 'src' ? raw : name === 'type' ? 'video/mp4' : null; },
  };
  const card = {
    matches() { return false; }, querySelector(selector) { return selector.includes('video') ? video : null; },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; },
  };
  const fakeWindow = { location: { href: 'https://web.telegram.org/k/' }, setTimeout, clearTimeout };
  const { TelegramMediaResolver } = await loadResolverIntegration({
    window: fakeWindow, location: fakeWindow.location, document: { querySelector: () => null }, URL, crypto,
  });
  const resolver = new TelegramMediaResolver();
  resolver.preflightKViewerHttpCandidate = async () => ({
    ok: false, status: 403, finalUrl: '', contentType: 'text/html', code: 'K_VIEWER_PREFLIGHT_HTTP_FAILED',
  });
  const result = await resolver.resolveCardLocalVideo(card, item('blob:https://web.telegram.org/poster'), {
    messageId: 'mid-unverified', attachmentIndex: 0,
  });
  assert.equal(result, null);
});

test('poster-only video 只激活当前 card 的 play，生成 stream 后进入 Downloader', async () => {
  const raw = 'stream/%7B%22size%22%3A4096%2C%22mimeType%22%3A%22video%2Fmp4%22%2C%22fileName%22%3A%22played.mp4%22%7D';
  let activeVideo = null;
  let playClicks = 0;
  class FakeMedia {
    constructor(tagName, src = '') { this.tagName = tagName; this.src = src; this.currentSrc = ''; this.dataset = {}; this.poster = ''; }
    getAttribute(name) { return name === 'src' ? this.src : name === 'type' ? (this.tagName === 'VIDEO' ? 'video/mp4' : 'image/webp') : null; }
    querySelector() { return null; }
    closest(selector) { return selector === '.message' ? card : null; }
    matches(selector) { return selector.split(',').some((part) => part.trim() === this.tagName.toLowerCase()); }
  }
  const poster = new FakeMedia('IMG', 'blob:https://web.telegram.org/poster');
  const play = { click() { playClicks += 1; activeVideo = new FakeMedia('VIDEO', raw); } };
  const card = {
    tagName: 'DIV', click() { throw new Error('Viewer target must not be clicked'); }, matches() { return false; }, closest() { return this; },
    getAttribute(name) { return name === 'data-mid' ? 'mid-poster' : name === 'data-peer-id' ? 'peer-card' : null; },
    querySelector(selector) {
      if (selector === 'video, img, canvas, source') return activeVideo || poster;
      if (selector.includes('.video-time') || selector.includes('.video-play')) return selector === '.video-play' ? play : (activeVideo || play);
      if (selector === 'video') return activeVideo;
      return null;
    },
    querySelectorAll(selector) { return selector === 'video' && activeVideo ? [activeVideo] : []; },
  };
  const fakeWindow = { location: { href: 'https://web.telegram.org/k/' }, setTimeout, clearTimeout };
  const { TelegramMediaResolver } = await loadResolverIntegration({
    window: fakeWindow, location: fakeWindow.location, document: { querySelector: () => null }, URL, crypto,
  });
  const resolver = new TelegramMediaResolver();
  let viewerOpenCalls = 0;
  let downloaderCalls = 0;
  resolver.preflightKViewerHttpCandidate = async (candidate) => ({
    ok: true, status: 206, finalUrl: new URL(candidate.url, fakeWindow.location.href).href, contentType: 'video/mp4',
    contentRange: 'bytes 0-1023/4096', standalonePlayable: true, fragmented: false,
  });
  resolver.waitForViewer = async () => { viewerOpenCalls += 1; return null; };
  const resolved = await resolver.resolveSingleAttachment({
    sessionId: 'session-poster', messageId: 'mid-poster', attachmentIndex: 0, attachmentKey: 'mid-poster',
    activationElement: card, startedAt: 100, baselineUrls: new Set(),
  }, async () => { downloaderCalls += 1; });
  assert.equal(playClicks, 1);
  assert.equal(resolved.kind, 'video');
  assert.equal(downloaderCalls, 1);
  assert.equal(viewerOpenCalls, 0);
});

test('Viewer 图片的 active kindHint 支持无扩展名 URL 与已验证 Blob，未知 Blob 仍拒绝', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const select = (url, details = {}) => selectSingleDownloadCandidate([{
    url, source: 'viewer-image', capturedAt: 210, mimeType: '', origin: 'viewer',
    trustedMainMedia: true, activeViewerMainMedia: true, kindHint: 'image', ...details,
  }], { startedAt: 200, baselineUrls: new Set() }, false);
  const extensionless = select('https://web.telegram.org/resource/opaque?id=42');
  assert.equal(extensionless.kind, 'image');
  assert.equal(extensionless.selected.url, 'https://web.telegram.org/resource/opaque?id=42');
  const verifiedBlob = select('blob:https://web.telegram.org/viewer-image', {
    objectUrlKind: 'blob', validated: true, mimeType: 'image/webp',
  });
  assert.equal(verifiedBlob.kind, 'image');
  assert.ok(verifiedBlob.selected);
  const unknownBlob = select('blob:https://web.telegram.org/unknown-image');
  assert.equal(unknownBlob.selected, null);
  assert.equal(unknownBlob.rejected[0].reason, 'blob-not-verified');
});

test('K Viewer readiness 会等待延迟图片或视频证据，不在 shell 出现时立即失败', async () => {
  const { waitForActiveViewerMediaReady } = await loadResolverForDom({
    window: { setTimeout, location: { href: 'https://web.telegram.org/k/' } }, document: {}, URL, console,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  for (const expectedKind of ['image', 'video']) {
    let clock = 0;
    let reads = 0;
    const result = await waitForActiveViewerMediaReady(async () => {
      reads += 1;
      return { kind: reads >= 4 ? expectedKind : null, snapshot: { reads } };
    }, 3200, 100, async (ms) => { clock += ms; }, () => clock);
    assert.equal(result.kind, expectedKind);
    assert.equal(result.snapshot.reads, 4);
    assert.equal(clock, 300);
  }
});

test('K active HTTPS 无扩展名图片必须通过 Telegram host 与 image MIME 预检', async () => {
  const { verifiedActiveViewerHttpImage } = await loadResolverForDom({
    window: { setTimeout, location: { href: 'https://web.telegram.org/k/' } }, document: {}, URL, console,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  const candidate = {
    url: 'https://web.telegram.org/resource/opaque?id=42', source: 'viewer-image', capturedAt: 1,
    mimeType: '', origin: 'viewer', trustedMainMedia: true, activeViewerMainMedia: true, kindHint: 'image',
  };
  const verified = verifiedActiveViewerHttpImage(candidate, {
    ok: false, status: 206, finalUrl: candidate.url, contentType: 'image/webp', contentRange: 'bytes 0-0/2048',
    code: 'NON_VIDEO_MEDIA_RESPONSE',
  });
  assert.equal(verified?.validated, true);
  assert.equal(verified?.mimeType, 'image/webp');
  assert.equal(verifiedActiveViewerHttpImage(candidate, {
    ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/2048',
  }), null);
});

test('active video 中的 poster 即使带 image kindHint 也不会被选择', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const decision = selectSingleDownloadCandidate([{
    url: 'https://web.telegram.org/opaque-poster', source: 'viewer-image', capturedAt: 210,
    mimeType: '', origin: 'viewer', trustedMainMedia: true, activeViewerMainMedia: true, kindHint: 'image',
  }], { startedAt: 200, baselineUrls: new Set() }, true);
  assert.equal(decision.selected, null);
  assert.equal(decision.rejected[0].reason, 'video-poster');
});

test('Viewer movers 中只使用 active slide，inactive preload 不会被信任', async () => {
  class FakeElement {
    constructor(tagName, className = '', url = '', shown = true) {
      this.tagName = tagName.toUpperCase(); this.className = className; this.url = url; this.shown = shown;
      this.children = []; this.parentElement = null; this.currentSrc = url; this.src = url;
      this.naturalWidth = 1600; this.naturalHeight = 900; this.width = 1600; this.height = 900;
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } return this; }
    getBoundingClientRect() { return { width: this.shown ? 1600 : 0, height: this.shown ? 900 : 0 }; }
    getAttribute(name) { if (name === 'src') return this.url || null; if (name === 'type') return this.tagName === 'VIDEO' ? 'video/mp4' : null; return null; }
    matches(selector) { return selector.split(',').some((part) => this.#matchesOne(part.trim())); }
    #matchesOne(selector) {
      if (selector === 'video' || selector === 'img' || selector === 'source') return this.tagName === selector.toUpperCase();
      if (selector === 'img[src]') return this.tagName === 'IMG' && Boolean(this.url);
      if (selector === 'video[src]') return this.tagName === 'VIDEO' && Boolean(this.url);
      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      return classes.length > 0 && classes.every((name) => this.className.split(/\s+/).includes(name));
    }
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => { for (const child of node.children) { if (child.matches(selector)) matches.push(child); visit(child); } };
      visit(this); return matches;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  }
  const activeImage = new FakeElement('img', '', 'https://web.telegram.org/active.jpg');
  const preloadImage = new FakeElement('img', '', 'https://web.telegram.org/preload.jpg');
  const active = new FakeElement('div', 'media-viewer-mover active').append(activeImage);
  const preload = new FakeElement('div', 'media-viewer-mover').append(preloadImage);
  const movers = new FakeElement('div', 'media-viewer-movers').append(active, preload);
  const viewer = new FakeElement('div', 'media-viewer-whole active').append(movers);
  const globals = {
    Element: FakeElement, HTMLElement: FakeElement, HTMLImageElement: FakeElement,
    getComputedStyle: (node) => ({ display: node.shown ? 'block' : 'none', visibility: 'visible', opacity: '1' }),
    window: { setTimeout, location: { href: 'https://web.telegram.org/k/' } }, document: {}, URL, console,
  };
  const { TelegramMediaResolver, getActiveViewerMediaScope } = await loadResolverForDom(globals);
  assert.equal(getActiveViewerMediaScope(viewer).root, active);
  const images = new TelegramMediaResolver().readSingleViewerImages(viewer);
  assert.deepEqual(Array.from(images, (entry) => entry.url), [activeImage.url]);
  assert.equal(images[0].trustedMainMedia, true);
  assert.equal(images.some((entry) => entry.url === preloadImage.url), false);
  assert.equal(images[0].kindHint, 'image');

  const imageRoot = new FakeElement('img', '', 'https://web.telegram.org/no-extension-resource');
  const rootScope = getActiveViewerMediaScope(imageRoot);
  assert.equal(rootScope.root, imageRoot);
  assert.equal(rootScope.ownsCurrentAttachment, true);
  const rootImageCandidate = new TelegramMediaResolver().readSingleViewerImages(imageRoot)[0];
  assert.equal(rootImageCandidate.url, imageRoot.url, 'scope root img itself is included');

  const videoRoot = new FakeElement('video', '', 'https://web.telegram.org/resource/video-opaque');
  const videoCandidates = new TelegramMediaResolver().readKViewerDomCandidates(videoRoot);
  assert.equal(videoCandidates[0].url, videoRoot.url, 'active HTTPS video currentSrc is collected');
  assert.equal(videoCandidates[0].activeViewerMainMedia, true);

  const original = { messageId: 'mid-ready', kind: 'file', mimeType: 'application/octet-stream', url: '', filename: 'x.bin' };
  const session = { messageId: 'mid-ready', attachmentIndex: 0, startedAt: 100, baselineUrls: new Set() };
  const delayedImage = new FakeElement('img', '', 'https://web.telegram.org/resource/delayed-image');
  delayedImage.naturalWidth = 0; delayedImage.naturalHeight = 0;
  const delayedImageViewer = new FakeElement('div', 'media-viewer-whole active')
    .append(new FakeElement('div', 'media-viewer-mover active').append(delayedImage));
  const imageResolver = new TelegramMediaResolver();
  let imagePolls = 0;
  imageResolver.readKViewerCandidateSet = async () => {
    imagePolls += 1;
    if (imagePolls === 3) { delayedImage.naturalWidth = 1200; delayedImage.naturalHeight = 800; }
    return { menu: [], viewer: [], captured: [], performance: [] };
  };
  imageResolver.preflightKViewerHttpCandidate = async (candidate) => ({
    ok: false, status: 206, finalUrl: candidate.url, contentType: 'image/jpeg', contentRange: 'bytes 0-0/4096',
    code: 'NON_VIDEO_MEDIA_RESPONSE',
  });
  const delayedImageReady = await imageResolver.waitForKActiveViewerMediaReady(delayedImageViewer, original, session);
  assert.equal(delayedImageReady.kind, 'image');
  assert.ok(imagePolls >= 3);

  const delayedVideoSlide = new FakeElement('div', 'media-viewer-mover active');
  const delayedVideoViewer = new FakeElement('div', 'media-viewer-whole active').append(delayedVideoSlide);
  const delayedVideo = new FakeElement('video', '', 'https://web.telegram.org/resource/delayed-video');
  const videoResolver = new TelegramMediaResolver();
  let videoPolls = 0;
  videoResolver.readKViewerCandidateSet = async () => {
    videoPolls += 1;
    if (videoPolls === 3 && !delayedVideo.parentElement) delayedVideoSlide.append(delayedVideo);
    return { menu: [], viewer: [], captured: [], performance: [] };
  };
  const delayedVideoReady = await videoResolver.waitForKActiveViewerMediaReady(delayedVideoViewer, original, session);
  assert.equal(delayedVideoReady.kind, 'video');
  assert.ok(videoPolls >= 3);
});

test('resolveSingleAttachment finally always closes Viewer, and failed click falls back to Escape', async () => {
  const events = [];
  class FakeElement {
    constructor(className = '') { this.className = className; this.isConnected = true; this.shown = true; this.parentElement = null; this.children = []; this.classList = { contains: () => false }; }
    get tagName() { return 'DIV'; }
    getBoundingClientRect() { return { width: this.shown ? 400 : 0, height: this.shown ? 600 : 0 }; }
    append(child) { this.children.push(child); child.parentElement = this; return this; }
    matches(selector) { return selector.split(',').some((part) => part.trim().split(/\s+/).at(-1).split('.').filter(Boolean).every((name) => this.className.split(/\s+/).includes(name))); }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getAttribute() { return null; }
    click() { events.push('close-click'); }
    dispatchEvent(event) { events.push(`key:${event.key}`); if (event.key === 'Escape') this.shown = false; return true; }
  }
  const close = new FakeElement('MediaViewerClose');
  const viewer = new FakeElement('MediaViewer active').append(close);
  const document = {
    activeElement: viewer,
    querySelector(selector) { return viewer.shown && selector.includes('MediaViewer') ? viewer : null; },
  };
  class FakeKeyboardEvent { constructor(_type, init) { this.key = init.key; } }
  const globals = {
    Element: FakeElement, HTMLElement: FakeElement, HTMLImageElement: FakeElement,
    getComputedStyle: (node) => ({ display: node.shown ? 'block' : 'none', visibility: 'visible', opacity: '1' }),
    window: { setTimeout(callback) { return setTimeout(callback, 0); } }, document,
    KeyboardEvent: FakeKeyboardEvent, URL, console,
  };
  const { TelegramMediaResolver } = await loadResolverForDom(globals);
  const resolver = new TelegramMediaResolver();
  const closed = await resolver.closeViewer('A', viewer);
  assert.equal(closed, true);
  assert.deepEqual(events.slice(0, 2), ['close-click', 'key:Escape']);
  assert.equal(viewer.shown, false);

  const resolverSource = await read('../src/telegram/original-media-resolver.ts');
  const start = resolverSource.indexOf('async resolveSingleAttachment(');
  const end = resolverSource.indexOf('private readSingleViewerImages', start);
  assert.match(resolverSource.slice(start, end), /finally\s*\{\s*await close\(\);\s*\}/);
});

test('K 视频仅对明确 source/transport 错误启用原生 fallback', async () => {
  const { shouldAttemptKNativeFallback } = await loadSingleSession();
  assert.equal(shouldAttemptKNativeFallback(Object.assign(new Error('redirect'), { code: 'HTTP_REDIRECT_NOT_FOLLOWED' })), true);
  assert.equal(shouldAttemptKNativeFallback(Object.assign(new Error('container'), { code: 'MEDIA_CONTAINER_NOT_STANDALONE' })), true);
  assert.equal(shouldAttemptKNativeFallback(Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_CANCELLED' })), false);
  assert.equal(shouldAttemptKNativeFallback(Object.assign(new Error('Paused'), { code: 'DOWNLOAD_PAUSED' })), false);
  assert.equal(shouldAttemptKNativeFallback(new Error('Extension context invalidated')), false);
});

test('视频 Viewer 的 poster 先出现时 progressive MP4 仍获胜', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const decision = selectSingleDownloadCandidate([
    { url: 'https://web.telegram.org/poster.jpg', source: 'viewer-image', capturedAt: 101, mimeType: 'image/jpeg', origin: 'viewer', trustedMainMedia: true },
    { url: 'https://web.telegram.org/progressive/video.mp4', source: 'xhr', capturedAt: 120, mimeType: 'video/mp4', origin: 'bridge', validated: true },
  ], { startedAt: 100, baselineUrls: new Set() }, true);
  assert.equal(decision.selected.url, 'https://web.telegram.org/progressive/video.mp4');
  assert.ok(decision.rejected.some((entry) => entry.reason === 'video-poster'));
});

test('图片 Viewer 选择激活后的真实大图而非 baseline thumbnail', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const thumb = 'https://web.telegram.org/thumb.webp';
  const original = 'https://web.telegram.org/original-photo.jpg';
  const decision = selectSingleDownloadCandidate([
    { url: thumb, source: 'viewer-image', capturedAt: 101, mimeType: 'image/webp', origin: 'viewer', trustedMainMedia: true, width: 200, height: 100 },
    { url: original, source: 'viewer-image', capturedAt: 110, mimeType: 'image/jpeg', origin: 'viewer', trustedMainMedia: true, width: 2000, height: 1000 },
  ], { startedAt: 100, baselineUrls: new Set([thumb]) }, false);
  assert.equal(decision.selected.url, original);
});

test('MediaSource blob 明确拒绝，不能当作完整视频', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const decision = selectSingleDownloadCandidate([
    { url: 'blob:https://web.telegram.org/media-source', source: 'object-url', capturedAt: 110, mimeType: 'video/mp4', objectUrlKind: 'media-source', origin: 'bridge' },
  ], { startedAt: 100, baselineUrls: new Set() }, true);
  assert.equal(decision.selected, null);
  assert.equal(decision.rejected[0].reason, 'media-source-not-file');
});

test('Bridge 不足时允许选择当前时间窗内验证过的 Performance progressive', async () => {
  const { selectSingleDownloadCandidate } = await loadSingleSession();
  const decision = selectSingleDownloadCandidate([
    { url: 'https://web.telegram.org/progressive/media-token', source: 'performance-resource', capturedAt: 110, mimeType: 'application/octet-stream', origin: 'performance', validated: true },
  ], { startedAt: 100, baselineUrls: new Set() }, true);
  assert.equal(decision.selected.source, 'performance-resource');
});

test('完全没有真实 source 时明确记录附件失败', async () => {
  const errorLogs = [];
  const { runMessageDownloadSession } = await loadSingleSession({
    console: { info() {}, error(value) { errorLogs.push(value); } },
  });
  const result = await runMessageDownloadSession({
    messageId: 'mid-fail', caption: '', attachments: [{ key: 'a0', index: 0, activationElement: {} }],
    readBaseline: async () => [],
    resolveAttachment: async () => { throw Object.assign(new Error('none'), { code: 'SINGLE_DOWNLOAD_SOURCE_UNRESOLVED' }); },
    download: async () => { throw new Error('must not download'); },
  });
  assert.equal(result.failedCount, 1);
  assert.equal(result.failures[0].code, 'SINGLE_DOWNLOAD_SOURCE_UNRESOLVED');
  assert.equal(typeof errorLogs[0], 'string');
  assert.match(errorLogs[0], /messageId=mid-fail/);
  assert.match(errorLogs[0], /attachmentIndex=0/);
  assert.match(errorLogs[0], /stage=source-resolve-or-download/);
  assert.match(errorLogs[0], /code=SINGLE_DOWNLOAD_SOURCE_UNRESOLVED/);
});

test('caption 提取失败的空 caption 不阻止正常下载', async () => {
  const { runMessageDownloadSession } = await loadSingleSession();
  const downloads = [];
  const media = { ...item('https://web.telegram.org/photo.jpg'), kind: 'image', mimeType: 'image/jpeg', filename: 'photo.jpg' };
  const result = await runMessageDownloadSession({
    messageId: 'mid-caption', caption: '', attachments: [{ key: 'a0', index: 0, activationElement: {} }],
    readBaseline: async () => [], resolveAttachment: async (_session, start) => { await start(media); return media; },
    download: async (resolved) => downloads.push(resolved),
  });
  assert.equal(result.successCount, 1);
  assert.equal(downloads.length, 1);
});

test('一条消息发现 3 个 attachment 并保持稳定 DOM 顺序', async () => {
  const { findMessageAttachments } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const tiles = [0, 1, 2].map((index) => ({
    getAttribute(name) { return name === 'data-index' ? String(index) : null; },
    closest() { return null; }, matches() { return false; }, querySelector() { return {}; }, contains() { return false; },
  }));
  const message = { querySelectorAll(selector) { return selector === '.album-item' ? tiles : []; } };
  const attachments = findMessageAttachments(message, 'K');
  assert.deepEqual(Array.from(attachments, (entry) => entry.key), ['0', '1', '2']);
});

test('真实 K album 的每个 data-mid 都形成不同 attachmentKey', async () => {
  const { findMessageAttachments } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const mids = ['4294967427', '4294967428', '4294967429'];
  const tiles = mids.map((mid) => ({
    getAttribute(name) { return name === 'data-mid' ? mid : name === 'data-peer-id' ? '-100123' : null; },
    closest() { return null; }, matches() { return false; }, querySelector() { return {}; }, contains() { return false; },
  }));
  const message = { querySelectorAll(selector) { return selector === '.album-item' ? tiles : []; } };
  const attachments = findMessageAttachments(message, 'K');
  assert.deepEqual(Array.from(attachments, (entry) => entry.key), mids);
  assert.equal(new Set(attachments.map((entry) => entry.key)).size, 3);
});

test('后一 AttachmentSession 的 baseline 隔离前一附件 URL', async () => {
  const { runMessageDownloadSession } = await loadSingleSession();
  const firstUrl = 'https://web.telegram.org/progressive/first.mp4';
  const seen = [];
  let baselineCall = 0;
  const result = await runMessageDownloadSession({
    messageId: 'mid-two', caption: '', attachments: [0, 1].map((index) => ({ key: `a${index}`, index, activationElement: {} })),
    readBaseline: async () => (++baselineCall === 1 ? [] : [{ url: firstUrl }]),
    resolveAttachment: async (session, start) => {
      seen.push(session.baselineUrls.has(firstUrl));
      const media = { ...item(indexUrl(session.attachmentIndex)), mimeType: 'video/mp4' };
      await start(media); return media;
    },
    download: async () => {},
  });
  assert.deepEqual(seen, [false, true]);
  assert.equal(result.successCount, 2);
});

test('多附件 caption 文件名按稳定顺序编号且扩展名来自真实媒体', async () => {
  const { filenameForResolvedMedia } = await loadStandaloneTypeScript('../src/utils/filename.ts');
  const names = [
    filenameForResolvedMedia('东京旅行', { filename: 'x.bin', mimeType: 'image/jpeg', url: 'blob:x', kind: 'image' }, 0, 3, 'mid'),
    filenameForResolvedMedia('东京旅行', { filename: 'x.bin', mimeType: 'video/mp4', url: 'blob:y', kind: 'video' }, 1, 3, 'mid'),
    filenameForResolvedMedia('东京旅行', { filename: 'x.bin', mimeType: 'image/png', url: 'blob:z', kind: 'image' }, 2, 3, 'mid'),
  ];
  assert.deepEqual(Array.from(names), ['东京旅行_01.jpg', '东京旅行_02.mp4', '东京旅行_03.png']);
});

test('caption 文件名去掉连续开头 hashtag 且全 hashtag 不会变空', async () => {
  const { filenameForResolvedMedia } = await loadStandaloneTypeScript('../src/utils/filename.ts');
  const media = { filename: 'x.bin', mimeType: 'image/jpeg', url: 'blob:x', kind: 'image' };
  assert.equal(filenameForResolvedMedia('#les #sm #女同 正常标题', media, 0, 2, 'mid'), '正常标题_01.jpg');
  assert.equal(filenameForResolvedMedia('#les #sm #女同', media, 0, 2, 'mid'), '#les #sm #女同_01.jpg');
  const long = filenameForResolvedMedia(`#tag ${'标'.repeat(100)}`, media, 0, 1, 'mid');
  assert.equal([...long.replace(/\.jpg$/, '')].length, 80);
});

test('多附件第二项失败时第三项继续并汇总 2 succeeded / 1 failed', async () => {
  const { runMessageDownloadSession } = await loadSingleSession();
  const visited = [];
  const result = await runMessageDownloadSession({
    messageId: 'mid-isolation', caption: '', attachments: [0, 1, 2].map((index) => ({ key: `a${index}`, index, activationElement: {} })),
    readBaseline: async () => [],
    resolveAttachment: async (session, start) => {
      visited.push(session.attachmentIndex);
      if (session.attachmentIndex === 1) throw Object.assign(new Error('fail'), { code: 'SECOND_FAILED' });
      const media = { ...item(indexUrl(session.attachmentIndex)), mimeType: 'video/mp4' };
      await start(media); return media;
    },
    download: async () => {},
  });
  assert.deepEqual(visited, [0, 1, 2]);
  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 1);
});

function indexUrl(index) {
  return `https://web.telegram.org/progressive/${index}.mp4`;
}

test('当前消息 caption 生成合法文件名并保留真实媒体扩展名', async () => {
  const { filenameFromCaption } = await loadStandaloneTypeScript('../src/utils/filename.ts');
  assert.equal(filenameFromCaption('今天拍到的东京夜景', 'original.mp4'), '今天拍到的东京夜景.mp4');
  const filename = filenameFromCaption('  测试:视频/文件?   *01...  ', 'original.mp4');
  assert.doesNotMatch(filename, /[<>:"/\\|?*]/);
  assert.doesNotMatch(filename, /\s{2,}/);
  assert.match(filename, /\.mp4$/);
});

test('caption 只读当前消息正文，时间、时长与 reaction 不进入文件名', async () => {
  const { extractMessageCaption } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  let text = '今天拍到的东京夜景 12:34 0:18 👍 3';
  const removable = [
    { token: '12:34', remove() { text = text.replace(this.token, ''); } },
    { token: '0:18', remove() { text = text.replace(this.token, ''); } },
    { token: '👍 3', remove() { text = text.replace(this.token, ''); } },
  ];
  const clone = {
    get textContent() { return text; },
    querySelectorAll(selector) { return selector.includes('.message-time') ? removable : []; },
  };
  const captionNode = { cloneNode() { return clone; }, closest() { return null; } };
  const message = { querySelector(selector) { return selector === '.bubble-content .translatable-message' ? captionNode : null; } };
  assert.equal(extractMessageCaption(message, 'K'), '今天拍到的东京夜景');
});

test('FORCE 结果重复时按 messageId 与 URL 去重后提交', async () => {
  const { resolveAndDownloadMedia } = await loadFlow();
  const calls = [];
  const media = item('blob:https://web.telegram.org/video');
  await resolveAndDownloadMedia(async (_mid, force) => { assert.equal(force, true); return [media, { ...media }]; }, async (entry) => calls.push(entry), 'mid-1', true);
  assert.equal(calls.length, 1);
});

test('K Media 扫描按 data-mid、peer 和 media 节点字段解析，并含原版容器 selector', async () => {
  const source = await read('../src/telegram/original-media-resolver.ts');
  assert.match(source, /\.search-super-container-media\.active \.media-container\[data-mid\]/);
  assert.match(source, /getAttribute\('data-mid'\)/);
  assert.match(source, /getAttribute\('data-peer-id'\)/);
  assert.match(source, /img\.media-photo|video\.media-video/);
  assert.match(source, /closest\('\.search-super-month'\)/);
});

test('批量任务跳过重复 messageId/url，但保留同消息不同媒体地址', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const downloads = [];
  const media = [item('https://cdn.telegram.org/a'), item('https://cdn.telegram.org/a'), item('https://cdn.telegram.org/b')];
  const result = await downloadBatchMedia(media, async (mid, url) => [item(url, mid)], async (entry) => downloads.push(entry));
  assert.equal(result.success, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(downloads.map((entry) => entry.url), ['https://cdn.telegram.org/a', 'https://cdn.telegram.org/b']);
});

test('Channel Info 和原版 Media 增强 selectors、入口和进度标记均存在', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(resolver, /\[TG Downloader\]\[channel-info\]/);
  assert.match(resolver, /\[TG Downloader\]\[media-tab\]/);
  assert.match(resolver, /#column-right \.search-super/);
  assert.match(resolver, /search-super-tabs\.menu-horizontal-div/);
  assert.match(resolver, /pointerdown/);
  assert.match(enhancer, /download-all-media/);
  assert.match(enhancer, /download-selected-item/);
  assert.match(enhancer, /tg-all-media-download/);
});

test('扩展 context 失效会停掉 timer/observer 并提示刷新页面', async () => {
  const content = await read('../src/content/index.ts');
  assert.match(content, /Extension context invalidated\. Refresh Telegram page\./);
  assert.match(content, /toolbarObserver\?\.disconnect\(\)/);
  assert.match(content, /sidebarObserver\?\.disconnect\(\)/);
  assert.match(content, /window\.clearInterval\(observerTimer\)/);
});

test('消息下载 action host 是完整 bubble wrapper，而不是 attachment/media-container', async () => {
  const { getMessageActionHost } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const attachment = { name: 'attachment' };
  const wrapper = { querySelector(selector) { return selector === '.attachment.media-container' ? attachment : null; } };
  const message = { querySelector(selector) { return selector === '.bubble-content-wrapper' ? wrapper : null; } };
  const host = getMessageActionHost(message, 'K');
  assert.equal(host, wrapper);
  assert.notEqual(host, attachment);
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /const container = wrapper/);
  assert.doesNotMatch(enhancer, /wrapper\.querySelector\('\.attachment\.media-container/);
});

test('同一消息已存在直接子级下载区时禁止重复注入', async () => {
  const { hasDirectMessageActions } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const actions = {};
  let installed = false;
  const wrapper = { querySelector(selector) { return installed && selector.startsWith(':scope >') ? actions : null; } };
  assert.equal(hasDirectMessageActions(wrapper), false);
  installed = true;
  assert.equal(hasDirectMessageActions(wrapper), true);
});

test('Sidebar 单项解析成功只启动一次 Downloader 回调', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const media = item('blob:https://web.telegram.org/video');
  const starts = [];
  const result = await resolveSidebarAndDownloadMedia(async (mid, url, beforeClose) => {
    assert.equal(mid, 'mid-1');
    assert.equal(url, media.url);
    await beforeClose(media);
    await beforeClose({ ...media });
    return [media, { ...media }];
  }, async (entry) => starts.push(entry.url), 'mid-1', media.url);
  assert.equal(result.length, 1);
  assert.deepEqual(starts, [media.url]);
});

test('Viewer 关闭前已固定 final URL 并启动本地下载', async () => {
  const { resolveViewerMediaBeforeClose } = await loadFlow();
  const source = item('blob:https://web.telegram.org/final');
  const order = [];
  const resolved = await resolveViewerMediaBeforeClose(async () => source, async (entry) => {
    order.push(['download-start', entry.url]);
  }, async () => {
    order.push(['viewer-close']);
    source.url = 'blob:revoked';
  });
  assert.deepEqual(order, [['download-start', 'blob:https://web.telegram.org/final'], ['viewer-close']]);
  assert.equal(resolved.url, 'blob:https://web.telegram.org/final');
});

test('K Viewer MediaSource currentSrc 不直接下载，优先使用本次 Viewer 捕获的 progressive HTTP 源', async () => {
  const { resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let pinCount = 0;
  const source = await resolveKViewerVideoSource([], [
    { url: 'https://cdn.telegram.org/file/stream/id/video.mp4', source: 'fetch', contentType: 'video/mp4', preflightVerified: true, verifiedStrongEvidence: true, verifiedContentType: 'video/mp4' },
    { url: 'https://cdn.telegram.org/file/progressive/id/video.mp4', source: 'fetch', contentType: 'video/mp4', preflightVerified: true, verifiedStrongEvidence: true, verifiedContentType: 'video/mp4' },
  ], 'blob:https://web.telegram.org/media-source-viewer', async () => {
    pinCount += 1;
    return { ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE' };
  });
  assert.equal(source.url, 'https://cdn.telegram.org/file/progressive/id/video.mp4');
  assert.equal(source.source, 'page-capture');
  assert.equal(pinCount, 0, '选到 HTTP 源后不得 pin 或提交 currentSrc MediaSource');
});

test('MediaSource pin 错误继续执行 Viewer 原生 fallback；成功时不调用 Downloader', async () => {
  const { resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback, runKViewerNativeDownloadAction } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const nativeCalls = [];
  const actionCalls = [];
  const button = { role: 'download-button' };
  const downloadOption = { label: 'Download original' };
  const nativeAction = await runKViewerNativeDownloadAction({
    findDownloadButton: () => button,
    visibleOptions: () => [],
    waitForOptions: async (timeoutMs) => {
      assert.equal(timeoutMs, 2500);
      return [downloadOption];
    },
    label: (option) => option.label,
    dispatchOriginalClick: async (target) => { actionCalls.push(target); return true; },
  });
  assert.equal(nativeAction.started, true);
  assert.equal(nativeAction.actionKind, 'download');
  assert.deepEqual(actionCalls, [button, downloadOption]);

  const outcome = await resolveKViewerSourceOrNativeFallback(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE',
    })),
    async () => { nativeCalls.push('native'); return nativeAction.started; },
  );
  assert.equal(outcome.kind, 'native-download');
  assert.deepEqual(nativeCalls, ['native']);

  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const marker = { ...item('blob:https://web.telegram.org/mse'), nativeDownloadStarted: true };
  let downloaderCalls = 0;
  const returned = await resolveSidebarAndDownloadMedia(async (_mid, _preferred, beforeClose) => {
    await beforeClose(marker);
    return [marker];
  }, async () => { downloaderCalls += 1; }, 'mid-1');
  assert.equal(returned[0].nativeDownloadStarted, true);
  assert.equal(downloaderCalls, 0);
});

test('MediaSource 与 native fallback 都失败时只返回 K_VIEWER_MEDIA_SOURCE_UNRESOLVED', async () => {
  const { resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback, runKViewerNativeDownloadAction } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let nativeCalls = 0;
  const nativeAction = await runKViewerNativeDownloadAction({
    findDownloadButton: () => ({ role: 'download-button' }),
    visibleOptions: () => [],
    waitForOptions: async () => [],
    label: () => '',
    dispatchOriginalClick: async () => true,
  });
  assert.equal(nativeAction.started, false);
  await assert.rejects(resolveKViewerSourceOrNativeFallback(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE',
    })),
    async () => { nativeCalls += 1; return nativeAction.started; },
  ), (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  assert.equal(nativeCalls, 1);
});

test('普通消息 Session 不使用 expectedKind 前置路由，Sidebar 原生回退协议保持', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const content = await read('../src/content/index.ts');
  const nativeSource = await read('../src/telegram/k-viewer-source.ts');
  assert.match(content, /resolveSingleAttachment: \(session, startDownload\)/);
  assert.doesNotMatch(content, /pinKViewerVideo:\s*expectedKind/);
  assert.match(resolver, /const isKViewerSingleVideo = version === 'K' && sidebarContainer !== undefined && expectedKind === 'video'/);
  assert.match(resolver, /async resolveSingleAttachment\(/);
  assert.match(resolver, /if \(isKViewerSingleVideo && captureSession\)/);
  assert.match(resolver, /if \(resolutionOptions\?\.pinVideoSource\) \{\s*return this\.resolveKViewerSidebarVideo/);
  assert.match(resolver, /resolveKViewerSourceOrNativeFallback\(/);
  assert.match(resolver, /\.media-viewer-whole\.active \.quality-download-options-button-menu/);
  assert.match(resolver, /\.media-viewer-whole\.active \.btn-icon\.tgico-download/);
  assert.match(resolver, /\.media-viewer-buttons \.btn-icon/);
  assert.match(resolver, /dispatchOriginalKViewerClick\(downloadToggle\)/);
  assert.match(nativeSource, /driver\.waitForOptions\(2500\)/);
  assert.match(nativeSource, /options\[optionIndex\]/);
  assert.match(nativeSource, /downloadIndex >= 0 \? downloadIndex : qualityIndex >= 0 \? qualityIndex : 0/);
  assert.match(resolver, /runKViewerNativeDownloadAction<HTMLElement>/);
  assert.doesNotMatch(resolver, /actionable\.click\(\)/);
});

test('K Viewer 激活后确认 video 时进入无原生下载兜底的 single-video 专用路径', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const start = resolver.indexOf('async resolveSingleAttachment(');
  const end = resolver.indexOf('private readSingleViewerImages', start);
  const method = resolver.slice(start, end);
  const readiness = method.indexOf('await this.waitForKActiveViewerMediaReady');
  const specialized = method.indexOf("if (version === 'K' && viewerHasActiveVideo)");
  const genericPreflight = method.indexOf('const preflightCache = new Map', specialized);
  assert.ok(readiness >= 0 && specialized > readiness && genericPreflight > specialized);
  assert.match(method.slice(specialized, genericPreflight), /resolveKViewerSidebarVideo/);
  assert.match(method, /readiness\?\.snapshot\.candidateSet/);
  assert.doesNotMatch(method, /version === 'K'\s*\?\s*\{ candidate: null,[^}]*menu: \[\], viewer: \[\], captured: \[\], performance: \[\]/s);
  assert.match(method, /resolveKViewerSidebarVideo\(viewer, original, captureSession, \{ allowNativeFallback: false \}\)/);
  assert.doesNotMatch(method, /shouldAttemptKNativeFallback\(error\)/);
  assert.doesNotMatch(method, /triggerKViewerNativeDownload\(viewer, session\.messageId\)/);
  assert.doesNotMatch(method, /nativeDownloadStarted\s*:\s*true/);
  assert.doesNotMatch(method, /!decision\.selected && viewerHasVideo && version === 'K'/);
  assert.match(resolver, /requiresPageTransport: source\.source !== 'pinned-blob'/);
  assert.match(resolver, /return \{ \.\.\.item, kSingleVideo: timing \}/);
});

test('single-download 的 HTTP probe 或 Downloader transport 失败都不调用网页原生下载', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const start = resolver.indexOf('async resolveSingleAttachment(');
  const end = resolver.indexOf('private readSingleViewerImages', start);
  const method = resolver.slice(start, end);
  assert.match(method, /await onResolvedBeforeViewerClose\(resolved\)/);
  assert.doesNotMatch(method, /native-fallback|triggerKViewerNativeDownload|shouldAttemptKNativeFallback|nativeDownloadStarted/);
  assert.match(method, /SINGLE_DOWNLOAD_SOURCE_UNRESOLVED/);
  const videoResolverStart = resolver.indexOf('private async resolveKViewerSidebarVideo');
  const videoResolverEnd = resolver.indexOf('private makeKViewerResolvedItem', videoResolverStart);
  const videoResolver = resolver.slice(videoResolverStart, videoResolverEnd);
  assert.match(videoResolver, /if \(options\.allowNativeFallback !== false\) \{\s*\(\{ openedByToggle \} = await this\.openKViewerQualityMenu/);
  assert.match(videoResolver, /options\.allowNativeFallback === false\s*\? Promise\.resolve\(false\)/);
});

test('active-image adoption 只允许当前 active 主图，视频 poster 和 inactive slide 均不能调用', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const start = resolver.indexOf('const activeImage = viewerImages.find');
  const end = resolver.indexOf("console.info('[TG Downloader][single-download] candidates'", start);
  const adoption = resolver.slice(start, end);
  assert.match(adoption, /image\.activeViewerMainMedia === true/);
  assert.match(adoption, /image\.kindHint === 'image'/);
  assert.match(adoption, /viewerScope\.ownsCurrentAttachment/);
  assert.match(adoption, /!viewerHasVideo/);
  assert.match(adoption, /current\.kind === 'image'/);
  assert.match(adoption, /adoptActiveImageBlob/);
});

test('SOURCE_UNRESOLVED 前输出无 URL 的 readiness 汇总字段', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const start = resolver.indexOf("console.error('[TG Downloader][single-download] unresolved-summary '");
  const end = resolver.indexOf("throw Object.assign(new Error('当前附件没有可验证的媒体来源')", start);
  const summary = resolver.slice(start, end);
  for (const field of [
    'messageId', 'attachmentIndex', 'version', 'viewerFound', 'scopeReason', 'rootTag', 'ownsCurrentAttachment',
    'visibleImageCount', 'loadedImageCount', 'visibleVideoCount', 'videoWithSrcCount', 'bridgeCandidateCount',
    'performanceCandidateCount', 'mediaSourceCount', 'acceptedCandidateCount', 'rejectedReasons',
  ]) assert.match(summary, new RegExp(`${field}=`));
  assert.doesNotMatch(summary, /\burl=/i);
});

test('未捕获 Blob 时继续等待 Viewer 延迟出现的 progressive/stream 地址', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let reads = 0;
  let pinCount = 0;
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    if (reads < 3) return { menu: [], viewer: [], captured: [], performance: [] };
    return {
      menu: [], viewer: [], performance: [],
      captured: [{ url: 'https://cdn.telegram.org/file/progressive/delayed-video.mp4', source: 'xhr', contentType: 'video/mp4' }],
    };
  }, 500, 1, () => new Promise((resolve) => setTimeout(resolve, 2)), async (candidate) => ({
    ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/4096',
  }));
  assert.ok(reads >= 3);
  assert.equal(waited.candidate.url, 'https://cdn.telegram.org/file/progressive/delayed-video.mp4');
  const source = await resolveKViewerVideoSource([], [waited.candidate],
    'blob:https://web.telegram.org/untracked', async () => { pinCount += 1; throw new Error('must not pin after HTTP appears'); },
    waited.viewer, waited.performance);
  assert.equal(source.source, 'page-capture');
  assert.equal(pinCount, 0);
});

test('早期普通 viewer-element 弱候选不会结束等待，后续 progressive 经预检后胜出', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  let reads = 0;
  const preflighted = [];
  const weak = { url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true };
  const progressive = { url: 'https://cdn.telegram.org/file/progressive/id/video.mp4', source: 'fetch', contentType: 'video/mp4' };
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    return {
      menu: [], viewer: [weak], captured: reads >= 3 ? [progressive] : [], performance: [],
    };
  }, 500, 1, () => new Promise((resolve) => setTimeout(resolve, 2)), async (candidate) => {
    preflighted.push(candidate.url);
    if (candidate.url === weak.url) return { ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' };
    return { ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/2048' };
  });
  assert.ok(reads >= 3, 'poll one weak candidate must not finish the wait');
  assert.ok(preflighted.includes(weak.url));
  assert.equal(waited.candidate.url, progressive.url);
  assert.equal(waited.candidate.preflightVerified, true);
  assert.ok(waited.rejectedCandidates.some((entry) => entry.status === 302 && entry.contentType === 'text/html'));
  const resolved = await resolveKViewerVideoSource([], [waited.candidate], '', async () => ({ ok: false }));
  const actions = [];
  await startKViewerDownloadAfterSourceResolution(async () => resolved,
    async (media) => actions.push(`download:${media.url}`), async () => actions.push('viewer-close'));
  assert.deepEqual(actions, [`download:${progressive.url}`, 'viewer-close']);
});

test('只有普通 web.telegram.org 弱候选时不启动 Downloader，继续 Blob pin 后 native fallback', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const weak = { url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true };
  const waited = await waitForKViewerHttpSource(async () => ({ menu: [], viewer: [weak], captured: [], performance: [] }),
    20, 1, async () => {}, async () => ({ ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' }));
  assert.equal(waited.candidate, null);
  assert.equal(waited.weakCandidateCount, 1);

  let downloaderCalls = 0;
  let pinCalls = 0;
  let nativeCalls = 0;
  const outcome = await resolveKViewerSourceOrNativeFallback(async () => {
    if (waited.candidate) return resolveKViewerVideoSource([], [waited.candidate], '', async () => { pinCalls += 1; return { ok: false }; });
    return resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => {
      pinCalls += 1;
      return { ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE' };
    });
  }, async () => { nativeCalls += 1; return true; });
  assert.equal(outcome.kind, 'native-download');
  assert.equal(pinCalls, 1);
  assert.equal(nativeCalls, 1);
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const nativeMarker = { ...item('https://cdn.telegram.org/thumb.jpg'), nativeDownloadStarted: true };
  await resolveSidebarAndDownloadMedia(async (_messageId, _preferred, beforeClose) => {
    await beforeClose(nativeMarker);
    return [nativeMarker];
  }, async () => { downloaderCalls += 1; }, 'mid-1');
  assert.equal(downloaderCalls, 0);
});

test('全部 HTTP candidate 被 probe 拒绝后才进入 Telegram native fallback', async () => {
  const { waitForKViewerHttpSource, resolveKViewerSourceOrNativeFallback } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  const waited = await waitForKViewerHttpSource(async () => ({
    menu: [{ url: 'https://web.telegram.org/k/download/video', source: 'quality-menu', trustedQualityMenu: true }],
    viewer: [{ url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true }],
    captured: [], performance: [],
  }), 10, 1, async () => {}, async (candidate) => ({
    ok: false, status: 302, finalUrl: 'https://web.telegram.org/login', contentType: 'text/html',
    code: 'HTTP_REDIRECT_NOT_FOLLOWED',
  }));
  let downloaderCalls = 0;
  let nativeCalls = 0;
  let sourceStableCalls = 0;
  await assert.rejects(startKViewerDownloadAfterSourceResolution(async () => {
    if (!waited.candidate) return null;
    sourceStableCalls += 1;
    return { url: waited.candidate.url };
  }, async () => { downloaderCalls += 1; }, async () => {}),
  (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  const outcome = await resolveKViewerSourceOrNativeFallback(async () => {
    if (!waited.candidate) return null;
    downloaderCalls += 1;
    return waited.candidate;
  }, async () => { nativeCalls += 1; return true; });
  assert.equal(waited.candidate, null);
  assert.equal(waited.rejectedCandidates.length, 2);
  assert.equal(downloaderCalls, 0);
  assert.equal(sourceStableCalls, 0, 'a rejected 302 candidate must never become sourceStable');
  assert.equal(nativeCalls, 1);
  assert.equal(outcome.kind, 'native-download');
});

test('弱候选 302 + HTML 被拒绝并继续轮询，不抛出为最终下载错误', async () => {
  const { waitForKViewerHttpSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let reads = 0;
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    return { menu: [], viewer: [{ url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true }], captured: [], performance: [] };
  }, 20, 1, async () => {}, async () => ({ ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' }));
  assert.ok(reads > 1);
  assert.equal(waited.candidate, null);
  assert.equal(waited.rejectedCandidates[0].code, 'HTTP_REDIRECT_NOT_FOLLOWED');
});

test('strong candidate 只有在 206 video/mp4 + Content-Range 预检后才启动 Downloader', async () => {
  const [{ waitForKViewerHttpSource, resolveKViewerVideoSource }, { startKViewerDownloadAfterSourceResolution }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const strong = { url: 'https://cdn.telegram.org/file/progressive/video.mp4', source: 'fetch', contentType: 'video/mp4' };
  const waited = await waitForKViewerHttpSource(async () => ({ menu: [], viewer: [], captured: [strong], performance: [] }),
    100, 1, async () => {}, async (candidate) => ({
      ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/1000',
    }));
  const resolved = await resolveKViewerVideoSource([], [waited.candidate], '', async () => ({ ok: false }));
  const order = [];
  await startKViewerDownloadAfterSourceResolution(async () => resolved,
    async (media) => order.push(`downloader:${media.url}`), async () => order.push('viewer-close'));
  assert.deepEqual(order, [`downloader:${strong.url}`, 'viewer-close']);
});

test('progressive 候选预检重定向到无扩展 CDN URL 时用视频 MIME 保留已验证的媒体证据', async () => {
  const { waitForKViewerHttpSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const waited = await waitForKViewerHttpSource(async () => ({
    menu: [], viewer: [],
    captured: [{ url: 'https://web.telegram.org/file/progressive/source-id', source: 'fetch' }],
    performance: [],
  }), 100, 1, async () => {}, async () => ({
    ok: true, status: 206, finalUrl: 'https://cdn.telegram.org/file/media-id',
    contentType: 'video/mp4', contentRange: 'bytes 0-0/8192', redirected: true,
  }));
  assert.equal(waited.candidate.url, 'https://cdn.telegram.org/file/media-id');
  assert.equal(waited.candidate.preflightVerified, true);
  assert.equal(waited.candidate.verifiedStrongEvidence, true);
});

test('稳定 HTTP 来源先启动 Downloader 再关闭 Viewer；来源缺失时不启动也不关闭', async () => {
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  const order = [];
  const source = { url: 'https://cdn.telegram.org/file/stream/video.mp4' };
  await startKViewerDownloadAfterSourceResolution(async () => {
    order.push('source-stable');
    return source;
  }, async (item) => { order.push(`downloader-start:${item.url}`); }, async () => { order.push('viewer-close'); });
  assert.deepEqual(order, [
    'source-stable', 'downloader-start:https://cdn.telegram.org/file/stream/video.mp4', 'viewer-close',
  ]);

  const unresolved = [];
  await assert.rejects(startKViewerDownloadAfterSourceResolution(async () => null,
    async () => unresolved.push('downloader-start'), async () => unresolved.push('viewer-close')),
  (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  assert.deepEqual(unresolved, []);
});

test('Telegram 原生质量下载标记不会再提交给 Downloader', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  let downloads = 0;
  const native = { ...item('https://cdn.telegram.org/thumb.jpg'), nativeDownloadStarted: true };
  const result = await resolveSidebarAndDownloadMedia(async () => [native], async () => { downloads += 1; }, 'mid-1');
  assert.equal(result[0].nativeDownloadStarted, true);
  assert.equal(downloads, 0);
});

test('K Viewer 单项诊断只记录来源类型且 HTTP Range 日志隐藏最终路径', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const downloader = await read('../src/downloader/downloader.ts');
  const start = resolver.indexOf('private async resolveKViewerSidebarVideo');
  const end = resolver.indexOf('private makeKViewerResolvedItem', start);
  const targetedPath = resolver.slice(start, end);
  assert.doesNotMatch(targetedPath, /finalUrl\s*:/);
  assert.doesNotMatch(targetedPath, /console\.(?:info|warn|error)\([^;]*\burl\s*:/s);
  assert.match(targetedPath, /qualityMenuCandidates/);
  assert.match(targetedPath, /capturedHttpCandidates/);
  assert.match(targetedPath, /bridgeInstalledBeforeViewer/);
  assert.match(targetedPath, /formatErrorLog\('\[TG Downloader\]\[viewer\] source unresolved'/);
  assert.match(targetedPath, /stage: 'viewer-source'/);
  assert.match(targetedPath, /viewerUrlType: diagnostics\.viewerUrlType/);
  assert.match(targetedPath, /objectUrlKind: diagnostics\.objectUrlKind/);
  for (const field of ['candidateSource', 'pathClass', 'initialHost', 'probeTransport', 'probeStatus', 'probeContentType', 'probeRedirected', 'finalHost', 'accepted', 'rejectReason']) {
    assert.match(targetedPath, new RegExp(`${field}:`), `missing redacted probe field ${field}`);
  }
  assert.match(targetedPath, /main-world-page-bridge/);
  assert.match(resolver, /requiresPageTransport: source\.source !== 'pinned-blob'/);
  const probeStart = targetedPath.indexOf('const logProbe =');
  const probeEnd = targetedPath.indexOf('const firstWait =', probeStart);
  const probeLogger = targetedPath.slice(probeStart, probeEnd);
  assert.doesNotMatch(probeLogger, /\burl\s*:/,
    'candidate probe log payload must not contain a URL field');
  assert.match(downloader, /finalUrlHost:\s*getUrlHost/);
  assert.doesNotMatch(downloader, /finalUrl:\s*String\(response\.finalUrl/);
});

test('Sidebar 单项下载日志只记录 URL 类型，不输出完整媒体地址', async () => {
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /console\.info\('\[TG Downloader\]\[media-item\] MediaItem', chosen\.map\(\(item\) => \(\{/);
  assert.match(enhancer, /urlType: mediaUrlType\(item\.url\)/);
  assert.doesNotMatch(enhancer, /console\.info\(force \? '[^']+' : '[^']+', chosen\)/);
});

test('K Viewer 只有在真实 Blob pin 成功后才关闭 Viewer 并启动一次下载', async () => {
  const [{ resolveKViewerVideoSource }, { resolveViewerMediaBeforeClose }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const order = [];
  let finishDownload;
  const downloadPromise = new Promise((resolve) => { finishDownload = resolve; });
  const pending = resolveViewerMediaBeforeClose(async () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/viewer-blob', async () => {
    order.push('pin-request');
    await Promise.resolve();
    order.push('pin-complete');
    return { ok: true, objectUrlKind: 'blob', cacheState: 'hit', size: 4, mimeType: 'video/mp4', leaseId: 'lease-1' };
  }), async (source) => {
    order.push(`download-start:${source.blobLeaseId}`);
    return downloadPromise;
  }, async () => { order.push('viewer-close'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['pin-request', 'pin-complete', 'download-start:lease-1', 'viewer-close']);
  finishDownload();
  const source = await pending;
  assert.equal(source.size, 4);
  assert.equal(source.blobLeaseId, 'lease-1');
});

test('K Viewer MediaSource 无 HTTP 候选时明确失败且不启动 Downloader', async () => {
  const [{ resolveKViewerVideoSource }, { resolveViewerMediaBeforeClose }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const order = [];
  await assert.rejects(resolveViewerMediaBeforeClose(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', cacheState: 'hit', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', error: 'MediaSource is playback only',
    })),
    async () => { order.push('download-start'); },
    async () => { order.push('viewer-close'); },
  ), (error) => error.code === 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE');
  assert.deepEqual(order, ['viewer-close']);
});

test('Sidebar resolve 空结果显式报 NO_MEDIA_URL 并显示按钮失败文案', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  await assert.rejects(resolveSidebarAndDownloadMedia(async () => [], async () => {}, 'mid-1'), /NO_MEDIA_URL/);
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /\[TG Downloader\]\[media-item\] NO_MEDIA_URL/);
  assert.match(enhancer, /LABELS\.downloadFailed/);
});

test('Advanced Download 主流程不调用 prompt', async () => {
  const content = await read('../src/content/index.ts');
  assert.doesNotMatch(content, /window\.prompt\s*\(/);
});

test('Advanced Download 主流程不调用 confirm', async () => {
  const content = await read('../src/content/index.ts');
  assert.doesNotMatch(content, /window\.confirm\s*\(/);
});

test('点击高级下载入口通过原版 OPEN_UNIFIED_CHAT_EXPORT_DIALOG 协议挂载 Shadow DOM 组件', async () => {
  const controller = await read('../src/telegram/advanced-download-dialog.ts');
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(controller, /tg-downloader-shadow-host/);
  assert.match(controller, /OPEN_UNIFIED_CHAT_EXPORT_DIALOG/);
  assert.match(controller, /TG_START_CHAT_MEDIA_EXPORT/);
  assert.match(component, /class="tg-cme-dialog"/);
  assert.match(component, /加载完整历史媒体/);
  assert.match(enhancer, /LABELS\.advancedDownload/);
  assert.doesNotMatch(controller, /TGDownloaderShadowDOM\.show/);
});

test('高级下载过滤媒体类型并按本地历史跳过已完成项目', async () => {
  const { filterAdvancedMediaItems } = await loadFlow();
  const items = [item('https://cdn.telegram.org/a'), { ...item('https://cdn.telegram.org/b'), kind: 'image', hasDownloaded: true }, { ...item('https://cdn.telegram.org/c'), kind: 'gif' }];
  const selected = filterAdvancedMediaItems(items, { mediaTypes: ['image', 'gif'], visibleOnly: true, loadAllMedia: false, skipDownloaded: true });
  assert.deepEqual(Array.from(selected, (entry) => entry.url), ['https://cdn.telegram.org/c']);
});

test('批量预解析回调每个已选媒体最多启动一次下载', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const downloads = [];
  const media = item('https://cdn.telegram.org/a');
  const result = await downloadBatchMedia([media, { ...media }], async (mid, url, beforeClose) => {
    await beforeClose(media);
    return [media];
  }, async (entry) => downloads.push(entry.url));
  assert.equal(result.success, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(downloads, [media.url]);
});

test('Sidebar 视频的 Viewer 解析回调仍在关闭前创建一次下载任务', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const media = { ...item('blob:https://web.telegram.org/video'), kind: 'video' };
  const order = [];
  const result = await downloadBatchMedia([media], async (_mid, _url, beforeClose) => {
    order.push('viewer-open');
    await beforeClose(media);
    order.push('viewer-close');
    return [media];
  }, async (entry) => order.push(`download:${entry.url}`));
  assert.equal(result.success, 1);
  assert.deepEqual(order, ['viewer-open', `download:${media.url}`, 'viewer-close']);
});

test('批量首项解析失败会被隔离，第二项继续并返回成功失败计数', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const first = item('https://cdn.telegram.org/image-1.jpg', 'mid-1');
  const second = item('https://cdn.telegram.org/video-2.mp4', 'mid-2');
  const downloaded = [];
  const events = [];
  const result = await downloadBatchMedia([first, second], async (mid, url) => {
    if (mid === first.messageId) throw Object.assign(new DOMException('Viewer did not open', 'InvalidStateError'), { code: 'VIEWER_NOT_OPEN' });
    return [item(url, mid)];
  }, async (entry) => downloaded.push(entry.url), (event) => events.push(event));
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].stage, 'resolve');
  assert.deepEqual(downloaded, [second.url]);
  assert.deepEqual(events.filter((event) => event.status === 'complete').map((event) => event.item.messageId), ['mid-2']);
});

test('selectedKeys 只从 content canonical map 解析，不接受 Vue MediaItem 对象', async () => {
  const { resolveSelectedMediaKeys } = await loadFlow();
  const canonical = [item('blob:https://web.telegram.org/a', 'mid-1'), item('blob:https://web.telegram.org/b', 'mid-2')];
  const canonicalMap = new Map(canonical.map((entry) => [`${entry.messageId}\u0000${entry.url}`, entry]));
  const selection = resolveSelectedMediaKeys(canonicalMap, [
    { messageId: 'mid-2', url: 'blob:https://web.telegram.org/b' },
    { messageId: 'missing', url: 'blob:https://web.telegram.org/nope' },
  ]);
  assert.equal(selection.length, 1);
  assert.equal(selection[0], canonical[1]);
});

test('loadAllMedia 调用稳定身份扫描，历史扫描使用身份 key 去重', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  assert.match(resolver, /async loadAllMedia\(timeoutMs = 45000\)/);
  assert.match(resolver, /return this\.loadAllScannedIdentities\(timeoutMs\)/);
  assert.match(resolver, /collected\.set\(item\.stableKey, item\)/);
  assert.match(resolver, /scrollRoot\.scrollTop = originalTop/);
  assert.match(resolver, /A_SIDEBAR_SELECTORS[\s\S]*?scrollRoot\.scrollTop/);
  const content = await read('../src/content/index.ts');
  assert.match(content, /resolver\.loadAllMedia\(\)/);
  assert.match(content, /runFullHistoryScanSequence/);
  assert.doesNotMatch(content, /executeIdentityBatch\(.*loadAll/i);
});

test('A 版 loadAll 仅滚动并恢复 #RightColumn 媒体列表容器', async () => {
  const source = await read('../src/telegram/original-media-resolver.ts');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const queried = [];
  const assignedScrollTops = [];
  class FakeHTMLElement {
    constructor() { this.isConnected = true; this.clientHeight = 100; this.scrollHeight = 600; this._scrollTop = 73; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = value; assignedScrollTops.push(value); }
    getBoundingClientRect() { return { width: 300, height: 500 }; }
    querySelectorAll() { return []; }
    getAttribute() { return null; }
    closest() { return null; }
  }
  const scrollRoot = new FakeHTMLElement();
  const document = {
    querySelectorAll(selector) {
      queried.push(selector);
      if (selector.startsWith('#RightColumn')) return [scrollRoot];
      return [];
    },
    querySelector() { return null; },
  };
  const dependencies = {
    './adapter': { classifyMessage: () => null, classifySidebarMedia: () => null, detectTelegramVersion: () => 'A', getMessageId: () => '', messageSelector: () => '' },
    './download-flow': { resolveViewerMediaBeforeClose: async () => null },
    '../utils/filename': { filenameFromUrl: () => 'media.bin', safeFilename: (value) => value },
    '../utils/errors': { formatError: (error) => ({ name: error?.name || 'Error', message: error?.message || String(error) }), formatErrorLog: (prefix) => prefix },
    './captured-media-registry': { enrichCapturedMedia: (item) => item },
  };
  const module = { exports: {} };
  const require = (name) => dependencies[name];
  const window = { setTimeout(callback) { callback(); return 1; } };
  const context = vm.createContext({ module, exports: module.exports, require, document, window, location: { hash: '' }, HTMLElement: FakeHTMLElement, Element: FakeHTMLElement, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), Date, URL });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  const resolver = new module.exports.TelegramMediaResolver();
  resolver.openChannelMedia = async () => true;
  const result = await resolver.loadAllMedia(1000);
  assert.equal(result.length, 0);
  assert.equal(scrollRoot.scrollTop, 73, '扫描完成后恢复用户当前滚动位置');
  assert.ok(assignedScrollTops.includes(0));
  assert.ok(assignedScrollTops.includes(600));
  assert.ok(queried.includes('#RightColumn .Profile.custom-scroll'));
});

test('Viewer blob URL 从 CapturedMediaRegistry 补充 MIME 与 size', async () => {
  const registry = await loadStandaloneTypeScript('../src/telegram/captured-media-registry.ts');
  const url = 'blob:https://web.telegram.org/viewer-blob';
  registry.rememberCapturedMedia({ url, mimeType: 'video/webm', size: 4096, source: 'blob' });
  const item = registry.enrichCapturedMedia({ url, mimeType: 'application/octet-stream', size: 0 });
  assert.equal(item.mimeType, 'video/webm');
  assert.equal(item.size, 4096);
});

test('A progressive 302 由 background Fetch 默认跟随，Downloader 仍验证最终 Range 响应', async () => {
  const background = await read('../src/background/index.ts');
  const downloader = await read('../src/downloader/downloader.ts');
  assert.match(background, /fetch\(url\.href, \{ credentials: 'include', redirect: 'follow', headers: \{ Range:/);
  assert.doesNotMatch(background, /redirect:\s*['"]manual['"]/);
  assert.match(downloader, /response\.status !== 206 \|\| !match/);
  assert.match(downloader, /rangeStart !== transfer\.offset/);
});

test('Advanced batch 在开始扫描历史和处理单项时更新实时状态文本', async () => {
  const content = await read('../src/content/index.ts');
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  assert.match(content, /正在扫描完整历史媒体/);
  assert.match(content, /已发现 \$\{withHistory\.length\} 项/);
  assert.match(content, /正在处理 \$\{index\}\/\$\{total\}/);
  assert.match(component, /progress\?\.statusText/);
  assert.match(content, /setAdvancedDownloadDialogVisible\(false\)/);
  assert.match(content, /setAdvancedDownloadDialogVisible\(true\)/);
});

test('所有下载仍只通过一个 Downloader.start 出口且仅在有 lease 时保留 revoked Blob 引用', async () => {
  const content = await read('../src/content/index.ts');
  const bridge = await read('../public/page-bridge.js');
  const downloader = await read('../src/downloader/downloader.ts');
  assert.equal((content.match(/downloader\.start\s*\(/g) || []).length, 1);
  assert.match(downloader, /\[TG Downloader\]\[download\] start/);
  assert.match(bridge, /objectUrls\.set\(url, \{ \.\.\.object, \.\.\.history, revoked: false, leases: new Set\(\) \}\)/);
  const revoke = bridge.match(/URL\.revokeObjectURL = \(url\) => \{([\s\S]*?)\n\s*\};/)?.[1] || '';
  assert.match(revoke, /if \(entry\.leases\.size === 0\) objectUrls\.delete\(url\)/);
  assert.match(revoke, /originalRevoke\(url\)/);
  assert.doesNotMatch(bridge, /knownBlobs/);
});

test('下载按钮、高级弹窗英文替换集中在 labels 映射中', async () => {
  const labels = await read('../src/i18n/labels.ts');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(labels, /forceDownload: '强制下载'/);
  assert.match(labels, /advancedDownload: '高级下载'/);
  assert.match(labels, /downloadMonth: '下载本月媒体'/);
  assert.doesNotMatch(enhancer, /'Advanced Download'|'Progress:'|'FORCE DOWNLOAD'/);
});

const identity = (stableKey, messageId = stableKey, kind = 'video') => ({
  stableKey, version: 'K', messageId, peerId: 'peer-1', kind,
  monthGroup: '2026-10', dateTimestamp: 1790812800000, duration: '0:04',
  thumbnail: 'blob:https://web.telegram.org/thumb', sidebarKey: `K:peer-1:${messageId}`, mediaIndex: 0,
});

test('高级批量不保存扫描 Blob URL，每项开始前通过 identity 重新 resolve', async () => {
  const { downloadIdentityBatch } = await loadFlow();
  const selected = [identity('K:peer-1:m1:video:0', 'm1'), identity('K:peer-1:m2:video:0', 'm2')];
  const resolvedKeys = [];
  const downloaded = [];
  const result = await downloadIdentityBatch(selected, async (entry, startBeforeClose) => {
    resolvedKeys.push(entry.stableKey);
    assert.equal('url' in entry, false, 'ScannedMediaIdentity 没有下载 URL');
    const fresh = item(`blob:https://web.telegram.org/fresh-${entry.messageId}`, entry.messageId);
    await startBeforeClose(fresh);
    return fresh;
  }, async (fresh, entry) => {
    assert.equal(fresh.id, entry.stableKey);
    downloaded.push(fresh.url);
  });
  assert.equal(result.success, 2);
  assert.deepEqual(resolvedKeys, selected.map((entry) => entry.stableKey));
  assert.deepEqual(downloaded, [
    'blob:https://web.telegram.org/fresh-m1',
    'blob:https://web.telegram.org/fresh-m2',
  ]);
  assert.ok(downloaded.every((url) => !url.includes('scanned')));
});

test('高级批量按所选 stable identity 过滤，未勾选项目不进入 Downloader', async () => {
  const { resolveSelectedIdentities, filterScannedIdentities, downloadIdentityBatch } = await loadFlow();
  const first = identity('K:peer-1:m1:video:0', 'm1');
  const second = identity('K:peer-1:m2:image:0', 'm2', 'image');
  const canonical = new Map([[first.stableKey, first], [second.stableKey, second]]);
  const selected = resolveSelectedIdentities(canonical, [second.stableKey]);
  const eligible = filterScannedIdentities(selected, { mediaTypes: ['image', 'video', 'gif'], skipDownloaded: false });
  const downloaded = [];
  const result = await downloadIdentityBatch(eligible, async (entry, start) => {
    const fresh = item(`blob:https://web.telegram.org/${entry.messageId}`, entry.messageId);
    await start(fresh);
    return fresh;
  }, async (_item, entry) => downloaded.push(entry.stableKey));
  assert.equal(result.success, 1);
  assert.deepEqual(downloaded, [second.stableKey]);
});

test('完整历史扫描先隐藏弹窗、执行滚动扫描、更新结果，再重新打开且不触发下载', async () => {
  const { runFullHistoryScanSequence } = await loadFlow();
  const order = [];
  let hidden = false;
  let reopenedItems = [];
  const items = [identity('K:peer-1:m1:video:0', 'm1')];
  await runFullHistoryScanSequence(
    () => { hidden = true; order.push('hide'); },
    async () => {
      assert.equal(hidden, true);
      order.push('scroll-and-collect');
      return items;
    },
    (result) => { reopenedItems = result; order.push('update-list'); },
    () => { hidden = false; order.push('reopen'); },
  );
  assert.deepEqual(order, ['hide', 'scroll-and-collect', 'update-list', 'reopen']);
  assert.equal(hidden, false);
  assert.deepEqual(reopenedItems, items);
});

test('扫描结果稳定去重和 UI 都以 stable identity 为键而非 Blob URL', async () => {
  const { dedupeScannedIdentities } = await loadFlow();
  const original = identity('K:peer-1:m1:image:0', 'm1', 'image');
  const duplicate = { ...original, thumbnail: 'blob:https://web.telegram.org/new-thumbnail' };
  assert.equal(dedupeScannedIdentities([original, duplicate]).length, 1);
  assert.equal('url' in original, false);
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  assert.match(component, /type="checkbox"/);
  assert.match(component, /selectedStableKeys\.has\(item\.stableKey\)/);
  assert.match(component, /function selectAll/);
  assert.match(component, /function clearAll/);
  assert.match(component, /已选择 \{\{ selectedItems\.length \}\} \/ \{\{ typedItems\.length \}\}/);
});

test('K 批量启动点不再把 Media-card URL 作为 preferred URL 传给 Downloader', async () => {
  const content = await read('../src/content/index.ts');
  const source = await read('../src/telegram/download-flow.ts');
  assert.match(content, /resolver\.resolveScannedIdentity\(identity, beforeViewerClose\)/);
  assert.match(source, /resolveCurrent: \(\s*identity: ScannedMediaIdentity/);
  assert.doesNotMatch(content, /resolveSidebarItem\(messageId, preferredUrl, true, beforeViewerClose\)/);
});
