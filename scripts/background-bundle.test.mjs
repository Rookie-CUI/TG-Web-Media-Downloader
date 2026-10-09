import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const initialUrl = 'https://web.telegram.org/file/private-token?auth=private-query';
const finalUrl = 'https://media.telegram-cdn.org/range/private-token?auth=private-query';
const externalUrl = 'https://outside.example/private-token';
const forbiddenRuleIds = [24041001, 24041002, 24041003];

function dnrAction(url, rules) {
  const parsed = new URL(url);
  const matching = rules.filter((rule) => {
    const condition = rule.condition;
    if (!condition.initiatorDomains?.includes(extensionId) || !condition.tabIds?.includes(-1)) return false;
    if (!condition.resourceTypes?.includes('xmlhttprequest') || !condition.requestMethods?.includes('get')) return false;
    if (condition.urlFilter === '|http://' && parsed.protocol !== 'http:') return false;
    if (condition.urlFilter === '|https://' && parsed.protocol !== 'https:') return false;
    if (condition.requestDomains && !condition.requestDomains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) return false;
    return true;
  }).sort((left, right) => right.priority - left.priority);
  return matching[0]?.action.type || 'no-match';
}

function mockResponse({ status, url, redirected, contentType = 'video/mp4', bytes = [1, 2, 3, 4] }) {
  let bodyRead = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    redirected,
    headers: {
      get(name) {
        const values = {
          'content-type': contentType,
          'content-length': String(bytes.length),
          'content-range': status === 206 ? `bytes 0-${bytes.length - 1}/${bytes.length}` : '',
          'accept-ranges': 'bytes',
        };
        return values[name.toLowerCase()] || null;
      },
    },
    async arrayBuffer() {
      bodyRead = true;
      return Uint8Array.from(bytes).buffer;
    },
    bodyWasRead() { return bodyRead; },
  };
}

test('built service worker Range transport follows an allowlisted 302 and rejects unsafe/non-media finals', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalConsole = globalThis.console;
  let listener;
  let scenario = 'allowed-redirect';
  let lastResponse;
  const logs = [];
  const sessionRules = [];
  const fetchCalls = [];
  const followedRequests = [];

  globalThis.console = {
    ...originalConsole,
    info: (...args) => logs.push(args),
    error: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
  };
  globalThis.chrome = {
    runtime: {
      id: extensionId,
      onMessage: { addListener(callback) { listener = callback; } },
      onInstalled: { addListener() {} },
    },
    tabs: {
      TAB_ID_NONE: -1,
      onRemoved: { addListener() {} },
      query: async () => [],
      sendMessage: async () => ({}),
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    declarativeNetRequest: {
      ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' },
      RequestMethod: { GET: 'get' },
      RuleActionType: { BLOCK: 'block', ALLOW: 'allow' },
      getSessionRules: async () => [...sessionRules],
      updateSessionRules: async ({ removeRuleIds, addRules }) => {
        for (let i = sessionRules.length - 1; i >= 0; i--) {
          if (removeRuleIds.includes(sessionRules[i].id)) sessionRules.splice(i, 1);
        }
        sessionRules.push(...addRules);
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    assert.equal(init.redirect, 'follow');
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.Range, 'bytes=0-3');
    assert.equal(dnrAction(initialUrl, sessionRules), 'allow');

    if (scenario === 'allowed-redirect') {
      // Model Chromium's redirect-following fetch: it checks each destination
      // before issuing it, while the service worker sees only the final response.
      const chain = [
        { status: 302, location: finalUrl },
        { status: 206, url: finalUrl },
      ];
      let currentUrl = initialUrl;
      for (const hop of chain) {
        assert.equal(dnrAction(currentUrl, sessionRules), 'allow');
        followedRequests.push({ url: currentUrl, range: init.headers.Range, credentials: init.credentials });
        if (hop.status >= 300 && hop.status < 400) {
          currentUrl = new URL(hop.location, currentUrl).href;
          continue;
        }
        lastResponse = mockResponse({ status: hop.status, url: hop.url, redirected: true });
      }
      return lastResponse;
    }
    if (scenario === 'external-redirect') {
      followedRequests.push({ url: initialUrl, range: init.headers.Range, credentials: init.credentials });
      const redirectHop = { status: 302, location: externalUrl };
      const blockedTarget = new URL(redirectHop.location, initialUrl).href;
      assert.equal(dnrAction(blockedTarget, sessionRules), 'block');
      throw new TypeError('Failed to fetch');
    }
    if (scenario === 'html-final') {
      lastResponse = mockResponse({ status: 200, url: finalUrl, redirected: true, contentType: 'text/html; charset=utf-8' });
      return lastResponse;
    }
    lastResponse = mockResponse({ status: 201, url: finalUrl, redirected: true, contentType: 'application/octet-stream' });
    return lastResponse;
  };

  try {
    const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
    const manifest = JSON.parse(await readFile(path.join(distRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.background.service_worker, 'assets/background.js');
    assert.ok(manifest.permissions.includes('declarativeNetRequest'));
    const distPath = path.join(distRoot, 'assets/background.js');
    await import(`${pathToFileURL(path.resolve(distPath)).href}?range-test=${Date.now()}`);
    assert.equal(typeof listener, 'function', 'the built service worker registered the runtime message handler');

    async function sendRange(requestId) {
      return new Promise((resolve) => {
        const keepAlive = listener({
          type: 'FETCH_MEDIA_RANGE', requestId, url: initialUrl, start: 0, end: 3,
        }, {}, resolve);
        assert.equal(keepAlive, true);
      });
    }

    const success = await sendRange('bundle-range-ok');
    assert.equal(success.ok, true);
    assert.equal(success.status, 206);
    assert.equal(success.redirected, true);
    assert.equal(success.transport, 'background-range');
    assert.equal(success.initialHost, 'web.telegram.org');
    assert.equal(success.finalHost, 'media.telegram-cdn.org');
    assert.equal(success.finalStatus, 206);
    assert.equal(success.contentType, 'video/mp4');
    assert.equal(Buffer.from(success.bytes, 'base64').length, 4);
    assert.deepEqual(fetchCalls[0].init.headers, { Range: 'bytes=0-3' });
    assert.deepEqual(followedRequests, [
      { url: initialUrl, range: 'bytes=0-3', credentials: 'include' },
      { url: finalUrl, range: 'bytes=0-3', credentials: 'include' },
    ]);

    assert.deepEqual(sessionRules.map(({ id }) => id).sort(), [...forbiddenRuleIds].sort());
    assert.equal(dnrAction('http://media.telegram-cdn.org/file', sessionRules), 'block');
    assert.equal(dnrAction('https://outside.example/file', sessionRules), 'block');

    scenario = 'external-redirect';
    const external = await sendRange('bundle-range-external');
    assert.equal(external.ok, false);
    assert.equal(fetchCalls.length, 2, 'the blocked external redirect target was not issued as another request');
    assert.equal(followedRequests.some(({ url }) => url === externalUrl), false);

    scenario = 'html-final';
    const html = await sendRange('bundle-range-html');
    assert.equal(html.ok, false);
    assert.equal(html.code, 'NON_MEDIA_RESPONSE');
    assert.equal(lastResponse.bodyWasRead(), false, 'HTML is rejected before its body is read as media');

    scenario = 'invalid-status';
    const invalid = await sendRange('bundle-range-invalid-status');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'MEDIA_HTTP_STATUS_INVALID');
    assert.equal(lastResponse.bodyWasRead(), false, 'only HTTP 200 and 206 bodies are accepted');

    const logText = JSON.stringify(logs);
    for (const field of ['transport', 'initialHost', 'redirected', 'finalHost', 'finalStatus', 'contentType']) {
      assert.ok(logText.includes(field), `built service worker logs ${field}`);
    }
    for (const secret of ['private-token', 'private-query', 'outside.example/private-token']) {
      assert.equal(logText.includes(secret), false, `logs do not expose ${secret}`);
    }
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.console = originalConsole;
  }
});
