import type { MediaItem, MediaKind, ObjectUrlKind } from '../types';
import { filenameForResolvedMedia } from '../utils/filename';
import { formatErrorLog } from '../utils/errors';

export interface SingleDownloadCandidate {
  url: string;
  source: string;
  capturedAt: number;
  mimeType?: string;
  kindHint?: MediaKind;
  objectUrlKind?: ObjectUrlKind;
  origin: 'bridge' | 'viewer' | 'performance';
  trustedMainMedia?: boolean;
  activeViewerMainMedia?: boolean;
  validated?: boolean;
  width?: number;
  height?: number;
}

export interface MessageAttachment {
  key: string;
  index: number;
  activationElement: Element;
}

export interface AttachmentSession {
  sessionId: string;
  messageId: string;
  attachmentKey: string;
  attachmentIndex: number;
  startedAt: number;
  baselineUrls: Set<string>;
  activationElement: Element;
}

export interface MessageDownloadSession {
  sessionId: string;
  messageId: string;
  attachments: MessageAttachment[];
  startedAt: number;
  caption: string;
}

export interface MessageDownloadResult {
  successCount: number;
  failedCount: number;
  failures: Array<{ attachmentIndex: number; attachmentKey: string; code: string }>;
}

export interface CandidateDecision {
  selected: SingleDownloadCandidate | null;
  rejected: Array<{ candidate: SingleDownloadCandidate; reason: string }>;
  kind: MediaKind | null;
}

function mediaKind(candidate: SingleDownloadCandidate, viewerHasVideo: boolean): MediaKind | null {
  const mime = String(candidate.mimeType || '').split(';', 1)[0].toLowerCase();
  const url = candidate.url.toLowerCase();
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)(?:$|[?#])/.test(url)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|ogg|opus|aac|wav|flac|weba)(?:$|[?#])/.test(url)) return 'audio';
  if (mime === 'image/gif' || /\.gif(?:$|[?#])/.test(url)) return 'gif';
  if (mime.startsWith('image/') || /\.(avif|bmp|jpe?g|png|webp)(?:$|[?#])/.test(url)) return 'image';
  if (candidate.activeViewerMainMedia && candidate.kindHint === 'image') return 'image';
  if (viewerHasVideo && candidate.validated &&
      (candidate.trustedMainMedia || ['progressive', 'download', 'stream', 'blob'].includes(singleCandidateSourceType(candidate)))) return 'video';
  return null;
}

export function singleCandidateSourceType(candidate: Pick<SingleDownloadCandidate, 'url' | 'objectUrlKind'>): string {
  if (candidate.objectUrlKind === 'media-source') return 'media-source';
  if (candidate.url.startsWith('blob:')) return 'blob';
  const lower = candidate.url.toLowerCase();
  if (lower.includes('/progressive/')) return 'progressive';
  if (lower.includes('/download/')) return 'download';
  if (lower.includes('/stream/')) return 'stream';
  return 'http';
}

function candidateScore(candidate: SingleDownloadCandidate, kind: MediaKind): number {
  const sourceType = singleCandidateSourceType(candidate);
  if (candidate.validated && sourceType === 'progressive') return 120;
  if (candidate.validated && sourceType === 'download') return 115;
  if (candidate.validated && sourceType === 'stream') return 105;
  if (candidate.validated && (kind === 'video' || kind === 'audio')) return 100;
  if (sourceType === 'blob' && candidate.objectUrlKind === 'blob') return 95;
  if (candidate.trustedMainMedia && kind === 'video') return 90;
  if (candidate.trustedMainMedia && kind === 'image') return 80 + Math.min(10, ((candidate.width || 0) * (candidate.height || 0)) / 1_000_000);
  if (candidate.origin === 'performance') return 60;
  return 40;
}

export function selectSingleDownloadCandidate(
  candidates: readonly SingleDownloadCandidate[],
  session: Pick<AttachmentSession, 'startedAt' | 'baselineUrls'>,
  viewerHasVideo: boolean,
): CandidateDecision {
  const rejected: CandidateDecision['rejected'] = [];
  const eligible: Array<{ candidate: SingleDownloadCandidate; kind: MediaKind; score: number }> = [];
  for (const candidate of candidates) {
    const kind = mediaKind(candidate, viewerHasVideo);
    let reason = '';
    if (!candidate.url) reason = 'empty-url';
    else if (session.baselineUrls.has(candidate.url) && !candidate.activeViewerMainMedia) reason = 'baseline-url';
    else if (candidate.origin !== 'viewer' && candidate.capturedAt < session.startedAt) reason = 'before-session';
    else if (candidate.objectUrlKind === 'media-source') reason = 'media-source-not-file';
    else if (!kind) reason = 'media-type-unverified';
    else if (viewerHasVideo && (kind === 'image' || kind === 'gif')) reason = 'video-poster';
    else if (kind === 'image' && candidate.url.startsWith('blob:') &&
        (candidate.validated !== true || candidate.objectUrlKind !== 'blob')) reason = 'blob-not-verified';
    else if (kind === 'image' && !candidate.trustedMainMedia) reason = 'weak-image-preview';
    else if ((kind === 'video' || kind === 'audio') && candidate.url.startsWith('http') && !candidate.validated) reason = 'http-not-validated';
    if (reason || !kind) {
      rejected.push({ candidate, reason: reason || 'media-type-unverified' });
      continue;
    }
    eligible.push({ candidate, kind, score: candidateScore(candidate, kind) });
  }
  eligible.sort((left, right) => right.score - left.score || right.candidate.capturedAt - left.candidate.capturedAt);
  return { selected: eligible[0]?.candidate || null, rejected, kind: eligible[0]?.kind || null };
}

const K_NATIVE_FALLBACK_CODES = new Set([
  'HTTP_REDIRECT_NOT_FOLLOWED',
  'NON_MEDIA_RESPONSE',
  'TELEGRAM_REDIRECT_NOT_ALLOWED',
  'TELEGRAM_URL_NOT_ALLOWED',
  'MEDIA_CONTAINER_NOT_STANDALONE',
  'PAGE_RANGE_TIMEOUT',
  'MEDIA_HTTP_STATUS_INVALID',
  'INVALID_CONTENT_RANGE',
  'RANGE_TOTAL_MISMATCH',
  'RANGE_RESPONSE_MISMATCH',
  'BLOB_META_TIMEOUT',
  'BLOB_READ_TIMEOUT',
  'BLOB_PART_EMPTY',
  'BLOB_RANGE_MISMATCH',
]);

export function shouldAttemptKNativeFallback(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
  if (K_NATIVE_FALLBACK_CODES.has(code)) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error || '');
  if (/cancel|cancelled|canceled|pause|paused|abort|extension context invalidated|context invalidated|取消|暂停/i.test(`${code} ${message}`)) return false;
  return false;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && error.name) return error.name;
  return 'SINGLE_DOWNLOAD_FAILED';
}

function log(event: string, detail: Record<string, unknown>): void {
  console.info(`[TG Downloader][single-download] ${event}`, detail);
}

export async function runMessageDownloadSession(options: {
  messageId: string;
  attachments: MessageAttachment[];
  caption: string;
  readBaseline: () => Promise<readonly Pick<SingleDownloadCandidate, 'url'>[]>;
  resolveAttachment: (
    session: AttachmentSession,
    startDownload: (item: MediaItem) => Promise<void>,
  ) => Promise<MediaItem>;
  download: (item: MediaItem) => Promise<void> | void;
  now?: () => number;
  createId?: () => string;
}): Promise<MessageDownloadResult> {
  const now = options.now || Date.now;
  const createId = options.createId || (() => crypto.randomUUID());
  const messageSession: MessageDownloadSession = {
    sessionId: createId(), messageId: options.messageId, attachments: options.attachments,
    startedAt: now(), caption: options.caption,
  };
  const result: MessageDownloadResult = { successCount: 0, failedCount: 0, failures: [] };
  log('message-start', {
    messageId: messageSession.messageId, sessionId: messageSession.sessionId,
    attachmentCount: messageSession.attachments.length,
  });

  for (const attachment of messageSession.attachments) {
    const attachmentSessionId = createId();
    log('attachment-start', {
      messageId: options.messageId, sessionId: attachmentSessionId,
      attachmentIndex: attachment.index, attachmentKey: attachment.key,
    });
    try {
      // The ordering is intentional and tested: snapshot old URLs, timestamp, then activate.
      const baseline = await options.readBaseline();
      const activationMedia = attachment.activationElement.matches?.('img, video, source')
        ? [attachment.activationElement]
        : Array.from(attachment.activationElement.querySelectorAll?.('img, video, source') || []);
      const activationUrls = activationMedia.flatMap((node) => {
        const media = node as HTMLMediaElement | HTMLImageElement;
        const url = ('currentSrc' in media ? media.currentSrc : '') || node.getAttribute?.('src') || '';
        return url ? [url] : [];
      });
      const startedAt = now();
      const session: AttachmentSession = {
        sessionId: attachmentSessionId,
        messageId: options.messageId,
        attachmentKey: attachment.key,
        attachmentIndex: attachment.index,
        startedAt,
        baselineUrls: new Set([...baseline.map((candidate) => candidate.url).filter(Boolean), ...activationUrls]),
        activationElement: attachment.activationElement,
      };
      log('baseline', { messageId: options.messageId, sessionId: attachmentSessionId, count: session.baselineUrls.size });
      let downloadStarted = false;
      const item = await options.resolveAttachment(session, async (resolved) => {
        if (downloadStarted || resolved.nativeDownloadStarted) return;
        downloadStarted = true;
        const filename = filenameForResolvedMedia(
          messageSession.caption, resolved, attachment.index, messageSession.attachments.length, options.messageId,
        );
        log('downloader-start', {
          messageId: options.messageId, sessionId: attachmentSessionId,
          attachmentIndex: attachment.index, sourceType: singleCandidateSourceType(resolved), mime: resolved.mimeType || '',
        });
        await options.download({ ...resolved, filename });
      });
      if (!item.nativeDownloadStarted && !downloadStarted) {
        throw Object.assign(new Error('附件来源已解析但未启动下载'), { code: 'SINGLE_DOWNLOAD_NOT_STARTED' });
      }
      result.successCount += 1;
      log('attachment-complete', {
        messageId: options.messageId, sessionId: attachmentSessionId, attachmentIndex: attachment.index,
        nativeDownloadStarted: item.nativeDownloadStarted === true,
      });
    } catch (error) {
      const code = errorCode(error);
      result.failedCount += 1;
      result.failures.push({ attachmentIndex: attachment.index, attachmentKey: attachment.key, code });
      console.error(formatErrorLog('[TG Downloader][single-download] attachment-failed', error, {
        messageId: options.messageId, attachmentIndex: attachment.index, stage: 'source-resolve-or-download', code,
      }));
    }
  }

  log('message-complete', {
    messageId: options.messageId, sessionId: messageSession.sessionId,
    successCount: result.successCount, failedCount: result.failedCount,
  });
  return result;
}
