import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

async function loadStandalone(path, dependencies = {}) {
  const source = await read(path);
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const module = { exports: {} };
  const require = (name) => {
    if (dependencies[name]) return dependencies[name];
    throw new Error(`Unexpected import ${name}`);
  };
  const context = vm.createContext({ module, exports: module.exports, require, URL });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return module.exports;
}

test('formatError handles Error, DOMException, strings, plain objects and Chrome responses', async () => {
  const { formatError } = await loadStandalone('../src/utils/errors.ts');
  const standard = formatError(new Error('network failed'));
  assert.equal(standard.name, 'Error');
  assert.equal(standard.message, 'network failed');
  assert.ok(standard.stack);
  const abort = formatError(new DOMException('cancelled', 'AbortError'));
  assert.equal(abort.name, 'AbortError');
  assert.equal(abort.message, 'cancelled');
  assert.doesNotMatch(JSON.stringify(abort), /\[object DOMException\]/);
  const abortWithReason = formatError(Object.assign(new DOMException('The operation was aborted', 'AbortError'), { reason: 'Viewer closed unexpectedly' }));
  assert.equal(abortWithReason.name, 'AbortError');
  assert.equal(abortWithReason.reason, 'Viewer closed unexpectedly');
  assert.doesNotMatch(JSON.stringify(abortWithReason), /\[object DOMException\]/);
  assert.equal(formatError('offline').message, 'offline');

  const response = formatError({ ok: false, status: 403, error: { message: 'media request denied' }, requestId: 'req-1' });
  assert.equal(response.message, 'media request denied');
  assert.equal(response.status, 403);
  assert.equal(response.requestId, 'req-1');
  assert.doesNotMatch(JSON.stringify(response), /\[object Object\]/);

  const generic = formatError({ code: 'E_UNKNOWN', status: 0 });
  assert.match(generic.message, /未提供错误消息的对象/);
  assert.doesNotMatch(generic.message, /\[object Object\]/);
});

test('Range failure responses always serialize error as a string with numeric status', async () => {
  const errorModule = await loadStandalone('../src/utils/errors.ts');
  const { rangeFailureResponse } = await loadStandalone('../src/background/range-response.ts', {
    '../utils/errors': errorModule,
  });
  const response = rangeFailureResponse({ error: { message: 'HTTP denied' }, status: 403 }, 'range-1');
  assert.equal(response.ok, false);
  assert.equal(response.status, 403);
  assert.equal(response.error, 'HTTP denied');
  assert.equal(response.requestId, 'range-1');
  assert.equal(typeof response.error, 'string');

  const invalid = rangeFailureResponse({ code: 'E_RANGE' }, 'range-2');
  assert.equal(invalid.status, 0);
  assert.equal(typeof invalid.error, 'string');
  assert.doesNotMatch(invalid.error, /\[object Object\]/);
});

test('error messages redact URL paths and query parameters', async () => {
  const { formatError } = await loadStandalone('../src/utils/errors.ts');
  const details = formatError(new Error('request failed https://web.telegram.org/file?token=secret&access_hash=private'));
  assert.doesNotMatch(details.message, /secret|access_hash|private/);
  assert.match(details.message, /web\.telegram\.org/);
});

test('错误诊断是单一字符串且包含错误名称、消息、代码和请求 ID', async () => {
  const { formatErrorLog } = await loadStandalone('../src/utils/errors.ts');
  const line = formatErrorLog('[TG Downloader][blob] failed', Object.assign(new Error('read failed'), { code: 'BLOB_READ_FAILED', requestId: 'req-7' }), { stage: 'metadata' });
  assert.equal(typeof line, 'string');
  assert.match(line, /name=Error/);
  assert.match(line, /message=read failed/);
  assert.match(line, /code=BLOB_READ_FAILED/);
  assert.match(line, /requestId=req-7/);
  assert.doesNotMatch(line, /\[object Object\]/);
});

