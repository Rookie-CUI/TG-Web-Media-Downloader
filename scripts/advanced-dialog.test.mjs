import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

async function loadController(options = {}) {
  const source = await read('../src/telegram/advanced-download-dialog.ts');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const logs = [];
  const listeners = new Map();
  const shadowElements = new Map();
  const created = [];
  const messages = [];
  let currentRender;
  let currentRoot;
  let host;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.isConnected = true;
      this.dataset = {};
      this.style = {};
      this.children = [];
      this.className = '';
    }
    append(element) {
      this.children.push(element);
      if (element.id) shadowElements.set(element.id, element);
      if (element.className === 'tg-export-dialog-overlay') shadowElements.set('.tg-export-dialog-overlay', element);
    }
    replaceChildren() { this.children = []; }
    attachShadow() { this.shadowRoot = currentRoot; return currentRoot; }
    getElementById(id) { return shadowElements.get(id) || null; }
    querySelector(selector) { return shadowElements.get(selector) || null; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 800, height: 600 }; }
  }

  const documentElement = new FakeElement('html');
  documentElement.append = (element) => { host = element; };
  const document = {
    documentElement,
    getElementById(id) { return id === 'tg-downloader-shadow-host' ? host || null : null; },
    createElement(tagName) { const element = new FakeElement(tagName); created.push(element); return element; },
  };
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { messages.push(message); },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, delay) {
      options.waits?.push(delay);
      if (options.afterAnimationWait) options.afterAnimationWait();
      callback();
      return 1;
    },
  };
  let opacityReads = 0;
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    window,
    document,
    crypto: { randomUUID: () => 'protocol-message-1' },
    structuredClone,
    console: {
      info: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
    getComputedStyle: () => {
      opacityReads += 1;
      const opacity = options.opacity ? options.opacity(opacityReads) : '1';
      return { display: 'flex', position: 'fixed', visibility: 'visible', opacity, animationName: options.animationName || 'none', pointerEvents: 'auto', zIndex: '2147483646' };
    },
  });

  const require = (name) => {
    if (name === 'vue') return {
      reactive: (value) => value,
      h: (component, props) => ({ component, props }),
      nextTick: async () => {},
      createApp(options) {
        currentRender = options.render;
        return {
          mount(target) {
            assert.equal(target.id, 'app');
            const overlay = new FakeElement('div');
            overlay.className = 'tg-export-dialog-overlay';
            currentRoot.append(overlay);
          },
          unmount() {},
        };
      },
    };
    if (name.endsWith('AdvancedDownloadDialog.vue')) return { default: {} };
    if (name.endsWith('advanced-download-dialog.css?inline')) return { default: '.tg-export-dialog-overlay{}' };
    if (name.endsWith('/utils/errors')) return { formatErrorLog: (prefix, error, context = {}) => `${prefix}: name=${error?.name || 'Error'} message=${error?.message || 'unknown'} ${Object.entries(context).map(([key, value]) => `${key}=${value}`).join(' ')}` };
    if (name.endsWith('/utils/structured-clone')) return { cloneStructuredMessage: (value) => structuredClone(value) };
    throw new Error(`Unexpected import ${name}`);
  };
  context.require = require;
  currentRoot = {
    append(element) {
      if (element.id) shadowElements.set(element.id, element);
      if (element.className === 'tg-export-dialog-overlay') shadowElements.set('.tg-export-dialog-overlay', element);
    },
    querySelector(selector) { return shadowElements.get(selector) || null; },
    getElementById(id) { return shadowElements.get(id) || null; },
  };
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return { api: module.exports, logs, listeners, created, messages, getRendered: () => currentRender(), getWindow: () => window };
}

const media = {
  stableKey: 'K:peer-1:message-1:video:0',
  version: 'K',
  kind: 'video',
  messageId: 'message-1',
  peerId: 'peer-1',
  monthGroup: '2026-10',
  dateTimestamp: 1790812800000,
  duration: '0:12',
  thumbnail: 'blob:https://web.telegram.org/thumb',
  sidebarKey: 'K:peer-1:message-1',
  mediaIndex: 0,
};

test('Advanced Download 按 OPEN → UPDATE 协议在 controller/Vue 安装后显示', async () => {
  const { api, logs, listeners, getRendered } = await loadController();
  assert.equal(listeners.size, 0, '内容脚本通过 controller 直达 Shadow DOM，没有向 window 重复广播');

  await api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] });
  const vnode = getRendered();
  assert.equal(vnode.props.modelValue, true);
  assert.equal(vnode.props.chatId, 'peer-1');
  assert.deepEqual(Array.from(vnode.props.mediaList, (item) => item.stableKey), [media.stableKey]);
  assert.equal('url' in vnode.props.mediaList[0], false, 'scan identity has no canonical download URL');
  for (const marker of ['controller dispatch', 'host created', 'vue mounted', 'show', 'visible']) {
    assert.ok(logs.some(([message]) => String(message).includes(`[TG Downloader][advanced] ${marker}`)), `missing diagnostic ${marker}`);
  }
});

test('TG_UPDATE_MEDIA_EXPORT_LIST 通过 controller 直达 Shadow DOM 更新媒体列表', async () => {
  const { api, getRendered, messages } = await loadController();
  await api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] });
  api.dispatchAdvancedDialogMessage({ mark: '__TG_PERSONAL_MEDIA_V1__', type: 'TG_UPDATE_MEDIA_EXPORT_LIST', chatId: 'peer-1', mediaList: [], mediaListLoading: false });
  assert.equal(getRendered().props.modelValue, true);
  assert.deepEqual(Array.from(getRendered().props.mediaList), []);
  assert.equal(messages.length, 0);
});

test('点击高级下载只发送 plain selectedKeys，并为唯一消息生成去重 ID', async () => {
  const { api, messages, getRendered } = await loadController();
  await api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] });
  const selection = { mediaTypes: ['video'], skipDownloaded: false, selectedKeys: [media.stableKey] };
  getRendered().props.onStartExport(selection);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'TG_START_CHAT_MEDIA_EXPORT');
  assert.equal(messages[0].mark, '__TG_PERSONAL_MEDIA_V1__');
  assert.equal(messages[0].messageId, 'protocol-message-1');
  assert.deepEqual(Array.from(messages[0].options.selectedKeys), selection.selectedKeys);
  assert.equal('filteredItems' in messages[0].options, false);
  assert.equal('url' in messages[0].options, false);
  assert.deepEqual(Array.from(messages[0].options.mediaTypes), ['video']);
});

test('点击加载完整历史会保存选择状态、关闭弹窗并发送 stable identities', async () => {
  const { api, messages, getRendered } = await loadController();
  await api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] });
  getRendered().props.onRequestFullScan({ selectedKeys: [media.stableKey], mediaTypes: ['video'], skipDownloaded: true });
  assert.equal(getRendered().props.modelValue, false);
  assert.equal(messages.at(-1).type, 'TG_LOAD_ALL_MEDIA_REQUEST');
  assert.deepEqual(Array.from(messages.at(-1).request.selectedKeys), [media.stableKey]);
  assert.deepEqual(Array.from(messages.at(-1).request.mediaTypes), ['video']);
  assert.equal(messages.at(-1).request.skipDownloaded, true);
});

test('入场动画首帧 opacity=0 会等待动画结束后再判定可见', async () => {
  const waits = [];
  let animationFinished = false;
  const { api, logs } = await loadController({
    waits,
    animationName: 'tg-export-fade-in',
    opacity: () => animationFinished ? '1' : '0',
    afterAnimationWait: () => { animationFinished = true; },
  });
  await api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] });
  assert.deepEqual(waits, [260]);
  assert.ok(logs.some(([message]) => String(message).includes('[TG Downloader][advanced] visible')));
});

test('等待后弹窗仍隐藏时才报告未显示', async () => {
  const waits = [];
  const { api } = await loadController({ waits, animationName: 'tg-export-fade-in', opacity: () => '0' });
  await assert.rejects(api.openAdvancedDownloadDialog({ chatId: 'peer-1', chatTitle: 'Test chat', mediaList: [media] }), /弹窗根节点未显示/);
  assert.deepEqual(waits, [260]);
});

