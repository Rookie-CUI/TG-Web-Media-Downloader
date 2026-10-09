import type { MediaItem } from '../types';
import type { ScannedMediaIdentity } from '../types/scanned-media';

export interface MediaBatchSelection {
  mediaTypes: Array<'image' | 'video' | 'gif'>;
  loadAllMedia: boolean;
  visibleOnly: boolean;
  skipDownloaded: boolean;
}

export interface MediaSelectionKey {
  messageId: string;
  url: string;
}

export function mediaSelectionKey(item: MediaSelectionKey): string {
  return `${item.messageId}\u0000${item.url}`;
}

export interface BatchItemProgress {
  index: number;
  total: number;
  item: MediaItem;
  status: 'start' | 'complete' | 'failed';
  stage?: 'resolve' | 'download';
  error?: unknown;
}

export interface BatchDownloadResult {
  success: number;
  failed: number;
  failures: Array<{ item: MediaItem; stage: 'resolve' | 'download'; error: unknown }>;
}

export interface IdentityBatchProgress {
  index: number;
  total: number;
  identity: ScannedMediaIdentity;
  status: 'start' | 'complete' | 'failed';
  stage?: 'resolve' | 'download';
  error?: unknown;
}

export interface IdentityBatchResult {
  success: number;
  failed: number;
  failures: Array<{ identity: ScannedMediaIdentity; stage: 'resolve' | 'download'; error: unknown }>;
}

export function dedupeScannedIdentities(items: readonly ScannedMediaIdentity[]): ScannedMediaIdentity[] {
  const unique = new Map<string, ScannedMediaIdentity>();
  for (const item of items) {
    if (item?.stableKey) unique.set(item.stableKey, item);
  }
  return [...unique.values()];
}

export function filterScannedIdentities(
  items: readonly ScannedMediaIdentity[],
  selection: { mediaTypes: Array<'image' | 'video' | 'gif'>; skipDownloaded: boolean },
): ScannedMediaIdentity[] {
  const types = new Set(selection.mediaTypes);
  return dedupeScannedIdentities(items).filter((item) =>
    types.has(item.kind) && (!selection.skipDownloaded || !item.hasDownloaded));
}

export function resolveSelectedIdentities(
  canonical: ReadonlyMap<string, ScannedMediaIdentity>,
  stableKeys: readonly string[],
): ScannedMediaIdentity[] {
  const selected = new Map<string, ScannedMediaIdentity>();
  for (const key of stableKeys) {
    if (typeof key !== 'string') continue;
    const identity = canonical.get(key);
    if (identity) selected.set(key, identity);
  }
  return [...selected.values()];
}

export async function runFullHistoryScanSequence<T>(
  hideDialog: () => void,
  scan: () => Promise<T[]>,
  applyResults: (items: T[]) => Promise<void> | void,
  reopenDialog: () => void,
): Promise<T[]> {
  let hidden = false;
  try {
    hideDialog();
    hidden = true;
    const items = await scan();
    await applyResults(items);
    return items;
  } finally {
    if (hidden) reopenDialog();
  }
}

/** Resolve every selected sidebar identity at download time; scanned URL fields are never accepted. */
export async function downloadIdentityBatch(
  identities: readonly ScannedMediaIdentity[],
  resolveCurrent: (
    identity: ScannedMediaIdentity,
    onResolvedBeforeViewerClose: (item: MediaItem) => Promise<void>,
  ) => Promise<MediaItem | null>,
  download: (item: MediaItem, identity: ScannedMediaIdentity) => Promise<void> | void,
  onProgress?: (progress: IdentityBatchProgress) => void,
): Promise<IdentityBatchResult> {
  const unique = dedupeScannedIdentities(identities);
  const result: IdentityBatchResult = { success: 0, failed: 0, failures: [] };
  for (const [index, identity] of unique.entries()) {
    const itemIndex = index + 1;
    let stage: 'resolve' | 'download' = 'resolve';
    let started = false;
    onProgress?.({ index: itemIndex, total: unique.length, identity, status: 'start' });
    try {
      const resolved = await resolveCurrent(identity, async (freshItem) => {
        if (started) return;
        started = true;
        stage = 'download';
        // The stable identity becomes the persisted media ID; the fresh URL comes only from this JIT resolve.
        await download({
          ...freshItem,
          id: identity.stableKey,
          messageId: identity.messageId,
          peerId: identity.peerId,
          kind: identity.kind,
        }, identity);
      });
      if (!resolved || !started) {
        throw Object.assign(new Error('当前媒体身份未在 Viewer 中解析并启动下载'), { code: 'IDENTITY_DOWNLOAD_NOT_STARTED' });
      }
      result.success += 1;
      onProgress?.({ index: itemIndex, total: unique.length, identity, status: 'complete' });
    } catch (error) {
      result.failed += 1;
      result.failures.push({ identity, stage, error });
      onProgress?.({ index: itemIndex, total: unique.length, identity, status: 'failed', stage, error });
    }
  }
  return result;
}

export function filterAdvancedMediaItems(items: MediaItem[], selection: MediaBatchSelection): MediaItem[] {
  const types = new Set(selection.mediaTypes);
  return dedupeMediaItems(items).filter((item) =>
    types.has(item.kind as 'image' | 'video' | 'gif') && (!selection.skipDownloaded || !item.hasDownloaded));
}

export async function resolveViewerMediaBeforeClose<T extends { url: string }>(
  resolve: () => Promise<T | null>,
  startDownload: (item: T) => Promise<void> | void,
  closeViewer: () => Promise<void>,
): Promise<T | null> {
  let finalItem: T | null = null;
  let downloadPromise: Promise<void> | undefined;
  try {
    const resolved = await resolve();
    if (resolved?.url) {
      finalItem = { ...resolved, url: String(resolved.url) };
      // Invoking this callback synchronously creates the download task while the
      // Viewer and its Blob URL are still alive. Await completion after closing.
      downloadPromise = Promise.resolve(startDownload(finalItem));
    }
  } finally {
    await closeViewer();
  }
  if (downloadPromise) await downloadPromise;
  return finalItem;
}

export async function startKViewerDownloadAfterSourceResolution<T extends { url: string }>(
  resolveStableSource: () => Promise<T | null>,
  startDownload: (item: T) => Promise<void> | void,
  closeViewer: () => Promise<void>,
): Promise<T> {
  const item = await resolveStableSource();
  if (!item?.url) throw Object.assign(new Error('K Viewer 媒体来源未解析；Viewer 已保留'), { code: 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED' });
  const downloadPromise = Promise.resolve(startDownload(item));
  await closeViewer();
  await downloadPromise;
  return item;
}

export function dedupeMediaItems(items: MediaItem[]): MediaItem[] {
  const unique = new Map<string, MediaItem>();
  for (const item of items) unique.set(`${item.messageId}\u0000${item.url}`, item);
  return [...unique.values()];
}

export function resolveSelectedMediaKeys(canonical: ReadonlyMap<string, MediaItem>, keys: readonly MediaSelectionKey[]): MediaItem[] {
  const selected = new Map<string, MediaItem>();
  for (const key of keys) {
    if (typeof key?.messageId !== 'string' || typeof key?.url !== 'string') continue;
    const identity = mediaSelectionKey(key);
    const item = canonical.get(identity);
    if (item) selected.set(identity, item);
  }
  return [...selected.values()];
}

export async function resolveAndDownloadMedia(
  resolve: (messageId: string, force: boolean, preferredUrl?: string) => Promise<MediaItem[]>,
  download: (item: MediaItem) => Promise<void> | void,
  messageId: string,
  force: boolean,
  preferredUrl?: string,
  select?: (items: MediaItem[]) => MediaItem[],
): Promise<MediaItem[]> {
  const resolved = dedupeMediaItems(await resolve(messageId, force, preferredUrl));
  const selected = dedupeMediaItems(select ? select(resolved) : resolved);
  for (const item of selected) await download(item);
  return selected;
}

export async function resolveSidebarAndDownloadMedia(
  resolve: (messageId: string, preferredUrl: string | undefined, onResolvedBeforeViewerClose: (item: MediaItem) => Promise<void> | void) => Promise<MediaItem[]>,
  download: (item: MediaItem) => Promise<void> | void,
  messageId: string,
  preferredUrl?: string,
): Promise<MediaItem[]> {
  const started = new Map<string, Promise<void>>();
  const resolved = dedupeMediaItems(await resolve(messageId, preferredUrl, (item) => {
    const key = `${item.messageId}\u0000${item.url}`;
    if (item.nativeDownloadStarted) {
      started.set(key, Promise.resolve());
      return;
    }
    let promise = started.get(key);
    if (!promise) {
      promise = Promise.resolve(download(item));
      started.set(key, promise);
    }
    return promise;
  }));
  if (!resolved.length) throw new Error('NO_MEDIA_URL');
  for (const item of resolved) {
    if (item.nativeDownloadStarted) continue;
    const key = `${item.messageId}\u0000${item.url}`;
    const startedPromise = started.get(key);
    if (startedPromise) await startedPromise;
    else {
      started.set(key, Promise.resolve(download(item)));
      await started.get(key);
    }
  }
  return resolved;
}

export async function downloadBatchMedia(
  items: MediaItem[],
  resolveCurrent: (messageId: string, preferredUrl: string, onResolvedBeforeViewerClose?: (item: MediaItem) => Promise<void>) => Promise<MediaItem[]>,
  download: (item: MediaItem) => Promise<void> | void,
  onProgress?: (progress: BatchItemProgress) => void,
): Promise<BatchDownloadResult> {
  const unique = dedupeMediaItems(items);
  const submitted = new Set<string>();
  const completed = new Set<string>();
  const failedKeys = new Set<string>();
  const result: BatchDownloadResult = { success: 0, failed: 0, failures: [] };
  for (const [index, snapshot] of unique.entries()) {
    const itemIndex = index + 1;
    onProgress?.({ index: itemIndex, total: unique.length, item: snapshot, status: 'start' });
    const startedForCurrent = new Map<string, Promise<void>>();
    let stage: 'resolve' | 'download' = 'resolve';
    try {
      const current = dedupeMediaItems(await resolveCurrent(snapshot.messageId, snapshot.url, (resolved) => {
        const key = `${resolved.messageId}\u0000${resolved.url}`;
        if (startedForCurrent.has(key)) return startedForCurrent.get(key)!;
        if (failedKeys.has(key)) return Promise.reject(Object.assign(new Error('该媒体此前已失败，本批次不会重复提交'), { code: 'BATCH_DUPLICATE_FAILED' }));
        if (completed.has(key)) return Promise.resolve();
        if (submitted.has(key)) return Promise.resolve();
        submitted.add(key);
        stage = 'download';
        const promise = Promise.resolve().then(() => download(resolved));
        startedForCurrent.set(key, promise);
        return promise;
      }));
      const item = current.find((candidate) => candidate.url === snapshot.url || (candidate as MediaItem & { sourceUrl?: string }).sourceUrl === snapshot.url)
        || (current.length === 1 ? current[0] : undefined);
      if (!item) throw Object.assign(new Error('当前消息未解析到与 Media card 匹配的媒体地址'), { code: 'NO_MEDIA_URL' });

      const key = `${item.messageId}\u0000${item.url}`;
      const pending = startedForCurrent.get(key);
      if (pending) {
        stage = 'download';
        await pending;
      } else if (!completed.has(key)) {
        if (failedKeys.has(key)) throw Object.assign(new Error('该媒体此前已失败，本批次不会重复提交'), { code: 'BATCH_DUPLICATE_FAILED' });
        if (!submitted.has(key)) {
          submitted.add(key);
          stage = 'download';
          const promise = Promise.resolve().then(() => download(item));
          startedForCurrent.set(key, promise);
          await promise;
        }
      }
      completed.add(key);
      result.success += 1;
      onProgress?.({ index: itemIndex, total: unique.length, item, status: 'complete' });
    } catch (error) {
      await Promise.allSettled([...startedForCurrent.values()]);
      for (const key of startedForCurrent.keys()) failedKeys.add(key);
      result.failed += 1;
      result.failures.push({ item: snapshot, stage, error });
      onProgress?.({ index: itemIndex, total: unique.length, item: snapshot, status: 'failed', stage, error });
    }
  }
  return result;
}
