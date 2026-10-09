import type { DownloadTask, MediaItem, TaskStatus } from '../types';
import { getSettings } from '../storage/local';
import { formatError, formatErrorLog } from '../utils/errors';
import { cloneStructuredMessage } from '../utils/structured-clone';
import { inspectMediaContainer, filenameWithContainer } from './media-container';
import { createHttpRangeState, downloadHttpRangeQueue, type HttpRangeState } from './http-range-queue';

const MARK = '__TG_PERSONAL_MEDIA_V1__';
const CHUNK_BYTES = 2 * 1024 * 1024;

function notifyInvalidContext(error: unknown, operation: string): void {
  const details = formatError(error);
  if (!/extension context invalidated|context invalidated|extension context.*invalid/i.test(details.message)) return;
  window.postMessage(cloneStructuredMessage({ type: 'TG_RUNTIME_CONTEXT_INVALIDATED', messageId: crypto.randomUUID(), operation, error: details.message }), '*');
}

function getUrlType(url: string): string {
  if (url.startsWith('blob:')) return 'blob';
  if (url.includes('/progressive/')) return 'progressive';
  if (url.includes('/stream/')) return 'stream';
  if (url.includes('/download/')) return 'download';
  return 'http';
}

function getUrlHost(url: string): string {
  try { return new URL(url).host; }
  catch { return 'unknown'; }
}

function isAllowedTelegramHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'telegram.org' || host.endsWith('.telegram.org') ||
    host === 'telegram-cdn.org' || host.endsWith('.telegram-cdn.org') ||
    host === 't.me' || host.endsWith('.t.me');
}

function usePageHttpBridge(url: string, requiresPageTransport = false): boolean {
  const type = getUrlType(url);
  return requiresPageTransport || type === 'progressive' || type === 'stream' || type === 'download';
}

function selectMime(responseMime: string | undefined, pageMime: string | undefined): string {
  const clean = (value: string | undefined) => (value || '').split(';', 1)[0].trim().toLowerCase();
  const response = clean(responseMime);
  if (response && response !== 'application/octet-stream' && response !== 'binary/octet-stream') return response;
  const page = clean(pageMime);
  return page || response || 'application/octet-stream';
}

function filenameWithMime(filename: string, mime: string): string {
  const extension = ({
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'application/pdf': '.pdf',
    'application/zip': '.zip',
  } as Record<string, string>)[mime];
  if (!extension) return filename;
  const current = filename.match(/\.([a-z0-9]{2,8})$/i)?.[0] || '';
  if (current.toLowerCase() === extension) return filename;
  return (current ? filename.slice(0, -current.length) : filename) + extension;
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

interface TransferState {
  task: DownloadTask;
  media: MediaItem;
  chunks: BlobPart[];
  offset: number;
  total: number;
  controller?: AbortController;
  runPromise?: Promise<void>;
  requestId?: string;
  pauseRequested: boolean;
  responseMimeType?: string;
  responseLength?: string;
  responseRange?: string;
  requestTransport?: 'background' | 'page';
  blobLeaseId?: string;
  blobLeaseReleased?: boolean;
  rangeState?: HttpRangeState;
  cancelled?: boolean;
  downloadMs?: number;
}

export class Downloader {
  private transfers = new Map<string, TransferState>();

  async start(media: MediaItem): Promise<void> {
    const now = Date.now();
    const task: DownloadTask = {
      id: crypto.randomUUID(), mediaId: media.id, url: media.url, filename: media.filename,
      size: media.size || 0, bytesDownloaded: 0, progress: 0, status: 'pending', error: '', createdAt: now, updatedAt: now,
    };
    const transfer: TransferState = {
      task, media, chunks: [], offset: 0, total: media.size || 0, pauseRequested: false,
      blobLeaseId: media.blobLeaseId,
    };
    this.transfers.set(task.id, transfer);
    if (media.kSingleVideo) console.info('[TG Downloader][timing] downloader start', {
      messageId: media.messageId,
      viewerOpenMs: media.kSingleVideo.viewerOpenMs,
      candidateDiscoveryMs: media.kSingleVideo.candidateDiscoveryMs,
      probeMs: media.kSingleVideo.probeMs,
      downloaderStartMs: Math.max(0, now - media.kSingleVideo.resolvedAt),
    });
    console.info('[TG Downloader][download] start', {
      taskId: task.id, messageId: media.messageId, filename: task.filename, kind: media.kind,
      urlType: getUrlType(media.url), objectUrlKind: media.objectUrlKind || (media.url.startsWith('blob:') ? 'unknown' : undefined),
      hasBlobLease: Boolean(media.blobLeaseId),
    });
    try {
      await this.update(transfer, 'pending');
      await this.run(transfer);
    } catch (error) {
      if (transfer.task.status !== 'paused') await this.releaseBlobLease(transfer);
      throw error;
    }
  }

  async pause(taskId: string): Promise<void> {
    const transfer = this.transfers.get(taskId);
    if (!transfer || transfer.task.status === 'completed') return;
    transfer.pauseRequested = true;
    transfer.controller?.abort();
    if (transfer.requestId) {
      void chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'CANCEL_MEDIA_RANGE', requestId: transfer.requestId })).catch((error) => notifyInvalidContext(error, 'CANCEL_MEDIA_RANGE'));
      if (transfer.requestTransport === 'page') {
        window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'CANCEL_PAGE_MEDIA_RANGE', requestId: transfer.requestId }), '*');
      }
    }
    if (!transfer.controller) await this.update(transfer, 'paused');
  }

  async resume(taskId: string): Promise<void> {
    const transfer = this.transfers.get(taskId);
    if (!transfer || transfer.task.status !== 'paused') return;
    if (transfer.runPromise) await transfer.runPromise;
    if (transfer.task.status !== 'paused') return;
    transfer.pauseRequested = false;
    await this.run(transfer);
  }

  async cancel(taskId: string): Promise<void> {
    const transfer = this.transfers.get(taskId);
    if (!transfer || transfer.task.status === 'completed') return;
    transfer.cancelled = true;
    transfer.pauseRequested = false;
    transfer.controller?.abort();
    await transfer.runPromise?.catch(() => undefined);
    transfer.chunks = [];
    transfer.rangeState?.parts.clear();
    await this.releaseBlobLease(transfer);
    await this.update(transfer, 'failed', '下载已取消');
    this.transfers.delete(taskId);
  }

  private async run(transfer: TransferState): Promise<void> {
    const running = this.execute(transfer);
    transfer.runPromise = running;
    try {
      await running;
    } finally {
      if (transfer.runPromise === running) transfer.runPromise = undefined;
    }
  }

  private async execute(transfer: TransferState): Promise<void> {
    const { media } = transfer;
    try {
      if (transfer.cancelled) throw Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_CANCELLED' });
      await this.update(transfer, 'resolving');
      this.assertAllowedUrl(media.url);
      if (transfer.pauseRequested) {
        if (media.kSingleVideo) await this.update(transfer, 'paused');
        return;
      }
      transfer.controller = new AbortController();
      await this.update(transfer, 'downloading');

      const downloadStartedAt = Date.now();
      try {
        if (media.url.startsWith('blob:')) await this.downloadBlob(transfer);
        else if (media.kSingleVideo) await this.downloadKSingleVideoHttp(transfer);
        else await this.downloadHttp(transfer);
      } finally {
        transfer.downloadMs = (transfer.downloadMs || 0) + Date.now() - downloadStartedAt;
      }
      if (transfer.pauseRequested) {
        if (media.kSingleVideo) await this.update(transfer, 'paused');
        return;
      }
      let finalMime = selectMime(transfer.responseMimeType, media.mimeType);
      let blob = new Blob(transfer.chunks, { type: finalMime });
      if (media.kSingleVideo) {
        const container = await inspectMediaContainer(blob);
        console.info('[TG Downloader][container]', {
          messageId: media.messageId,
          detectedContainer: container.detectedContainer,
          declaredMime: transfer.responseMimeType || media.mimeType || '',
          finalMime: container.finalMime,
          finalExtension: container.finalExtension,
          firstBox: container.firstBox,
          standalonePlayable: container.standalonePlayable,
          containerReason: container.reason,
        });
        if (!container.standalonePlayable) throw Object.assign(new Error(`媒体容器不能作为独立文件保存：${container.reason}`), {
          code: 'MEDIA_CONTAINER_NOT_STANDALONE', containerReason: container.reason,
        });
        finalMime = container.finalMime;
        transfer.task.filename = filenameWithContainer(transfer.task.filename, container.finalExtension);
        blob = blob.slice(0, blob.size, finalMime);
        if (transfer.pauseRequested) throw new DOMException('Paused', 'AbortError');
      } else transfer.task.filename = filenameWithMime(transfer.task.filename, finalMime);
      if (transfer.cancelled) throw Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_CANCELLED' });
      console.info('[TG Downloader][download]', {
        messageId: media.messageId,
        urlType: getUrlType(media.url),
        contentType: transfer.responseMimeType || '',
        contentLength: transfer.responseLength || String(transfer.total || blob.size),
        contentRange: transfer.responseRange || '',
        filename: transfer.task.filename,
        finalMime,
      });
      const saveStartedAt = Date.now();
      this.saveBlob(blob, transfer.task.filename);
      if (media.kSingleVideo) console.info('[TG Downloader][timing] save dispatched', {
        messageId: media.messageId, downloadMs: transfer.downloadMs || 0, saveMs: Date.now() - saveStartedAt,
      });
      await this.update(transfer, 'completed');
      console.info('[TG Downloader][download] complete', { taskId: transfer.task.id, messageId: media.messageId, filename: transfer.task.filename, size: blob.size });
      await this.releaseBlobLease(transfer);
      this.transfers.delete(transfer.task.id);
    } catch (error) {
      if (transfer.cancelled) error = Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_CANCELLED' });
      if (transfer.pauseRequested) {
        await this.update(transfer, 'paused');
      } else {
        const details = formatError(error);
        await this.update(transfer, 'failed', details.message);
        console.error(formatErrorLog('[TG Downloader][download] failed', error, {
          taskId: transfer.task.id, messageId: media.messageId, filename: transfer.task.filename,
          urlType: getUrlType(media.url), requestId: details.requestId || transfer.requestId || 'n/a',
        }));
        if (/extension context invalidated|context invalidated/i.test(details.message)) {
          window.postMessage(cloneStructuredMessage({ type: 'TG_RUNTIME_CONTEXT_INVALIDATED', messageId: crypto.randomUUID(), operation: 'FETCH_MEDIA_RANGE', error: details.message }), '*');
        }
        await this.releaseBlobLease(transfer);
        throw error;
      }
    } finally {
      transfer.controller = undefined;
    }
  }

  private async downloadKSingleVideoHttp(transfer: TransferState): Promise<void> {
    const settings = await getSettings();
    const chunkSize = Math.max(4, Math.min(8, settings.chunkSizeMb || 4)) * 1024 * 1024;
    const state = transfer.rangeState ||= createHttpRangeState();
    const result = await downloadHttpRangeQueue(state, {
      signal: transfer.controller!.signal,
      chunkSize,
      concurrency: 4,
      maxRetries: settings.maxRetries,
      request: async (start, end, signal) => {
        const requestId = `${transfer.task.id}:${start}:${crypto.randomUUID()}`;
        console.info('[TG Downloader][range] K single-video request', {
          requestId, start, end, transport: 'page', concurrency: 4, chunkSize,
        });
        const response = await this.fetchPageMediaRange(transfer.media.url, requestId, start, end, signal, true);
        return {
          ...response,
          bytes: response.bytes instanceof ArrayBuffer ? response.bytes : decodeBase64(typeof response.bytes === 'string' ? response.bytes : ''),
        };
      },
      onProgress: async (received, total) => {
        transfer.offset = received;
        transfer.total = total;
        transfer.task.size = total;
        await this.report(transfer, 'downloading');
      },
    });
    transfer.chunks = result.chunks;
    transfer.total = result.total;
    transfer.offset = result.total;
    transfer.responseMimeType = result.contentType;
    transfer.responseRange = result.contentRange;
    transfer.responseLength = String(result.total);
  }

  private async downloadHttp(transfer: TransferState): Promise<void> {
    const settings = await getSettings();
    const chunkSize = Math.max(256 * 1024, Math.min(8, settings.chunkSizeMb) * 1024 * 1024) || CHUNK_BYTES;
    let retryCount = 0;
    while (!transfer.total || transfer.offset < transfer.total) {
      if (transfer.pauseRequested) throw new DOMException('Paused', 'AbortError');
      const start = transfer.offset;
      const end = start + chunkSize - 1;
      const requestId = `${transfer.task.id}:${start}`;
      const requestInfo = { urlType: getUrlType(transfer.media.url), host: getUrlHost(transfer.media.url), requestId, start, end };
      let response: any;
      console.info('[TG Downloader][range] request', { ...requestInfo, retryCount });
      try {
        transfer.requestId = requestId;
        transfer.requestTransport = usePageHttpBridge(transfer.media.url, transfer.media.requiresPageTransport) ? 'page' : 'background';
        try {
          response = transfer.requestTransport === 'page'
            ? await this.fetchPageMediaRange(transfer.media.url, requestId, start, end, transfer.controller?.signal)
            : await chrome.runtime.sendMessage(cloneStructuredMessage({
              type: 'FETCH_MEDIA_RANGE', requestId, url: transfer.media.url, start, end,
            }));
        } finally {
          if (transfer.requestId === requestId) transfer.requestId = undefined;
          transfer.requestTransport = undefined;
        }
        if (transfer.pauseRequested) throw new DOMException('Paused', 'AbortError');
        if (!response?.ok) {
          const details = formatError(response?.error ?? `媒体请求失败：HTTP ${response?.status ?? '未知'}`);
          throw Object.assign(new Error(details.message), {
            name: details.name,
            status: Number(response?.status) || details.status || 0,
            code: details.code || response?.code,
            retryable: response?.retryable,
            error: details.message,
            requestId,
            start,
            end,
          });
        }
        transfer.responseMimeType = String(response.contentType || transfer.responseMimeType || '');
        transfer.responseLength = String(response.contentLength || transfer.responseLength || '');
        transfer.responseRange = String(response.contentRange || transfer.responseRange || '');
        const responseMime = transfer.responseMimeType.split(';', 1)[0].trim().toLowerCase();
        if (responseMime === 'text/html') {
          throw Object.assign(new Error('媒体 Range 请求返回 text/html 页面，而不是媒体数据'), {
            code: 'NON_MEDIA_RESPONSE', retryable: false, status: Number(response.status) || 0,
            requestId,
            finalUrlHost: getUrlHost(String(response.finalUrl || '')),
            finalUrlType: getUrlType(String(response.finalUrl || '')),
          });
        }
        if (Number(response.status) >= 300 && Number(response.status) < 400) {
          throw Object.assign(new Error(`HTTP 重定向未完成：${response.status}`), {
            code: 'HTTP_REDIRECT_NOT_FOLLOWED', retryable: false, status: Number(response.status),
            requestId,
            finalUrlHost: getUrlHost(String(response.finalUrl || '')),
            finalUrlType: getUrlType(String(response.finalUrl || '')),
          });
        }
        transfer.task.filename = filenameWithMime(transfer.task.filename, selectMime(transfer.responseMimeType, transfer.media.mimeType));
        const responseInfo = {
          ...requestInfo,
          status: Number(response.status) || 0,
          ok: response.ok === true,
          contentType: transfer.responseMimeType,
          contentLength: transfer.responseLength,
          contentRange: transfer.responseRange,
          acceptRanges: String(response.acceptRanges || ''),
          finalUrlHost: getUrlHost(String(response.finalUrl || '')),
          finalUrlType: getUrlType(String(response.finalUrl || '')),
          redirected: Boolean(response.redirected),
        };
        if (response.status === 200) {
          if (transfer.offset > 0) {
            transfer.chunks = [];
            transfer.offset = 0;
          }
          const full = decodeBase64(response.bytes || '');
          console.info('[TG Downloader][range] response', { ...responseInfo, returnedBytes: full.byteLength });
          transfer.chunks.push(full);
          transfer.total = Number(response.contentLength) || full.byteLength;
          transfer.offset = full.byteLength;
          transfer.task.size = full.byteLength;
          transfer.task.bytesDownloaded = full.byteLength;
          await this.report(transfer, 'downloading');
          return;
        }
        const contentRange = response.contentRange || '';
        const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
        if (response.status !== 206 || !match) throw new Error('服务器没有返回有效的 Range 分片');
        const bytes = decodeBase64(response.bytes || '');
        console.info('[TG Downloader][range] response', { ...responseInfo, returnedBytes: bytes.byteLength });
        if (!bytes.byteLength) throw new Error('媒体分片为空');
        const rangeStart = Number(match[1]);
        const rangeEnd = Number(match[2]);
        if (rangeStart !== transfer.offset || rangeEnd < rangeStart || bytes.byteLength !== rangeEnd - rangeStart + 1) {
          throw new Error('媒体分片范围与响应长度不匹配');
        }
        transfer.chunks.push(bytes);
        transfer.offset = rangeEnd + 1;
        transfer.total = Number(match[3]);
        transfer.responseLength = String(transfer.total);
        transfer.responseRange = contentRange;
        transfer.task.size = transfer.total;
        transfer.task.bytesDownloaded = transfer.offset;
        await this.report(transfer, 'downloading');
        retryCount = 0;
      } catch (error) {
        if (transfer.pauseRequested || (error instanceof DOMException && error.name === 'AbortError')) throw error;
        const details = formatError(error);
        console.error(formatErrorLog('[TG Downloader][range] failed', error, {
          ...requestInfo, status: Number(response?.status) || details.status || 0,
          ok: response?.ok === true, contentType: String(response?.contentType || ''),
          contentLength: String(response?.contentLength || ''), contentRange: String(response?.contentRange || ''),
          acceptRanges: String(response?.acceptRanges || ''), returnedBytes: Number(response?.returnedBytes) || 0,
          retryCount,
        }));
        if (/extension context invalidated|context invalidated/i.test(details.message)) {
          window.postMessage(cloneStructuredMessage({ type: 'TG_RUNTIME_CONTEXT_INVALIDATED', messageId: crypto.randomUUID(), operation: 'FETCH_MEDIA_RANGE', error: details.message }), '*');
          throw error;
        }
        const retryable = error && typeof error === 'object' && 'retryable' in error ? (error as { retryable?: unknown }).retryable : undefined;
        if (retryable === false || ['NON_MEDIA_RESPONSE', 'HTTP_REDIRECT_NOT_FOLLOWED', 'TELEGRAM_REDIRECT_NOT_ALLOWED', 'TELEGRAM_URL_NOT_ALLOWED'].includes(String(details.code || ''))) {
          throw error;
        }
        retryCount += 1;
        if (retryCount > settings.maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * retryCount));
      }
    }
  }

  private fetchPageMediaRange(url: string, requestId: string, start: number, end: number, signal?: AbortSignal, binaryResponse = false): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (binaryResponse) window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'CANCEL_PAGE_MEDIA_RANGE', requestId }), '*');
        finish(Object.assign(new Error('Telegram 页面 Range bridge 超时'), { code: 'PAGE_RANGE_TIMEOUT', requestId, retryable: true }));
      }, 30000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== MARK || event.data?.type !== 'FETCH_PAGE_MEDIA_RANGE_RESPONSE' || event.data?.requestId !== requestId) return;
        finish(undefined, event.data);
      };
      const onAbort = () => {
        window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'CANCEL_PAGE_MEDIA_RANGE', requestId }), '*');
        finish(new DOMException('Paused', 'AbortError'));
      };
      if (signal?.aborted) { onAbort(); return; }
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'FETCH_PAGE_MEDIA_RANGE', requestId, url, start, end,
          ...(binaryResponse ? { responseEncoding: 'arraybuffer' } : {}),
        }), '*');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async downloadBlob(transfer: TransferState): Promise<void> {
    const settings = await getSettings();
    const chunkSize = Math.max(256 * 1024, Math.min(8, settings.chunkSizeMb) * 1024 * 1024) || CHUNK_BYTES;
    let total = transfer.media.size || transfer.total;
    if (!total) {
      const metadata = await this.readPageBlobMetadata(transfer.media.url, transfer.task.id, transfer.controller?.signal);
      total = metadata.total;
      transfer.responseMimeType = metadata.mimeType || transfer.responseMimeType;
      transfer.responseLength = String(total || '');
      transfer.total = total;
      console.info('[TG Downloader][blob] metadata resolved', {
        requestId: `${transfer.task.id}:meta`, total, mimeType: metadata.mimeType, cacheState: metadata.cacheState,
      });
    }
    if (!Number.isSafeInteger(total) || total <= 0) {
      const error = Object.assign(new Error('页面 Blob 元数据未提供有效大小'), { code: 'BLOB_SIZE_UNKNOWN', requestId: `${transfer.task.id}:meta` });
      console.error(formatErrorLog('[TG Downloader][blob] failed', error, { urlType: 'blob', blobSize: total, mime: transfer.media.mimeType }));
      throw error;
    }
    transfer.total = total;
    transfer.task.size = total;
    while (transfer.offset < total) {
      if (transfer.pauseRequested) throw new DOMException('Paused', 'AbortError');
      const end = Math.min(transfer.offset + chunkSize - 1, total - 1);
      const start = transfer.offset;
      const rangeInfo = { urlType: 'blob', requestId: `${transfer.task.id}:${start}`, start, end, blobSize: total, mime: transfer.media.mimeType };
      console.info('[TG Downloader][blob] request', rangeInfo);
      const part = await this.readPageBlob(transfer.media.url, transfer.task.id, start, end, total, transfer.media.mimeType, transfer.controller?.signal, transfer.blobLeaseId);
      console.info('[TG Downloader][blob] response', { ...rangeInfo, returnedBytes: part.bytes.byteLength, cacheState: part.cacheState, mime: part.mimeType || transfer.media.mimeType });
      if (!part.bytes.byteLength) throw Object.assign(new Error('页面 Blob 分片为空'), { code: 'BLOB_PART_EMPTY', requestId: rangeInfo.requestId, start, end });
      if (part.total !== total || part.bytes.byteLength !== end - start + 1) {
        throw Object.assign(new Error('页面 Blob 分片范围或总大小不匹配'), { code: 'BLOB_RANGE_MISMATCH', requestId: rangeInfo.requestId, start, end, expectedTotal: total, actualTotal: part.total, returnedBytes: part.bytes.byteLength });
      }
      transfer.chunks.push(part.bytes);
      transfer.responseMimeType = part.mimeType || transfer.responseMimeType;
      transfer.responseLength = String(part.total || total);
      transfer.offset += part.bytes.byteLength;
      transfer.task.size = total;
      transfer.task.bytesDownloaded = transfer.offset;
      await this.report(transfer, 'downloading');
    }
  }

  private readPageBlobMetadata(url: string, taskId: string, signal?: AbortSignal): Promise<{ total: number; mimeType: string; cacheState: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `${taskId}:meta`;
      const timeout = window.setTimeout(() => {
        const error = Object.assign(new Error('读取页面 Blob 元数据超时'), { code: 'BLOB_META_TIMEOUT', requestId });
        console.error(formatErrorLog('[TG Downloader][blob] failed', error, { urlType: 'blob', requestId, stage: 'metadata' }));
        finish(error);
      }, 15000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== MARK || event.data?.requestId !== requestId) return;
        if (event.data.kind === 'BLOB_META') {
          resolveResult({
            total: Number(event.data.total) || 0,
            mimeType: String(event.data.mimeType || ''),
            cacheState: String(event.data.cacheState || 'unknown'),
          });
        } else if (event.data.kind === 'BLOB_ERROR') {
          const error = Object.assign(new Error(String(event.data.error || '页面 Blob 元数据读取失败')), {
            code: String(event.data.code || 'BLOB_META_FAILED'), requestId, status: Number(event.data.status) || 0,
          });
          console.error(formatErrorLog('[TG Downloader][blob] failed', error, {
            urlType: 'blob', requestId, stage: 'metadata', cacheState: String(event.data.cacheState || 'unknown'),
          }));
          finish(error);
        }
      };
      const onAbort = () => finish(new DOMException('Paused', 'AbortError'));
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error, metadata?: { total: number; mimeType: string; cacheState: string }) => {
        cleanup();
        if (error) reject(error); else resolve(metadata!);
      };
      const resolveResult = (metadata: { total: number; mimeType: string; cacheState: string }) => finish(undefined, metadata);
      if (signal?.aborted) { onAbort(); return; }
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const message = cloneStructuredMessage({ mark: MARK, kind: 'GET_BLOB_META', messageId: requestId, requestId, url });
        window.postMessage(message, '*');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readPageBlob(url: string, taskId: string, start: number, end: number, blobSize: number, mime: string, signal?: AbortSignal, leaseId?: string): Promise<{ bytes: ArrayBuffer; total: number; mimeType: string; cacheState: string }> {
    return new Promise((resolve, reject) => {
      const requestId = `${taskId}:${start}`;
      const timeout = window.setTimeout(() => {
        const error = Object.assign(new Error('读取页面 Blob 超时'), { code: 'BLOB_READ_TIMEOUT', requestId, start, end });
        console.error(formatErrorLog('[TG Downloader][blob] failed', error, { urlType: 'blob', requestId, start, end, blobSize, mime, returnedBytes: 0 }));
        finish(error);
      }, 15000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== MARK || event.data?.requestId !== requestId) return;
        if (event.data.kind === 'BLOB_PART' && event.data.bytes instanceof ArrayBuffer) finish(undefined, {
          bytes: event.data.bytes,
          total: Number(event.data.total) || 0,
          mimeType: String(event.data.mimeType || ''),
          cacheState: String(event.data.cacheState || 'unknown'),
        });
        if (event.data.kind === 'BLOB_ERROR') {
          const error = Object.assign(new Error(String(event.data.error || '页面 Blob 读取失败')), {
            code: String(event.data.code || 'BLOB_READ_FAILED'),
            requestId,
            status: Number(event.data.status) || 0,
          });
          console.error(formatErrorLog('[TG Downloader][blob] failed', error, {
            urlType: 'blob', requestId, start, end, blobSize, mime,
            cacheState: String(event.data.cacheState || 'unknown'), returnedBytes: 0,
          }));
          finish(error);
        }
      };
      const onAbort = () => finish(new DOMException('Paused', 'AbortError'));
      const finish = (error?: Error, part?: { bytes: ArrayBuffer; total: number; mimeType: string; cacheState: string }) => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(part!);
      };
      if (signal?.aborted) { onAbort(); return; }
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'READ_BLOB', messageId: requestId, requestId, url, start, end, blobSize, mime, leaseId }), '*');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async releaseBlobLease(transfer: TransferState): Promise<void> {
    const leaseId = transfer.blobLeaseId;
    if (!leaseId || transfer.blobLeaseReleased) return;
    transfer.blobLeaseReleased = true;
    const requestId = `${transfer.task.id}:release`;
    console.info('[TG Downloader][blob] release request', {
      taskId: transfer.task.id, urlType: 'blob', objectUrlKind: transfer.media.objectUrlKind || 'blob', hasLease: true,
    });
    await new Promise<void>((resolve) => {
      let finished = false;
      const timeout = window.setTimeout(() => finish(), 2000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== MARK || event.data?.kind !== 'BLOB_RELEASE_RESULT' || event.data?.requestId !== requestId) return;
        console.info('[TG Downloader][blob] release complete', {
          taskId: transfer.task.id, urlType: 'blob', objectUrlKind: event.data.objectUrlKind || transfer.media.objectUrlKind || 'blob',
          released: event.data.released === true, cacheState: event.data.cacheState || 'unknown',
        });
        finish();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve();
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage(cloneStructuredMessage({ mark: MARK, kind: 'RELEASE_BLOB', requestId, url: transfer.media.url, leaseId }), '*');
      } catch (error) {
        console.warn('[TG Downloader][blob] release message failed', { taskId: transfer.task.id, error: formatError(error).message });
        finish();
      }
    });
  }

  private assertAllowedUrl(value: string): void {
    if (value.startsWith('blob:')) return;
    const url = new URL(value);
    if (url.protocol !== 'https:' || !(url.hostname.toLowerCase() === 'web.telegram.org' || isAllowedTelegramHost(url.hostname))) {
      throw new Error('只允许下载 Telegram 页面捕获的 HTTPS 媒体地址');
    }
  }

  private saveBlob(blob: Blob, filename: string): void {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  private async update(transfer: TransferState, status: TaskStatus, error = ''): Promise<void> {
    transfer.task.status = status;
    transfer.task.error = error;
    transfer.task.updatedAt = Date.now();
    await this.report(transfer, status);
  }

  private async report(transfer: TransferState, status: TaskStatus): Promise<void> {
    transfer.task.status = status;
    transfer.task.progress = transfer.total ? Math.min(100, Math.floor((transfer.offset / transfer.total) * 100)) : 0;
    transfer.task.bytesDownloaded = transfer.offset;
    transfer.task.updatedAt = Date.now();
    try {
      await chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'TASK_UPDATED', task: transfer.task }));
    } catch (error) {
      notifyInvalidContext(error, 'TASK_UPDATED');
    }
  }
}
