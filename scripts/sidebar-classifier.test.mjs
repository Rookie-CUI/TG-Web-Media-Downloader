import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

async function loadModule(path, dependencies = {}, globals = {}) {
  const source = await read(path);
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const module = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected import ${name}`);
  };
  const context = vm.createContext({ module, exports: module.exports, require, console, URL, WeakMap, Date, ...globals });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return module.exports;
}

function fakeNode({ tag = 'div', className = '', textContent = '', attrs = {}, click = () => {} } = {}) {
  return {
    tagName: tag.toUpperCase(), className, textContent, naturalWidth: 0, naturalHeight: 0, width: 0, height: 0,
    click,
    getAttribute(name) { return attrs[name] ?? null; },
  };
}

function fakeCard({ children = [], durationText, className = 'media-container', parentGif = false } = {}) {
  const duration = durationText === undefined ? null : fakeNode({ className: 'video-time', textContent: durationText });
  const card = {
    tagName: 'DIV', className,
    getAttribute(name) { return name === 'data-mid' ? 'mid-test' : null; },
    matches(selector) { return selector.split(',').map((value) => value.trim()).includes(className); },
    querySelector(selector) {
      if (selector.includes('.video-time') || selector.includes('.video-duration')) return duration;
      const alternatives = selector.split(',').map((value) => value.trim());
      return children.find((child) => alternatives.some((alternative) => child.selectors.includes(alternative)))?.node || null;
    },
    closest(selector) { return parentGif && selector.includes('.gif') ? card : null; },
  };
  return card;
}

const child = (selector, node = fakeNode()) => ({ selectors: [selector], node });

test('K版 img 缩略图加 video-time 按原版规则分类为 video，并按卡片只记录一次诊断', async () => {
  const logs = [];
  const { classifySidebarMedia } = await loadModule('../src/telegram/sidebar-classifier.ts');
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args);
  try {
    const card = fakeCard({ children: [child('img')], durationText: '00:14' });
    assert.equal(classifySidebarMedia(card), 'video');
    assert.equal(classifySidebarMedia(card), 'video');
  } finally {
    console.info = originalInfo;
  }
  assert.equal(logs.filter(([label]) => label === '[TG Downloader][sidebar-scan]').length, 1);
  assert.equal(logs[0][1].messageId, 'mid-test');
  assert.equal(logs[0][1].hasImg, true);
  assert.equal(logs[0][1].hasVideoTime, true);
  assert.equal(Object.hasOwn(logs[0][1], 'url'), false);
});

test('K版普通消息 bubble 同时含 img thumbnail 与 video-time 时分类为 video', async () => {
  const duration = fakeNode({ className: 'video-time', textContent: '00:14' });
  const attachment = {
    querySelector(selector) {
      if (selector.includes('.video-time') || selector.includes('.video-duration')) return duration;
      if (selector.includes('img.media-photo')) return fakeNode({ tag: 'img', attrs: { src: 'https://cdn.telegram.org/thumb.webp' } });
      return null;
    },
  };
  const message = {
    classList: { contains() { return false; } },
    querySelector(selector) {
      if (selector.includes('.attachment.media-container')) return attachment;
      return null;
    },
  };
  const { classifyMessage } = await loadModule('../src/telegram/adapter.ts', {
    '../utils/filename': { filenameFromUrl: () => 'media.bin', safeFilename: (value) => value },
    './sidebar-classifier': { classifySidebarMedia: () => null },
    './captured-media-registry': { rememberCapturedMedia() {} },
  }, {
    location: { href: 'https://web.telegram.org/k/' },
    document: { querySelector() { return null; } },
  });
  assert.equal(classifyMessage(message), 'video');
});

test('img 缩略图带原版 video-play 标记分类为 video', async () => {
  const { classifySidebarMedia } = await loadModule('../src/telegram/sidebar-classifier.ts');
  assert.equal(classifySidebarMedia(fakeCard({ children: [child('img'), child('.btn-circle.video-play')] })), 'video');
});

test('没有视频信号的纯 img 分类为 image', async () => {
  const { classifySidebarMedia } = await loadModule('../src/telegram/sidebar-classifier.ts');
  assert.equal(classifySidebarMedia(fakeCard({ children: [child('img')] })), 'image');
});

test('GIF 时长和 GIF 容器按原版优先级分类为 gif', async () => {
  const { classifySidebarMedia } = await loadModule('../src/telegram/sidebar-classifier.ts');
  assert.equal(classifySidebarMedia(fakeCard({ durationText: 'GIF', children: [child('img')] })), 'gif');
  assert.equal(classifySidebarMedia(fakeCard({ children: [child('.media-gif-wrapper')] })), 'gif');
});

test('高级弹窗同一份扫描列表正确统计 3 图片、7 视频、1 GIF', async () => {
  const { countSidebarMediaKinds } = await loadModule('../src/telegram/sidebar-classifier.ts');
  const items = [
    ...Array.from({ length: 3 }, () => ({ kind: 'image' })),
    ...Array.from({ length: 7 }, () => ({ kind: 'video' })),
    { kind: 'gif' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(countSidebarMediaKinds(items))), { total: 11, image: 3, video: 7, gif: 1 });
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  assert.match(component, /image: props\.mediaList\.filter/);
  assert.match(component, /video: props\.mediaList\.filter/);
  assert.match(component, /gif: props\.mediaList\.filter/);
});

async function loadResolver() {
  const flow = await loadModule('../src/telegram/download-flow.ts');
  const kViewerSource = await loadModule('../src/telegram/k-viewer-source.ts');
  const filename = {
    filenameFromUrl: (url, kind) => new URL(url).pathname.split('/').at(-1) || `telegram-${kind}.bin`,
    safeFilename: (value) => value,
  };
  const errors = {
    formatError: (error) => ({ name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack }),
    formatErrorLog: (prefix, error) => `${prefix}: name=${error?.name || 'Error'} message=${error?.message || String(error)}`,
  };
  const adapter = {
    classifyMessage: () => null,
    classifySidebarMedia: () => 'image',
    detectTelegramVersion: () => 'K',
    getMessageId: () => 'mid-test',
    messageSelector: () => '.bubble',
  };
  return loadModule('../src/telegram/original-media-resolver.ts', {
    '../downloader/media-container': await loadModule('../src/downloader/media-container.ts'),
    './adapter': adapter,
    './download-flow': flow,
    '../utils/filename': filename,
    '../utils/errors': errors,
    './captured-media-registry': { enrichCapturedMedia: (item) => item },
    './k-viewer-source': kViewerSource,
  });
}

test('Sidebar 图片按原版点击整张媒体卡后可检测到 Viewer', async () => {
  const { openSidebarImageViewer, sidebarImageClickTargets } = await loadResolver();
  let opened = false;
  const card = {
    tagName: 'DIV', className: 'media-container',
    click() { opened = true; },
    querySelector() { return null; },
  };
  const targets = sidebarImageClickTargets(card);
  assert.equal(targets.length, 1);
  assert.equal(targets[0], card);
  const viewer = fakeNode({ className: 'media-viewer-whole active' });
  const openedViewer = await openSidebarImageViewer(card, async () => opened ? viewer : null);
  assert.equal(openedViewer, viewer);
});

test('Sidebar 图片卡点击抛 DOMException 时保留 name/message 且不伪装为打开成功', async () => {
  const { openSidebarImageViewer } = await loadResolver();
  const card = { tagName: 'DIV', className: 'media-container', querySelector: () => null, click() { throw new DOMException('Card detached', 'InvalidStateError'); } };
  const errors = [];
  const viewer = await openSidebarImageViewer(card, async () => null, undefined, (_target, error) => errors.push(error));
  assert.equal(viewer, null);
  assert.equal(errors[0].name, 'InvalidStateError');
  assert.equal(errors[0].message, 'Card detached');
});

test('K Viewer 图片解析优先选择实际像素面积最大的可用 URL', async () => {
  const { largestViewerImageCandidate } = await loadResolver();
  const candidate = largestViewerImageCandidate([
    { src: 'https://cdn.telegram.org/thumb.jpg', naturalWidth: 180, naturalHeight: 120 },
    { currentSrc: 'blob:https://web.telegram.org/full', src: 'https://cdn.telegram.org/full.jpg', naturalWidth: 1600, naturalHeight: 1200 },
  ]);
  assert.equal(candidate.url, 'blob:https://web.telegram.org/full');
  assert.equal(candidate.width, 1600);
  assert.equal(candidate.height, 1200);
});

test('Sidebar 图片通过原版卡片点击、K Viewer 图片 URL 解析并在关闭前创建下载任务', async () => {
  const { TelegramMediaResolver } = await loadResolver();
  const resolver = new TelegramMediaResolver();
  const url = 'https://cdn.telegram.org/thumb.jpg';
  const fullUrl = 'blob:https://web.telegram.org/full-photo';
  const item = { id: `mid-test:${url}`, url, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 120, kind: 'image', messageId: 'mid-test', peerId: 'peer-test', fileId: '', source: 'dom', capturedAt: 1, monthGroup: '', hasDownloaded: false };
  const mediaNode = { tagName: 'IMG', className: 'media-photo', currentSrc: url, src: url, getAttribute: (name) => name === 'src' ? url : null };
  resolver.nodesByItem.set(item.id, mediaNode);
  resolver.resolveMessage = async () => [item];
  const events = [];
  const image = {
    currentSrc: fullUrl, src: fullUrl, naturalWidth: 1800, naturalHeight: 1200, width: 600, height: 400,
    getAttribute: (name) => name === 'src' ? fullUrl : name === 'type' ? 'image/jpeg' : null,
    closest: () => null,
  };
  const movers = { querySelectorAll: (selector) => selector === 'img[src]' ? [image] : [] };
  const viewer = {
    querySelectorAll: () => [],
    querySelector: (selector) => selector === '.media-viewer-movers' ? movers : null,
  };
  resolver.waitForKImageViewer = async () => viewer;
  resolver.resolveKViewer = async (opened, original) => resolver.readKViewerMedia(opened, original);
  resolver.closeViewer = async () => { events.push('viewer-close'); };
  const card = {
    tagName: 'DIV', className: 'media-container', querySelector: () => null,
    click() { events.push('card-click'); },
  };
  const result = await resolver.resolveForce('mid-test', url, async (entry) => events.push(`download:${entry.url}`), 'image', card);
  assert.equal(result[0].url, fullUrl);
  assert.deepEqual(events, ['card-click', `download:${fullUrl}`, 'viewer-close']);
});

test('恢复版 Advanced Submit 协议发送和接收同一类型与 mark', async () => {
  const controller = await read('../src/telegram/advanced-download-dialog.ts');
  const content = await read('../src/content/index.ts');
  assert.match(controller, /type: 'TG_START_CHAT_MEDIA_EXPORT'/);
  assert.match(content, /event\.data\?\.type !== 'TG_START_CHAT_MEDIA_EXPORT'/);
  assert.match(controller, /mark: MARK/);
  assert.match(content, /event\.data\?\.mark !== MARK/);
  assert.match(content, /\[TG Downloader\]\[advanced-submit\] content-received/);
});
