import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

async function loadModule(path) {
  const source = await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, structuredClone, WeakSet, Promise, Error, TypeError, Object, Array, globalThis: { Node: undefined } });
  vm.runInContext(`(function(exports, module) { ${compiled}\n})(exports, module);`, context);
  return module.exports;
}

test('Vue Proxy 不能跨消息边界，错误包含具体字段路径', async () => {
  const { cloneStructuredMessage } = await loadModule('../src/utils/structured-clone.ts');
  const reactiveMediaItem = new Proxy({ messageId: 'mid-1', url: 'blob:https://web.telegram.org/video' }, {});
  assert.throws(
    () => cloneStructuredMessage({ options: { filteredItems: [reactiveMediaItem] } }),
    /\$\.options\.filteredItems\[0\]/,
  );
});

test('新选择协议仅含 primitive key，可克隆且返回独立 plain payload', async () => {
  const { cloneStructuredMessage } = await loadModule('../src/utils/structured-clone.ts');
  const payload = {
    mark: '__TG_PERSONAL_MEDIA_V1__',
    messageId: 'request-1',
    options: {
      mediaTypes: ['image', 'video'], visibleOnly: true, loadAllMedia: false, skipDownloaded: false,
      selectedKeys: [{ messageId: 'mid-1', url: 'blob:https://web.telegram.org/video' }],
    },
  };
  const clone = cloneStructuredMessage(payload);
  assert.deepEqual(clone, payload);
  assert.notEqual(clone, payload);
  assert.notEqual(clone.options, payload.options);
});

test('同一个 Advanced Submit messageId 最多处理一次', async () => {
  const { MessageDeduplicator } = await loadModule('../src/utils/message-deduplicator.ts');
  const dedupe = new MessageDeduplicator(2);
  assert.equal(dedupe.accept('request-1'), true);
  assert.equal(dedupe.accept('request-1'), false);
  assert.equal(dedupe.accept('request-2'), true);
  assert.equal(dedupe.accept('request-3'), true);
  assert.equal(dedupe.accept('request-1'), true, '超出容量后仅淘汰最旧 ID');
});
