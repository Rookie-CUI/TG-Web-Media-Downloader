import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'dist');

async function readDist(relativePath) {
  return readFile(path.join(dist, relativePath), 'utf8');
}

test('built K single-video path includes container validation, bounded Range queue and binary bridge', async () => {
  const content = await readDist('assets/content.js');
  const bridge = await readDist('page-bridge.js');
  for (const marker of ['MEDIA_CONTAINER_NOT_STANDALONE', 'FRAGMENT_MISSING_INITIALIZATION',
    'INCOMPLETE_RANGE_FILE', 'CONTENT_RANGE_TOTAL_CHANGED', 'K_VIEWER_STREAM_NOT_STANDALONE',
    'detectedContainer', 'standalonePlayable', 'candidateDiscoveryMs', 'downloaderStartMs']) {
    assert.ok(content.includes(marker), `actual content bundle missing ${marker}`);
  }
  assert.match(content, /concurrency:4/);
  assert.match(content, /kSingleVideo/);
  assert.match(bridge, /responseEncoding\s*===\s*['"]arraybuffer['"]/);
  assert.match(bridge, /PAGE_RESPONSE_TOO_LARGE/);
});

function findNodeGlobals(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const forbidden = new Set(['process', 'Buffer', 'require', 'module', '__dirname', '__filename']);
  const references = [];

  function isPropertyOrBindingName(node) {
    const parent = node.parent;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isMethodSignature(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
        (ts.isBindingElement(parent) && parent.name === node)) return true;
    return false;
  }

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === 'global' && node.name.text === 'process') {
      references.push({ name: 'global.process', line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    if (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === 'global' &&
        node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'process') {
      references.push({ name: "global['process']", line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    if (ts.isIdentifier(node) && forbidden.has(node.text) && !isPropertyOrBindingName(node)) {
      references.push({ name: node.text, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  return references;
}

function findFunctionDeclarationTexts(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) found.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

test('MV3 content-script bundles contain no Node-only runtime globals', async () => {
  const manifest = JSON.parse(await readDist('manifest.json'));
  const contentScripts = manifest.content_scripts.flatMap((entry) => entry.js || []);
  assert.ok(contentScripts.includes('assets/content.js'), 'manifest must load the isolated-world content bundle');

  for (const relativePath of new Set(contentScripts)) {
    const source = await readDist(relativePath);
    assert.deepEqual(findNodeGlobals(source, relativePath), [], `${relativePath} contains a free Node-only global reference`);
  }

  const content = await readDist('assets/content.js');
  assert.doesNotMatch(content, /\bimport\s*\(/, 'content bundle must inline its dynamic imports for classic MV3 injection');
  assert.doesNotMatch(content, /\bprocess\.env\b/);
});

test('built manifest installs MAIN page bridge at document_start before isolated content script', async () => {
  const manifest = JSON.parse(await readDist('manifest.json'));
  assert.equal(manifest.content_scripts.length, 2);
  const [bridge, content] = manifest.content_scripts;
  assert.deepEqual(bridge.js, ['page-bridge.js']);
  assert.equal(bridge.run_at, 'document_start');
  assert.equal(bridge.world, 'MAIN');
  assert.deepEqual(content.js, ['assets/content.js']);
  assert.equal(content.run_at, 'document_end');
  assert.equal(content.world, 'ISOLATED');
  assert.ok(await readDist('page-bridge.js'));
});

test('built content script starts without Node globals and installs page observers', async () => {
  const source = await readDist('assets/content.js');
  const initialized = [];
  const observed = [];
  let nextTimerId = 1;

  class FakeElement {
    constructor(name = 'element') {
      this.name = name;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.classList = { contains: () => false, add() {}, remove() {} };
    }
    append(child) { this.children.push(child); }
    appendChild(child) { this.children.push(child); return child; }
    insertBefore(child) { this.children.unshift(child); return child; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getAttribute() { return null; }
    setAttribute() {}
    removeAttribute() {}
    addEventListener() {}
    getBoundingClientRect() { return { width: 0, height: 0 }; }
    closest() { return null; }
  }

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { observed.push({ target, options }); }
    disconnect() {}
  }

  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  const head = new FakeElement('head');
  const document = {
    body,
    documentElement,
    head,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement(name) { return new FakeElement(name); },
  };

  const window = {
    document,
    location: { href: 'https://web.telegram.org/k/', hash: '' },
    addEventListener() {},
    postMessage() {},
    setTimeout() { return nextTimerId++; },
    clearTimeout() {},
    setInterval() { return nextTimerId++; },
    clearInterval() {},
  };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener() {} },
    },
  };
  const context = vm.createContext({
    window,
    document,
    chrome,
    location: window.location,
    MutationObserver: FakeMutationObserver,
    Element: FakeElement,
    console: {
      info: (...args) => initialized.push(args),
      warn() {},
      error() {},
      log() {},
    },
    crypto: { randomUUID: () => 'vm-test-id' },
    structuredClone,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });

  assert.equal(typeof context.process, 'undefined');
  assert.equal(typeof context.global, 'undefined');
  assert.equal(typeof context.Buffer, 'undefined');
  assert.equal(typeof context.require, 'undefined');

  assert.doesNotThrow(() => vm.runInContext(source, context, { timeout: 3000 }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(initialized.some(([message]) => message === '[TG Downloader][init]'), 'content script reached its init log');
  assert.ok(observed.length >= 2, 'content script installed toolbar and media MutationObservers');
  assert.ok(observed.some(({ target }) => target === body), 'media observer watches the page body');
});

test('built content bundle rejects trustedMediaElement-only sources and keeps polling past weak candidates', async () => {
  const source = await readDist('assets/content.js');
  assert.match(source, /PREFLIGHT_K_VIEWER_MEDIA_SOURCE/);
  assert.match(source, /K_VIEWER_HTTP_PREFLIGHT_RESPONSE/);
  assert.match(source, /HTTP_REDIRECT_NOT_FOLLOWED/);
  const declarations = findFunctionDeclarationTexts(source, 'dist/assets/content.js');
  const mediaEvidence = declarations.find((body) => body.includes('progressive|stream|download') && body.includes('video|audio'));
  const waitFunction = declarations.find((body) => body.includes('weakCandidateCount') && body.includes('rejectedCandidates'));
  const preflightClassifier = declarations.find((body) => body.includes('FINAL_MEDIA_TYPE_UNVERIFIED') && body.includes('INVALID_CONTENT_RANGE'));
  assert.ok(mediaEvidence, 'built bundle must contain the strong media evidence classifier');
  assert.ok(waitFunction, 'built bundle must contain the K Viewer polling loop');
  assert.ok(preflightClassifier, 'built bundle must contain the HTTP preflight response classifier');
  assert.doesNotMatch(mediaEvidence, /trustedMediaElement/,
    'a trusted media element alone must not qualify as strong media evidence');
  assert.match(waitFunction, /rejectedCandidates/);
  assert.match(waitFunction, /await\s+\w+\(\w+\)/,
    'the built loop must await each candidate preflight');
  assert.match(waitFunction, /K_VIEWER_STREAM_NOT_STANDALONE/,
    'the built source loop rejects unverified stream fragments');
  assert.match(waitFunction, /if\(\w+\)return\{\.\.\.\w+,candidate:/,
    'the built loop returns only after it has selected a candidate from the verified set');
  assert.doesNotMatch(source, /trustedMediaElement===!0&&/,
    'the old trustedMediaElement-only HTTP acceptance branch must be absent from dist');
  assert.match(source, /preflightVerified===!0/,
    'the built resolver requires a preflight-verified candidate before creating an HTTP source');
  assert.match(source, /requiresPageTransport/,
    'the built Downloader preserves page transport for verified K Viewer sources');
  const builtUrlClassifier = declarations.find((body) => body.includes('includes("/progressive/")') && body.includes('includes("/stream/")'));
  const builtPageTransportClassifier = declarations.find((body) => /\w+==="progressive"/.test(body) && /\w+==="download"/.test(body));
  assert.ok(builtUrlClassifier?.includes('includes("/download/")'),
    'the built Downloader URL classifier recognizes /download/');
  assert.ok(builtPageTransportClassifier,
    'the built Downloader routes /download/ through page transport');
  assert.match(source, /requestTransport=\w+\(\w+\.media\.url,\w+\.media\.requiresPageTransport\)/,
    'verified K Viewer candidates retain page transport even after redirect to an opaque path');

  const pageBridge = await readDist('page-bridge.js');
  assert.match(pageBridge, /PREFLIGHT_K_VIEWER_MEDIA_SOURCE/);
  assert.match(pageBridge, /Range:\s*['"]bytes=0-0['"]/);
  assert.match(pageBridge, /redirect:\s*['"]follow['"]/);
});
