import { getHistory, getPageMedia, savePageMedia, saveTask } from '../storage/local';
import type { DownloadTask, MediaItem } from '../types';
import { formatError, formatErrorLog } from '../utils/errors';
import { cloneStructuredMessage } from '../utils/structured-clone';
import { rangeFailureResponse } from './range-response';

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function isAllowedTelegramHost(host: string): boolean {
  const value = host.toLowerCase();
  return value === 'telegram.org' || value.endsWith('.telegram.org') ||
    value === 'telegram-cdn.org' || value.endsWith('.telegram-cdn.org') ||
    value === 't.me' || value.endsWith('.t.me');
}

const rangeRequests = new Map<string, AbortController>();
const RANGE_REDIRECT_RULE_IDS = [24041001, 24041002, 24041003];
let rangeRedirectGuard: Promise<void> | undefined;

function ensureRangeRedirectGuard(): Promise<void> {
  if (!rangeRedirectGuard) {
    rangeRedirectGuard = (async () => {
      const dnr = chrome.declarativeNetRequest;
      if (!dnr || !chrome.runtime.id) throw Object.assign(new Error('Telegram Range 重定向安全规则不可用'), { code: 'TELEGRAM_REDIRECT_GUARD_UNAVAILABLE', retryable: false });

      const requestScope: chrome.declarativeNetRequest.RuleCondition = {
        initiatorDomains: [chrome.runtime.id.toLowerCase()],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        requestMethods: [chrome.declarativeNetRequest.RequestMethod.GET],
      };
      const rules: chrome.declarativeNetRequest.Rule[] = [
        {
          id: RANGE_REDIRECT_RULE_IDS[0],
          priority: 100,
          action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
          condition: { ...requestScope, urlFilter: '|http://' },
        },
        {
          id: RANGE_REDIRECT_RULE_IDS[1],
          priority: 2,
          action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
          condition: { ...requestScope, urlFilter: '|https://', requestDomains: ['telegram.org', 'telegram-cdn.org', 't.me'] },
        },
        {
          id: RANGE_REDIRECT_RULE_IDS[2],
          priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
          condition: { ...requestScope, urlFilter: '|https://' },
        },
      ];
      const existing = await dnr.getSessionRules();
      const removeRuleIds = existing.filter(({ id }) => RANGE_REDIRECT_RULE_IDS.includes(id)).map(({ id }) => id);
      await dnr.updateSessionRules({ removeRuleIds, addRules: rules });
    })().catch((error) => {
      rangeRedirectGuard = undefined;
      throw error;
    });
  }
  return rangeRedirectGuard;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message.type === 'CANCEL_MEDIA_RANGE') {
      const requestId = String(message.requestId ?? '');
      rangeRequests.get(requestId)?.abort();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'FETCH_MEDIA_RANGE') {
      const start = Number(message.start);
      const end = Number(message.end);
      const requestId = String(message.requestId ?? '');
      let url: URL | undefined;
      let controller: AbortController | undefined;
      let status = 0;
      try {
        url = new URL(String(message.url ?? ''));
        const host = url.hostname.toLowerCase();
        const allowedHost = host === 'web.telegram.org' || isAllowedTelegramHost(host);
        if (url.protocol !== 'https:' || !allowedHost || !requestId || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
          const failure = rangeFailureResponse(new Error('无效或非 Telegram 媒体 Range 请求'), requestId);
          console.error(formatErrorLog('[TG Downloader][range] failed', failure, {
            transport: 'background-range', urlType: 'http', initialHost: url.hostname.toLowerCase(),
            redirected: false, finalHost: '', finalStatus: 0, contentType: '', start, end, ok: false, retryCount: 0,
          }));
          sendResponse(failure);
          return;
        }
        controller = new AbortController();
        rangeRequests.set(requestId, controller);
        const requestInfo = { transport: 'background-range', urlType: 'http', initialHost: url.hostname.toLowerCase(), requestId, start, end, retryCount: 0 };
        console.info('[TG Downloader][range] request', requestInfo);
        await ensureRangeRedirectGuard();
        const response = await fetch(url.href, { credentials: 'include', redirect: 'follow', headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
        status = response.status;
        const finalUrl = response.url || (response.redirected ? '' : url.href);
        let finalAllowed = false;
        let finalHost = '';
        try {
          const final = new URL(finalUrl);
          finalHost = final.hostname.toLowerCase();
          finalAllowed = final.protocol === 'https:' && (finalHost === 'web.telegram.org' || isAllowedTelegramHost(finalHost));
        } catch { finalAllowed = false; }
        const contentType = response.headers.get('Content-Type') || '';
        const isHtml = contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html';
        const responseHeaders = {
          ...requestInfo,
          finalStatus: response.status,
          ok: response.ok,
          redirected: response.redirected,
          finalHost,
          contentType,
          contentLength: response.headers.get('Content-Length') || '',
          contentRange: response.headers.get('Content-Range') || '',
          acceptRanges: response.headers.get('Accept-Ranges') || '',
        };
        console.info('[TG Downloader][range] response headers', responseHeaders);
        if (!finalAllowed) {
          const failure = rangeFailureResponse(Object.assign(new Error('Telegram 媒体重定向目标不在允许域名内'), { code: 'TELEGRAM_REDIRECT_NOT_ALLOWED' }), requestId, response.status);
          sendResponse({ ...failure, retryable: false, finalUrl, transport: requestInfo.transport, initialHost: requestInfo.initialHost, redirected: response.redirected, finalHost, finalStatus: response.status, contentType, returnedBytes: 0 });
          return;
        }
        if (response.status >= 300 && response.status < 400) {
          const failure = rangeFailureResponse(Object.assign(new Error(`Telegram 重定向未被 fetch 跟随：HTTP ${response.status}`), { code: 'HTTP_REDIRECT_NOT_FOLLOWED' }), requestId, response.status);
          sendResponse({ ...failure, retryable: false, finalUrl, transport: requestInfo.transport, initialHost: requestInfo.initialHost, redirected: response.redirected, finalHost, finalStatus: response.status, contentType, returnedBytes: 0 });
          return;
        }
        if (isHtml) {
          const failure = rangeFailureResponse(Object.assign(new Error('媒体 Range 请求返回 text/html 页面，而不是媒体数据'), { code: 'NON_MEDIA_RESPONSE' }), requestId, response.status);
          sendResponse({ ...failure, retryable: false, finalUrl, transport: requestInfo.transport, initialHost: requestInfo.initialHost, redirected: response.redirected, finalHost, finalStatus: response.status, contentType, returnedBytes: 0 });
          return;
        }
        if (response.status !== 200 && response.status !== 206) {
          const failure = rangeFailureResponse(Object.assign(new Error(`媒体 Range 请求返回不支持的 HTTP 状态：${response.status}`), { code: 'MEDIA_HTTP_STATUS_INVALID' }), requestId, response.status);
          sendResponse({ ...failure, retryable: false, finalUrl, transport: requestInfo.transport, initialHost: requestInfo.initialHost, redirected: response.redirected, finalHost, finalStatus: response.status, contentType, returnedBytes: 0 });
          return;
        }
        const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
        const responseInfo = {
          ...requestInfo,
          finalStatus: response.status,
          ok: response.ok,
          redirected: response.redirected,
          finalHost,
          contentType,
          contentLength: response.headers.get('Content-Length') || '',
          contentRange: response.headers.get('Content-Range') || '',
          acceptRanges: response.headers.get('Accept-Ranges') || '',
          returnedBytes: bytes.byteLength,
        };
        console.info('[TG Downloader][range] response', responseInfo);
        if (!response.ok) {
          sendResponse({
            ...rangeFailureResponse(new Error(`媒体请求失败：HTTP ${response.status}`), requestId, response.status),
            contentType: responseInfo.contentType,
            contentLength: responseInfo.contentLength,
            contentRange: responseInfo.contentRange,
            acceptRanges: responseInfo.acceptRanges,
            returnedBytes: responseInfo.returnedBytes,
            finalUrl,
            transport: requestInfo.transport,
            initialHost: requestInfo.initialHost,
            redirected: response.redirected,
            finalHost,
            finalStatus: response.status,
            retryable: response.status >= 300 && response.status < 400 ? false : undefined,
          });
          return;
        }
        sendResponse({
          ok: true,
          status: response.status,
          contentType: responseInfo.contentType,
          contentLength: responseInfo.contentLength,
          contentRange: responseInfo.contentRange,
          acceptRanges: responseInfo.acceptRanges,
          finalUrl,
          transport: requestInfo.transport,
          initialHost: requestInfo.initialHost,
          redirected: response.redirected,
          finalHost,
          finalStatus: response.status,
          bytes: encodeBase64(bytes),
          returnedBytes: bytes.byteLength,
          requestId,
        });
      } catch (error) {
        const details = formatError(error);
        console.error(formatErrorLog('[TG Downloader][range] failed', error, {
          transport: 'background-range',
          urlType: 'http',
          initialHost: url?.hostname.toLowerCase() || 'unknown',
          redirected: 'unknown',
          finalHost: '',
          finalStatus: status || details.status || 0,
          requestId,
          start,
          end,
          ok: false,
          contentType: '',
          contentLength: '',
          contentRange: '',
          acceptRanges: '',
          returnedBytes: 0,
          retryCount: 0,
          error: details.message,
          code: details.code,
          stack: details.stack,
        }));
        sendResponse(rangeFailureResponse(error, requestId, status || undefined));
      } finally {
        if (controller && rangeRequests.get(requestId) === controller) rangeRequests.delete(requestId);
      }
      return;
    }
    if (message.type === 'GET_STATE') {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : await activeTabId();
      sendResponse({ media: tabId === undefined ? [] : await getPageMedia(tabId), tasks: await getHistory() });
      return;
    }
    if (message.type === 'MEDIA_DISCOVERED' && sender.tab?.id !== undefined) {
      const tabId = sender.tab.id;
      const oldItems = await getPageMedia(tabId);
      const merged = new Map<string, MediaItem>(oldItems.map((item): [string, MediaItem] => [item.url, item]));
      for (const item of (message.items ?? []) as MediaItem[]) merged.set(item.url, item);
      await savePageMedia(tabId, [...merged.values()]);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'TASK_UPDATED') {
      await saveTask({ ...(message.task as DownloadTask), tabId: sender.tab?.id });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'CLEAR_HISTORY') {
      await chrome.storage.local.set({ downloadHistory: [] });
      sendResponse({ ok: true });
      return;
    }
    const tabId = Number.isInteger(message.tabId) ? message.tabId : await activeTabId();
    if (tabId === undefined) { sendResponse({ ok: false, error: '没有活动标签页' }); return; }
    if (message.type === 'START_DOWNLOAD' || message.type === 'SCAN_MEDIA' || message.type === 'PAUSE_TASK' || message.type === 'RESUME_TASK') {
      const targetTabId = Number.isInteger(message.tabId) ? message.tabId : tabId;
      const response = await chrome.tabs.sendMessage(targetTabId, cloneStructuredMessage(message)).catch((error) => ({ ok: false, status: 0, error: formatError(error).message }));
      sendResponse(response);
    }
  })().catch((error) => sendResponse({ ok: false, status: 0, error: formatError(error).message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.local.remove(`media:${tabId}`).catch((error) => console.warn(formatErrorLog('[TG Downloader][storage] tab cleanup failed', error, { tabId })));
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('downloadHistory').then(async (stored) => {
    if (!stored.downloadHistory) await chrome.storage.local.set({ downloadHistory: [] });
  }).catch((error) => console.warn(formatErrorLog('[TG Downloader][storage] initialization failed', error)));
});

