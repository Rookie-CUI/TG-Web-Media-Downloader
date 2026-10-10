import { Downloader } from '../downloader/downloader';
import { dedupeMediaItems, downloadIdentityBatch, filterScannedIdentities, resolveAndDownloadMedia, resolveSelectedIdentities, runFullHistoryScanSequence } from '../telegram/download-flow';
import { detectTelegramVersion, mediaFromPageEvent, scanLoadedMedia, scanSidebarMedia } from '../telegram/adapter';
import { TelegramMediaResolver } from '../telegram/original-media-resolver';
import { TelegramPageEnhancer } from '../telegram/page-enhancer';
import { getHistory, getSettings } from '../storage/local';
import { openAdvancedDownloadDialog, setAdvancedDownloadDialogVisible, updateAdvancedDownloadMediaList, updateAdvancedDownloadProgress } from '../telegram/advanced-download-dialog';
import { LABELS } from '../i18n/labels';
import { formatError, formatErrorLog } from '../utils/errors';
import { cloneStructuredMessage } from '../utils/structured-clone';
import { MessageDeduplicator } from '../utils/message-deduplicator';
import type { MediaItem } from '../types';
import type { AdvancedHistoryScanRequest, ScannedMediaIdentity } from '../types/scanned-media';

const MARK = '__TG_PERSONAL_MEDIA_V1__';
const downloader = new Downloader();
const resolver = new TelegramMediaResolver();
const media = new Map<string, MediaItem>();
const timeouts = new Set<number>();
let observerTimer = 0;
let sidebarWatchObserver: MutationObserver | undefined;
let toolbarObserver: MutationObserver | undefined;
let sidebarObserver: MutationObserver | undefined;
let stopped = false;
let scanAndPublish: () => Promise<MediaItem[]>;
let latestAdvancedIdentities: ScannedMediaIdentity[] = [];
const canonicalAdvancedMedia = new Map<string, ScannedMediaIdentity>();
const advancedMessageIds = new MessageDeduplicator(300);

console.info('[TG Downloader][init]', { version: detectTelegramVersion(), mode: 'local' });

function isInvalidated(error: unknown): boolean {
  return /extension context invalidated|context invalidated|extension context.*invalid/i.test(formatError(error).message);
}

function stopForInvalidContext(error: unknown, operation: string): void {
  if (stopped) return;
  stopped = true;
  if (observerTimer) window.clearInterval(observerTimer);
  for (const timer of timeouts) window.clearTimeout(timer);
  timeouts.clear();
  sidebarWatchObserver?.disconnect();
  toolbarObserver?.disconnect();
  sidebarObserver?.disconnect();
  const details = formatError(error);
  console.warn(`[TG Downloader][runtime] Extension context invalidated. Refresh Telegram page. name=${details.name} message=${details.message} code=${details.code || 'n/a'} operation=${operation}`);
}

async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T | undefined> {
  if (stopped) return undefined;
  try {
    return await run();
  } catch (error) {
    if (isInvalidated(error)) stopForInvalidContext(error, operation);
    else {
      const details = formatError(error);
      console.warn(formatErrorLog(`[TG Downloader][${operation}] failed`, error));
    }
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { timeouts.delete(timer); resolve(); }, ms);
    timeouts.add(timer);
  });
}

function publish(items: MediaItem[], persist = true): void {
  if (stopped) return;
  for (const item of dedupeMediaItems(items)) media.set(item.url, item);
  const recent = [...media.values()].slice(-300);
  media.clear();
  recent.forEach((item) => media.set(item.url, item));
  pageEnhancer.update(recent);
  if (!persist) return;
  try {
    void chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'MEDIA_DISCOVERED', items: recent })).catch((error) => {
      if (isInvalidated(error)) stopForInvalidContext(error, 'MEDIA_DISCOVERED');
      else console.warn(formatErrorLog('[TG Downloader][runtime] MEDIA_DISCOVERED failed', error));
    });
  } catch (error) {
    if (isInvalidated(error)) stopForInvalidContext(error, 'MEDIA_DISCOVERED');
    else {
      console.warn(formatErrorLog('[TG Downloader][runtime] MEDIA_DISCOVERED failed', error));
    }
  }
}

async function scan(): Promise<MediaItem[]> {
  const settings = await getSettings();
  const loaded = [...scanLoadedMedia(settings), ...scanSidebarMedia()];
  const unique = dedupeMediaItems(loaded);
  const tasks = await getHistory();
  const downloaded = new Set(tasks.filter((task) => task.status === 'completed').flatMap((task) => [task.url, task.mediaId]));
  return unique.map((item) => ({ ...item, hasDownloaded: downloaded.has(item.url) || downloaded.has(item.id) }));
}

scanAndPublish = async (): Promise<MediaItem[]> => {
  const items = await scan();
  publish(items);
  return items;
};

async function downloadItem(item: MediaItem): Promise<void> {
  if (stopped) return;
  await downloader.start(item);
}

async function resolveCurrent(messageId: string, force: boolean, preferredUrl?: string): Promise<MediaItem[]> {
  const items = force ? await resolver.resolveForce(messageId, preferredUrl) : await resolver.resolveMessage(messageId, preferredUrl);
  console.info(force ? '[TG Downloader][force] resolved MediaItem' : '[TG Downloader][resolver] fresh MediaItem', items.map(({ messageId: mid, kind, url }) => ({ messageId: mid, kind, urlType: urlType(url) })));
  publish(items, false);
  return items;
}

async function openChannelMedia(): Promise<MediaItem[]> {
  const opened = await resolver.openChannelMedia();
  if (!opened) return [];
  const items = await resolver.prepareAndScan();
  publish(items, false);
  return items;
}

function chatTitle(): string {
  return document.querySelector('#column-center .chat-info .peer-title, #column-center .peer-title, .MiddleHeader .peer-title')?.textContent?.trim() || '';
}

async function withDownloadHistory(items: MediaItem[]): Promise<MediaItem[]> {
  const tasks = await getHistory();
  const downloaded = new Set(tasks.filter((task) => task.status === 'completed').flatMap((task) => [task.url, task.mediaId]));
  return items.map((item) => ({ ...item, hasDownloaded: item.hasDownloaded || downloaded.has(item.url) || downloaded.has(item.id) }));
}

async function withIdentityDownloadHistory(items: ScannedMediaIdentity[]): Promise<ScannedMediaIdentity[]> {
  const tasks = await getHistory();
  const downloaded = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.mediaId));
  return items.map((item) => ({ ...item, hasDownloaded: item.hasDownloaded || downloaded.has(item.stableKey) }));
}

function setLatestAdvancedItems(items: ScannedMediaIdentity[]): void {
  const unique = new Map<string, ScannedMediaIdentity>();
  for (const item of items) unique.set(item.stableKey, item);
  latestAdvancedIdentities = [...unique.values()];
  canonicalAdvancedMedia.clear();
  for (const item of latestAdvancedIdentities) canonicalAdvancedMedia.set(item.stableKey, item);
}

async function executeIdentityBatch(items: ScannedMediaIdentity[], showDialogProgress: boolean): Promise<void> {
  const unique = [...new Map(items.map((item) => [item.stableKey, item])).values()];
  if (!unique.length) {
    if (showDialogProgress) updateAdvancedDownloadProgress({ completed: 0, total: 0, successCount: 0, failedCount: 0, status: 'failed', error: LABELS.noMedia });
    else pageEnhancer.setBatchProgress('0 / 0');
    return;
  }
  if (showDialogProgress) updateAdvancedDownloadProgress({ completed: 0, total: unique.length, successCount: 0, failedCount: 0, status: 'downloading' });
  else pageEnhancer.setBatchProgress(`0 / ${unique.length}`);
  try {
    console.info('[TG Downloader][batch] start', { count: unique.length });
    let itemSuccess = 0;
    let itemFailed = 0;
    const result = await downloadIdentityBatch(unique,
      (identity, beforeViewerClose) => resolver.resolveScannedIdentity(identity, beforeViewerClose),
      (item) => downloadItem(item),
      (event) => {
        const { index, total, identity } = event;
        if (event.status === 'start') {
          console.info('[TG Downloader][batch] item-start', { index, total, stableKey: identity.stableKey, messageId: identity.messageId, kind: identity.kind });
        } else if (event.status === 'complete') {
          itemSuccess += 1;
          console.info('[TG Downloader][batch] item-complete', { index, total, stableKey: identity.stableKey, messageId: identity.messageId, kind: identity.kind });
        } else {
          itemFailed += 1;
          const details = formatError(event.error);
          const reason = details.name === 'AbortError' ? details.reason || details.message || 'AbortError' : undefined;
          console.error(formatErrorLog('[TG Downloader][batch] item-failed', event.error, {
            index, total, stableKey: identity.stableKey, messageId: identity.messageId,
            kind: identity.kind, stage: event.stage || 'resolve', reason, abortWasUserRequested: false,
          }));
        }
        const completed = itemSuccess + itemFailed;
        if (showDialogProgress) updateAdvancedDownloadProgress({
          completed, total, successCount: itemSuccess, failedCount: itemFailed,
          currentFile: `${identity.kind} · ${identity.messageId}`, status: 'downloading', statusText: `正在处理 ${index}/${total}`,
        });
        else pageEnhancer.setBatchProgress(`${completed} / ${total} · ${identity.messageId}`);
      });
    const finalStatus = result.failed > 0 && result.success === 0 ? 'failed' : 'completed';
    const outcomeText = result.failed > 0 ? `部分完成：成功 ${result.success}，失败 ${result.failed}` : undefined;
    if (showDialogProgress) updateAdvancedDownloadProgress({
      completed: result.success + result.failed, total: unique.length,
      successCount: result.success, failedCount: result.failed, status: finalStatus, error: outcomeText,
    });
    else pageEnhancer.setBatchProgress(`${result.success} 成功 / ${result.failed} 失败`);
    console.info('[TG Downloader][batch] complete', { success: result.success, failed: result.failed, total: unique.length });
  } catch (error) {
    const details = formatError(error);
    console.error(formatErrorLog('[TG Downloader][batch] failed', error, { stage: 'batch' }));
    if (showDialogProgress) updateAdvancedDownloadProgress({ completed: 0, total: unique.length, successCount: 0, failedCount: unique.length, status: 'failed', error: details.message });
  }
}

async function startBatch(month?: Element): Promise<void> {
  if (month) {
    await guarded('batch', async () => {
      const prepared = await resolver.prepareVisibleIdentities();
      if (stopped) return;
      const monthSelector = detectTelegramVersion() === 'K'
        ? '.media-container[data-mid]'
        : '.Media.scroll-item, [id^="shared-mediamessage-"], [data-message-id]';
      const monthIds = new Set(Array.from(month.querySelectorAll<HTMLElement>(monthSelector)).map((node) =>
        node.dataset.mid || node.dataset.messageId || node.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') || '').filter(Boolean));
      const identities = await withIdentityDownloadHistory(prepared.filter((item) => monthIds.has(item.messageId)));
      await executeIdentityBatch(identities, false);
    });
    return;
  }

  console.info('[TG Downloader][advanced] startBatch enter');
  console.info('[TG Downloader][advanced] scan begin');
  const prepared = await resolver.prepareVisibleIdentities();
  if (stopped) throw new Error('扩展上下文已失效，请刷新 Telegram 页面');
  console.info('[TG Downloader][advanced] scan complete', { count: prepared.length });
  const items = await withIdentityDownloadHistory(prepared);
  setLatestAdvancedItems(items);
  await openAdvancedDownloadDialog({
    chatId: items[0]?.peerId || '',
    chatTitle: chatTitle(),
    mediaList: items,
  });
}

async function startAdvancedBatch(selection: {
  mediaTypes: Array<'image' | 'video' | 'gif'>;
  skipDownloaded: boolean;
  selectedKeys: string[];
}): Promise<void> {
  try {
    const selectedIdentities = resolveSelectedIdentities(canonicalAdvancedMedia, selection.selectedKeys);
    const selected = filterScannedIdentities(selectedIdentities, selection);
    console.info('[TG Downloader][advanced-submit] filtered', {
      before: latestAdvancedIdentities.length,
      after: selected.length,
      selectedKeys: selection.selectedKeys.length,
      mediaTypes: selection.mediaTypes,
      skipDownloaded: selection.skipDownloaded,
    });
    await executeIdentityBatch(selected, true);
  } catch (error) {
    const details = formatError(error);
    console.error(formatErrorLog('[TG Downloader][batch] failed', error, { stage: 'selection' }));
    updateAdvancedDownloadProgress({ completed: 0, total: latestAdvancedIdentities.length, successCount: 0, failedCount: latestAdvancedIdentities.length, status: 'failed', error: details.message });
  }
}

async function startFullHistoryScan(request: AdvancedHistoryScanRequest): Promise<void> {
  updateAdvancedDownloadProgress({ completed: 0, total: 0, status: 'scanning', statusText: '正在扫描完整历史媒体…' });
  console.info('[TG Downloader][scan] full-history start', {
    version: detectTelegramVersion(),
    preservedSelectionCount: request.selectedKeys.length,
    mediaTypes: request.mediaTypes,
    skipDownloaded: request.skipDownloaded,
  });
  try {
    await runFullHistoryScanSequence(
      () => setAdvancedDownloadDialogVisible(false),
      () => resolver.loadAllMedia(),
      async (identities) => {
        const withHistory = await withIdentityDownloadHistory(identities);
        setLatestAdvancedItems(withHistory);
        updateAdvancedDownloadMediaList(withHistory);
        updateAdvancedDownloadProgress({ completed: withHistory.length, total: withHistory.length, status: 'idle', statusText: `扫描完成：已发现 ${withHistory.length} 项` });
        console.info('[TG Downloader][scan] full-history complete', { count: withHistory.length, dedupeKey: 'stableKey' });
      },
      () => setAdvancedDownloadDialogVisible(true),
    );
  } catch (error) {
    const details = formatError(error);
    updateAdvancedDownloadProgress({ completed: 0, total: latestAdvancedIdentities.length, status: 'failed', statusText: '完整历史扫描失败', error: details.message });
    console.error(formatErrorLog('[TG Downloader][scan] full-history failed', error));
    setAdvancedDownloadDialogVisible(true);
  }
}

const pageEnhancer = new TelegramPageEnhancer({
  openChannelMedia,
  readSingleDownloadBaseline: () => resolver.readSingleDownloadBaseline(),
  resolveSingleAttachment: (session, startDownload) => resolver.resolveSingleAttachment(session, startDownload),
  resolveSidebar: (messageId, preferredUrl, onResolvedBeforeViewerClose) => detectTelegramVersion() === 'K'
    ? resolver.resolveSidebarItem(messageId, preferredUrl, true, onResolvedBeforeViewerClose)
    : resolver.resolveForce(messageId, preferredUrl),
  startBatch,
  download: downloadItem,
});

function urlType(url: string): string {
  if (url.startsWith('blob:')) return 'blob';
  if (url.includes('/progressive/')) return 'progressive';
  if (url.includes('/stream/')) return 'stream';
  return 'http';
}

void guarded('scan', scanAndPublish);
const version = detectTelegramVersion();
const mainColumn = document.querySelector(version === 'A' ? '.MiddleColumn' : '#column-center') || document.body;
toolbarObserver = new MutationObserver(() => {
  void guarded('toolbar-observer', async () => { pageEnhancer.update([...media.values()]); });
});
toolbarObserver.observe(mainColumn, { childList: true, subtree: true });

const watchedMediaSelector = '.search-super-container-media, .media-container[data-mid], .search-super-month, .Media.scroll-item, [id^="shared-mediamessage-"]';
let sidebarDebounce = 0;
sidebarObserver = new MutationObserver((records) => {
  const changed = records.some((record) => {
    if (record.target instanceof Element && record.target.matches(watchedMediaSelector)) return true;
    return Array.from(record.addedNodes).some((node) => node instanceof Element &&
      (node.matches(watchedMediaSelector) || Boolean(node.querySelector(watchedMediaSelector))));
  });
  if (!changed || stopped) return;
  if (sidebarDebounce) window.clearTimeout(sidebarDebounce);
  sidebarDebounce = window.setTimeout(() => {
    timeouts.delete(sidebarDebounce);
    sidebarDebounce = 0;
    void guarded('scan', scanAndPublish);
  }, 160);
  timeouts.add(sidebarDebounce);
});
sidebarObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-mid', 'data-message-id', 'src'] });

const timerScan = () => { if (!stopped) void guarded('scan', scanAndPublish); };
observerTimer = window.setInterval(timerScan, 5000);
window.addEventListener('pagehide', () => {
  stopped = true;
  if (observerTimer) window.clearInterval(observerTimer);
  for (const timer of timeouts) window.clearTimeout(timer);
  timeouts.clear();
  toolbarObserver?.disconnect();
  sidebarObserver?.disconnect();
  sidebarWatchObserver?.disconnect();
}, { once: true });

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || stopped) return;
  if (event.data?.type === 'TG_RUNTIME_CONTEXT_INVALIDATED') {
    stopForInvalidContext(event.data.error || 'Extension context invalidated', String(event.data.operation || 'runtime request'));
    return;
  }
  if (event.data?.mark === MARK && event.data?.kind === 'MEDIA') {
    const item = mediaFromPageEvent(event.data.detail);
    if (item) publish([item]);
    return;
  }
  if (event.data?.type === 'TG_DOWNLOADER_MEDIA_URLS_RESPONSE' && Array.isArray(event.data.items)) {
    const items = event.data.items.map((detail: { url?: string; source?: string }) => mediaFromPageEvent(detail)).filter(Boolean) as MediaItem[];
    if (items.length) publish(items);
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || stopped) return;
  if (event.data?.type !== 'TG_START_CHAT_MEDIA_EXPORT' && event.data?.type !== 'TG_LOAD_ALL_MEDIA_REQUEST') return;
  const isScanRequest = event.data.type === 'TG_LOAD_ALL_MEDIA_REQUEST';
  const options = (isScanRequest ? event.data.request : event.data.options) as {
    mediaTypes?: Array<'image' | 'video' | 'gif'>;
    skipDownloaded?: boolean;
    selectedKeys?: string[];
  } | undefined;
  const messageId = String(event.data?.messageId || '');
  console.info(isScanRequest ? '[TG Downloader][scan] full-history request' : '[TG Downloader][advanced-submit] content-received', {
    markMatches: event.data?.mark === MARK,
    type: event.data?.type,
    messageId,
    selectedCount: Array.isArray(options?.selectedKeys) ? options.selectedKeys.length : 0,
    mediaTypes: options?.mediaTypes,
    skipDownloaded: options?.skipDownloaded,
  });
  if (event.data?.mark !== MARK) {
    console.warn(`[TG Downloader][advanced-submit] rejected markMatches=${event.data?.mark === MARK}`);
    return;
  }
  if (!messageId || !advancedMessageIds.accept(messageId)) {
    console.info('[TG Downloader][advanced-submit] duplicate-or-missing-message', { messageId: messageId || 'missing' });
    return;
  }
  if (!options || !Array.isArray(options.mediaTypes) || !Array.isArray(options.selectedKeys) || typeof options.skipDownloaded !== 'boolean') {
    console.error('[TG Downloader][batch] invalid advanced-download request; expected mediaTypes, selectedKeys and skipDownloaded');
    return;
  }
  const selectedKeys = options.selectedKeys.filter((key): key is string => typeof key === 'string');
  if (isScanRequest) {
    void startFullHistoryScan({ selectedKeys, mediaTypes: options.mediaTypes, skipDownloaded: options.skipDownloaded })
      .catch((error) => console.error(formatErrorLog('[TG Downloader][scan] unhandled full-history rejection', error, { messageId })));
    return;
  }
  void startAdvancedBatch({
    mediaTypes: options.mediaTypes,
    skipDownloaded: options.skipDownloaded,
    selectedKeys,
  }).catch((error) => console.error(formatErrorLog('[TG Downloader][batch] unhandled submit rejection', error, { messageId })));
});

window.postMessage(cloneStructuredMessage({ type: 'TG_DOWNLOADER_GET_MEDIA_URLS', messageId: crypto.randomUUID(), requestId: crypto.randomUUID(), since: 0 }), '*');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (stopped) return false;
  if (message.type === 'SCAN_MEDIA') {
    void guarded('scan', scanAndPublish).then((items) => { try { sendResponse({ items: items || [] }); } catch (error) { if (isInvalidated(error)) stopForInvalidContext(error, 'SCAN_MEDIA response'); } });
    return true;
  }
  if (message.type === 'START_DOWNLOAD') {
    const requested = (message.media || media.get(message.media?.url)) as MediaItem | undefined;
    if (!requested?.messageId) { sendResponse({ ok: false, error: '媒体已不在当前页面列表中' }); return false; }
    void guarded('download', async () => {
      const selected = await resolveAndDownloadMedia((mid, force, url) => resolveCurrent(mid, force, url), downloadItem, requested.messageId, false, requested.url);
      return selected.length;
    }).then((count) => { try { sendResponse({ ok: Boolean(count), error: count ? undefined : '无法从当前消息重新解析媒体地址' }); } catch (error) { if (isInvalidated(error)) stopForInvalidContext(error, 'START_DOWNLOAD response'); } });
    return true;
  }
  if (message.type === 'PAUSE_TASK') { void guarded('download', () => downloader.pause(message.taskId)); sendResponse({ ok: true }); return false; }
  if (message.type === 'RESUME_TASK') { void guarded('download', () => downloader.resume(message.taskId)); sendResponse({ ok: true }); return false; }
  return false;
});
