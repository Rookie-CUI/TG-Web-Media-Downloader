import { classifyMessage, classifySidebarMedia, detectTelegramVersion, getMessageId, messageSelector } from './adapter';
import { resolveViewerMediaBeforeClose, startKViewerDownloadAfterSourceResolution } from './download-flow';
import { filenameFromUrl, safeFilename } from '../utils/filename';
import { formatError, formatErrorLog } from '../utils/errors';
import { enrichCapturedMedia } from './captured-media-registry';
import { inspectMediaContainer } from '../downloader/media-container';
import {
  resolveKViewerSourceOrNativeFallback,
  resolveKViewerVideoSource,
  runKViewerNativeDownloadAction,
  kViewerHttpPathClass,
  kViewerProbeRejectReason,
  allowedKViewerHttpUrl,
  waitForKViewerHttpSource,
  type KViewerCandidateSet,
  type KViewerHttpCandidate,
  type KViewerHttpPreflightResult,
  type PinnedViewerBlob,
} from './k-viewer-source';
import type { MediaItem } from '../types';
import type { ScannedMediaIdentity } from '../types/scanned-media';
import {
  selectSingleDownloadCandidate,
  singleCandidateSourceType,
  type AttachmentSession,
  type SingleDownloadCandidate,
} from './single-download-session';

export type OriginalMediaRecord = MediaItem & {
  monthGroup: string;
  dateTimestamp?: number;
  hasDownloaded: boolean;
  sourceUrl?: string;
  stableKey?: string;
  sidebarKey?: string;
  mediaIndex?: number;
  duration?: string;
  thumbnail?: string;
};

type KViewerBridgeStatus = {
  bridgeInstalledAt: number;
  createObjectURLHookInstalled: boolean;
  fetchHookInstalled: boolean;
  xhrHookInstalled: boolean;
  capturedObjectUrlCount: number;
  capturedMediaUrlCount: number;
};

type KViewerCaptureSession = {
  viewerOpenRequestAt: number;
  bridgeStatus: KViewerBridgeStatus | null;
  bridgeInstalledBeforeViewer: boolean;
  baselineUrls?: ReadonlySet<string>;
};

const K_SIDEBAR_SCROLL_SELECTORS = [
  '#column-right .sidebar-content > .scrollable.scrollable-y',
  '#column-right .sidebar-content .scrollable.scrollable-y',
  '.search-super-content-container.search-super-content-media .scrollable',
  '.search-super-container-media.active .scrollable',
  '#column-right .scrollable.scrollable-y',
  '#column-right .scrollable',
];

const A_SIDEBAR_SELECTORS = [
  '#RightColumn .Profile.custom-scroll',
  '#RightColumn .shared-media .custom-scroll',
  '#RightColumn .shared-media .Transition_slide-active',
  '#RightColumn .Transition_slide.Transition_slide-active',
  '#RightColumn .custom-scroll.Transition_slide-active',
  '#RightColumn .Transition_slide-active',
  '#RightColumn .custom-scroll',
  '#RightColumn .tabs-content',
  '#RightColumn .shared-media',
  '#RightColumn',
];

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const PAGE_BRIDGE_MARK = '__TG_PERSONAL_MEDIA_V1__';

type CardLocalStreamMetadata = { size?: number; mimeType?: string; fileName?: string };

export function normalizeCardLocalMediaUrl(rawSrc: string, baseUrl = window.location.href): string {
  try {
    const url = new URL(rawSrc, baseUrl);
    return ['stream', 'progressive', 'download'].includes(kViewerHttpPathClass(url.href)) ? url.href : '';
  } catch {
    return '';
  }
}

export function parseCardLocalStreamMetadata(value: string): CardLocalStreamMetadata {
  try {
    const url = new URL(value, window.location.href);
    const marker = '/stream/';
    const offset = url.pathname.toLowerCase().indexOf(marker);
    if (offset < 0) return {};
    const raw = decodeURIComponent(url.pathname.slice(offset + marker.length));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const size = Number(parsed.size);
    return {
      ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}),
      ...(typeof parsed.mimeType === 'string' && /^(video|audio)\//i.test(parsed.mimeType) ? { mimeType: parsed.mimeType } : {}),
      ...(typeof parsed.fileName === 'string' && parsed.fileName.trim() ? { fileName: parsed.fileName } : {}),
    };
  } catch {
    return {};
  }
}

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
}

export type ActiveViewerMediaScope = { root: Element; ownsCurrentAttachment: boolean; reason: 'active-slide' | 'unique-visible-slide' | 'viewer-fallback' };

export type ActiveViewerMediaReadyResult<T> = { kind: 'image' | 'video' | null; snapshot: T };

export async function waitForActiveViewerMediaReady<T>(
  readSnapshot: () => Promise<ActiveViewerMediaReadyResult<T>>,
  timeoutMs = 3200,
  pollMs = 120,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<ActiveViewerMediaReadyResult<T>> {
  const deadline = now() + timeoutMs;
  let latest = await readSnapshot();
  while (!latest.kind && now() < deadline) {
    await wait(Math.min(pollMs, Math.max(0, deadline - now())));
    latest = await readSnapshot();
  }
  return latest;
}

export function verifiedActiveViewerHttpImage(
  candidate: SingleDownloadCandidate,
  response: KViewerHttpPreflightResult,
): SingleDownloadCandidate | null {
  const mime = String(response.contentType || '').split(';', 1)[0].trim().toLowerCase();
  const rangeValid = response.status !== 206 || /^bytes\s+0-\d+\/\d+$/i.test(response.contentRange || '');
  if (!candidate.activeViewerMainMedia || candidate.kindHint !== 'image' ||
      !allowedKViewerHttpUrl(candidate.url) || ![200, 206].includes(response.status) ||
      !response.finalUrl || !allowedKViewerHttpUrl(response.finalUrl) || !mime.startsWith('image/') || !rangeValid) return null;
  return { ...candidate, url: response.finalUrl, mimeType: mime, validated: true };
}

type KActiveViewerSnapshot = {
  current: OriginalMediaRecord | null;
  viewerImages: SingleDownloadCandidate[];
  candidateSet: KViewerCandidateSet;
  scopeReason: ActiveViewerMediaScope['reason'];
  rootTag: string;
  ownsCurrentAttachment: boolean;
  visibleImageCount: number;
  loadedImageCount: number;
  visibleVideoCount: number;
  videoWithSrcCount: number;
  bridgeCandidateCount: number;
  performanceCandidateCount: number;
  mediaSourceCount: number;
};

const ACTIVE_VIEWER_SCOPE_SELECTORS = [
  '.media-viewer-mover.active',
  '.media-viewer-mover.is-active',
  '.MediaViewerSlide--active',
  '.MediaViewerSlide.active',
  '.media-viewer-slide.active',
  '[aria-hidden="false"].media-viewer-mover',
];

export function getActiveViewerMediaScope(viewer: Element): ActiveViewerMediaScope {
  if (viewer.matches('img, video, source')) {
    return { root: viewer, ownsCurrentAttachment: visible(viewer), reason: 'unique-visible-slide' };
  }
  for (const selector of ACTIVE_VIEWER_SCOPE_SELECTORS) {
    const active = Array.from(viewer.querySelectorAll(selector)).find(visible);
    if (active) return { root: active, ownsCurrentAttachment: true, reason: 'active-slide' };
  }
  const visibleSlides = Array.from(viewer.querySelectorAll(
    '.media-viewer-mover, .MediaViewerSlide, .media-viewer-slide, .media-viewer-mover-wrapper',
  )).filter(visible);
  if (visibleSlides.length === 1) {
    return { root: visibleSlides[0], ownsCurrentAttachment: true, reason: 'unique-visible-slide' };
  }
  const visibleMedia = Array.from(viewer.querySelectorAll('video, img')).filter(visible);
  if (visibleMedia.length === 1) {
    return { root: visibleMedia[0], ownsCurrentAttachment: true, reason: 'unique-visible-slide' };
  }
  return { root: viewer, ownsCurrentAttachment: false, reason: 'viewer-fallback' };
}

function viewerScopeNodes<T extends Element>(root: Element, selector: string): T[] {
  const nodes = [
    ...(root.matches(selector) ? [root as T] : []),
    ...Array.from(root.querySelectorAll<T>(selector)),
  ];
  return [...new Set(nodes)];
}

function activeViewerHasVideo(viewer: Element): boolean {
  const scope = getActiveViewerMediaScope(viewer);
  const videos = viewerScopeNodes(scope.root, 'video').filter(visible);
  if (videos.length === 1) return true;
  return scope.ownsCurrentAttachment && Boolean(scope.root.querySelector('source[type^="video/"], video source[src]'));
}

function mediaUrl(node: Element): string {
  const media = node as HTMLMediaElement;
  return media.currentSrc || media.src || node.getAttribute('src') || node.querySelector('img[src], video[src], source[src]')?.getAttribute('src') || '';
}

function viewerCandidateDetails(viewer: Element): Array<{ tag: string; className: string; urlType: string; hasCurrentSrc: boolean; hasSrc: boolean; naturalWidth: number; naturalHeight: number; mime: string }> {
  return Array.from(viewer.querySelectorAll('video, img, source')).map((node) => {
    const media = node as HTMLMediaElement | HTMLImageElement;
    const currentSrc = 'currentSrc' in media ? media.currentSrc || '' : '';
    const src = node.getAttribute('src') || '';
    const url = currentSrc || src;
    const image = node as HTMLImageElement;
    return {
      tag: node.tagName.toLowerCase(), className: String(node.className || ''), urlType: urlType(url),
      hasCurrentSrc: Boolean(currentSrc), hasSrc: Boolean(src), naturalWidth: image.naturalWidth || 0,
      naturalHeight: image.naturalHeight || 0, mime: node.getAttribute('type') || node.getAttribute('data-mime-type') || '',
    };
  });
}

export function sidebarImageClickTargets(container: Element): Element[] {
  return [container];
}

export async function openSidebarImageViewer(
  container: Element,
  waitForViewer: () => Promise<Element | null>,
  onTarget: (target: Element) => void = () => {},
  onClickError: (target: Element, error: unknown) => void = () => {},
): Promise<Element | null> {
  for (const target of sidebarImageClickTargets(container)) {
    onTarget(target);
    try {
      (target as HTMLElement).click();
    } catch (error) {
      onClickError(target, error);
      continue;
    }
    const viewer = await waitForViewer();
    if (viewer) return viewer;
  }
  return null;
}

export function largestViewerImageCandidate<T extends {
  currentSrc?: string;
  src?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
}>(images: readonly T[]): { image: T; url: string; width: number; height: number } | null {
  const candidates = images.flatMap((image) => {
    const url = image.currentSrc || image.src || '';
    if (!url) return [];
    return [{ image, url, width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 }];
  });
  return candidates.reduce<typeof candidates[number] | null>((best, candidate) => {
    const area = candidate.width * candidate.height;
    return !best || area > best.width * best.height ? candidate : best;
  }, null);
}

function activePeerId(): string {
  if (detectTelegramVersion() === 'A') {
    return document.querySelector('.MiddleHeader .Avatar[data-peer-id]')?.getAttribute('data-peer-id') || location.hash.replace(/^#/, '');
  }
  return document.querySelector('#column-center .bubble[data-peer-id]')?.getAttribute('data-peer-id') ||
    document.querySelector('#column-right .search-super-container-media.active [data-peer-id]')?.getAttribute('data-peer-id') || '';
}

function mediaElements(message: Element): Element[] {
  const version = detectTelegramVersion();
  if (version === 'A') {
    return Array.from(message.querySelectorAll('video.full-media, img.full-media, video, img.media-miniature, canvas.thumbnail'))
      .filter((node) => !node.closest('.EmbeddedMessage, .embedded-thumb, .message-subheader, [hidden], .spoilers-container'));
  }
  return Array.from(message.querySelectorAll('.media-video video, video.media-video, .media-photo img, img.media-photo, .media-gif-wrapper video, .media-gif-wrapper img, .attachment.media-container video, .attachment.media-container img'))
    .filter((node) => !node.closest('[hidden], .hide, .is-hidden, .spoilers-container'));
}

function inferKind(node: Element, message: Element, kindOverride?: MediaItem['kind']): MediaItem['kind'] {
  if (kindOverride) return kindOverride;
  const mime = node.getAttribute('type') || node.getAttribute('data-mime-type') || '';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (node.tagName === 'IMG' || node.tagName === 'CANVAS' || node.closest('.media-photo, .photo')) return 'image';
  if (node.tagName === 'VIDEO' || node.closest('.media-video, .video, .round, .media-gif-wrapper')) return 'video';
  const type = classifyMessage(message);
  return type === 'image' ? 'image' : type === 'audio' ? 'audio' : type === 'gif' ? 'gif' : 'video';
}

function monthTimestamp(label: string): number | undefined {
  if (!label) return undefined;
  const parsed = Date.parse(`${label} 1`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function mediaDuration(node: Element, card: Element): string {
  const direct = node.getAttribute('data-duration') || node.getAttribute('duration') || '';
  if (direct) return direct;
  const label = node.closest('.media-container, .Media, .message-content')?.querySelector('.video-time, .video-duration, .media-duration') ||
    card.querySelector('.video-time, .video-duration, .media-duration');
  const text = label?.textContent?.replace(/\s+/g, ' ').trim() || '';
  if (text) return text;
  const seconds = Number((node as HTMLMediaElement).duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function mediaThumbnail(node: Element, card: Element): string {
  const video = node as HTMLVideoElement;
  if (video.poster) return video.poster;
  const image = node.tagName === 'IMG' ? node as HTMLImageElement : card.querySelector<HTMLImageElement>('img.thumbnail, img.media-photo, img.media-miniature, img');
  return image?.currentSrc || image?.src || image?.getAttribute('src') || '';
}

function stableSidebarKey(version: 'A' | 'K', peerId: string, messageId: string): string {
  return `${version}:${peerId}:${messageId}`;
}

function recordFromNode(node: Element, message: Element, opts: {
  monthGroup?: string;
  downloaded?: boolean;
  fallbackUrl?: string;
  kind?: MediaItem['kind'];
  mediaIndex?: number;
  sidebarKey?: string;
  duration?: string;
  thumbnail?: string;
} = {}): OriginalMediaRecord | null {
  const url = opts.fallbackUrl || mediaUrl(node);
  if (!url || url.startsWith('data:') || !/^(https?:|blob:)/i.test(url)) return null;
  const version = detectTelegramVersion();
  const messageId = node.closest(messageSelector()) ? getMessageId(node.closest(messageSelector())!) :
    message.getAttribute('data-mid') || message.getAttribute('data-message-id') || message.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') || '';
  if (!messageId) return null;
  const kind = inferKind(node, message, opts.kind);
  const mimeType = node.getAttribute('type') || node.getAttribute('data-mime-type') || 'application/octet-stream';
  const peerId = message.getAttribute('data-peer-id') || message.closest('[data-peer-id]')?.getAttribute('data-peer-id') || activePeerId();
  const fileId = url.match(/(?:\/id\/|[?&](?:file_)?id=)([^/?&#]+)/i)?.[1] || '';
  const fallbackName = filenameFromUrl(url, kind);
  const monthGroup = opts.monthGroup || '';
  const mediaIndex = Math.max(0, Number(opts.mediaIndex) || 0);
  const sidebarKey = opts.sidebarKey || (version === 'unknown' ? `unknown:${peerId}:${messageId}` : stableSidebarKey(version, peerId, messageId));
  const stableKey = `${sidebarKey}:${kind}:${mediaIndex}`;
  return {
    id: `${messageId}:${url}`,
    url,
    filename: safeFilename(fallbackName),
    mimeType,
    size: Number(node.getAttribute('data-size')) || Number((node as HTMLMediaElement).dataset?.size) || 0,
    kind,
    messageId,
    peerId,
    fileId,
    source: 'dom',
    capturedAt: Date.now(),
    monthGroup,
    dateTimestamp: monthTimestamp(monthGroup),
    hasDownloaded: Boolean(opts.downloaded),
    stableKey,
    sidebarKey,
    mediaIndex,
    duration: opts.duration ?? mediaDuration(node, message),
    thumbnail: opts.thumbnail ?? mediaThumbnail(node, message),
  };
}

function aSidebarMediaNodes(card: Element, kind: MediaItem['kind']): Element[] {
  const videos = Array.from(card.querySelectorAll('video.full-media, video'));
  const images = Array.from(card.querySelectorAll('img.full-media, img.media-miniature, img, canvas.thumbnail'));
  return kind === 'video' || kind === 'gif' ? (videos.length ? videos : images) : images;
}

function kSidebarMediaNodes(card: Element, kind: MediaItem['kind']): Element[] {
  const videoNodes = Array.from(card.querySelectorAll('video.media-video, .media-video video, .media-gif-wrapper video'));
  const imageNodes = Array.from(card.querySelectorAll('img.media-photo, .media-photo img, .media-gif-wrapper img, img, canvas[src]'));
  const videoUrls = videoNodes.filter((node) => Boolean(mediaUrl(node)));
  if (kind === 'video' || kind === 'gif') {
    if (videoUrls.length) return videoUrls;
    const wrapper = card.querySelector('.media-video, .media-gif-wrapper');
    return wrapper ? [wrapper] : imageNodes;
  }
  return imageNodes;
}

function toScannedIdentity(record: OriginalMediaRecord, version: 'A' | 'K'): ScannedMediaIdentity {
  const stableKey = record.stableKey || `${stableSidebarKey(version, record.peerId, record.messageId)}:${record.kind}:${record.mediaIndex || 0}`;
  return {
    stableKey,
    version,
    messageId: record.messageId,
    peerId: record.peerId,
    kind: record.kind as ScannedMediaIdentity['kind'],
    monthGroup: record.monthGroup || '',
    dateTimestamp: record.dateTimestamp,
    duration: record.duration || '',
    thumbnail: record.thumbnail || '',
    sidebarKey: record.sidebarKey || stableSidebarKey(version, record.peerId, record.messageId),
    mediaIndex: Math.max(0, Number(record.mediaIndex) || 0),
    hasDownloaded: Boolean(record.hasDownloaded),
  };
}

function aSidebarItems(): OriginalMediaRecord[] {
  const roots = Array.from(document.querySelectorAll('#RightColumn .Media.scroll-item, #RightColumn [id^="shared-mediamessage-"], #RightColumn .shared-media-transition .Transition_slide-active .Media'))
    .filter((node) => node.isConnected && (visible(node) || !node.getBoundingClientRect().width));
  const peerId = activePeerId();
  const out: OriginalMediaRecord[] = [];
  for (const message of roots) {
    const rawId = message.getAttribute('data-message-id') || message.getAttribute('id') || '';
    const monthGroup = message.closest('.message-date-group, .Transition_slide-active')?.querySelector('.sticky-date span, .date-group-label')?.textContent?.trim() || '';
    const nodes = Array.from(message.querySelectorAll('video.full-media, video, img.full-media, img.media-miniature, img, canvas.thumbnail'));
    const indexes = new Map<string, number>();
    const peerId = message.getAttribute('data-peer-id') || activePeerId();
    const sidebarKey = stableSidebarKey('A', peerId, rawId.replace(/^shared-mediamessage-?/, ''));
    for (const node of nodes) {
      const kind = inferKind(node, message);
      const index = indexes.get(kind) || 0;
      const record = recordFromNode(node, message, { monthGroup, mediaIndex: index, sidebarKey });
      if (record) {
        indexes.set(kind, index + 1);
        record.peerId = peerId || record.peerId;
        record.sidebarKey = stableSidebarKey('A', record.peerId, record.messageId);
        record.stableKey = `${record.sidebarKey}:${record.kind}:${index}`;
        out.push(record);
      }
    }
    if (!nodes.length && rawId) {
      const placeholder = message.querySelector('.media-spoiler, .spoiler');
      const thumbnail = message.querySelector('img.thumbnail, img');
      if (placeholder && thumbnail) {
        const record = recordFromNode(thumbnail, message, { monthGroup, mediaIndex: 0, sidebarKey });
        if (record) out.push(record);
      }
    }
  }
  return out;
}

function kSidebarItems(): OriginalMediaRecord[] {
  const containers = Array.from(document.querySelectorAll('.search-super-container-media.active .media-container[data-mid]'));
  const out: OriginalMediaRecord[] = [];
  for (const container of containers) {
    const mid = container.getAttribute('data-mid') || '';
    if (!mid) continue;
    const kind = classifySidebarMedia(container);
    if (!kind || kind === 'audio' || kind === 'file') continue;
    const monthGroup = container.closest('.search-super-month')?.querySelector('.search-super-month-name span')?.textContent?.trim() || '';
    const peerId = container.getAttribute('data-peer-id') || container.closest('[data-peer-id]')?.getAttribute('data-peer-id') || activePeerId();
    const sidebarKey = stableSidebarKey('K', peerId, mid);
    const nodes = kSidebarMediaNodes(container, kind);
    let mediaIndex = 0;
    for (const node of nodes) {
      const record = recordFromNode(node, container, { monthGroup, kind, mediaIndex, sidebarKey });
      if (!record) continue;
      record.messageId = mid;
      record.id = `${mid}:${record.url}`;
      record.peerId = peerId;
      record.sidebarKey = sidebarKey;
      record.mediaIndex = mediaIndex;
      record.stableKey = `${sidebarKey}:${kind}:${mediaIndex}`;
      mediaIndex += 1;
      out.push(record);
    }
    if (!out.some((item) => item.messageId === mid && item.peerId === peerId)) {
      const fallback = kind === 'video' || kind === 'gif'
        ? container.querySelector('img.media-photo, img')
        : container.querySelector('img.media-photo, img, canvas[src]');
      if (fallback) {
        const record = recordFromNode(fallback, container, { monthGroup, kind, mediaIndex: 0, sidebarKey });
        if (record) {
          record.messageId = mid; record.id = `${mid}:${record.url}`; record.peerId = peerId;
          record.sidebarKey = sidebarKey; record.stableKey = `${sidebarKey}:${kind}:0`; record.mediaIndex = 0;
          out.push(record);
        }
      }
    }
  }
  return out;
}

function dedupe(items: OriginalMediaRecord[]): OriginalMediaRecord[] {
  const byMessageAndUrl = new Map<string, OriginalMediaRecord>();
  for (const item of items) byMessageAndUrl.set(`${item.messageId}:${item.url}`, item);
  return [...byMessageAndUrl.values()];
}

export class TelegramMediaResolver {
  private readonly nodesByItem = new Map<string, Element>();

  async prepareAndScan(): Promise<OriginalMediaRecord[]> {
    const version = detectTelegramVersion();
    console.info('[TG Downloader][scan] start', { version, scope: 'visible-sidebar-items' });
    if (version === 'K') await this.prepareKMediaSidebar(8000);
    const items = version === 'K' ? kSidebarItems() : version === 'A' ? aSidebarItems() : [];
    const result = dedupe(items);
    console.info('[TG Downloader][scan] complete', { version, count: result.length });
    return result;
  }

  async prepareVisibleIdentities(): Promise<ScannedMediaIdentity[]> {
    const version = detectTelegramVersion();
    if (version === 'K') await this.prepareKMediaSidebar(8000);
    else if (version === 'A') await this.openChannelMedia();
    return this.currentSidebarIdentities(version);
  }

  async loadAllScannedIdentities(timeoutMs = 45000): Promise<ScannedMediaIdentity[]> {
    const version = detectTelegramVersion();
    if (version === 'K') await this.prepareKMediaSidebar(8000);
    else if (version === 'A') await this.openChannelMedia();
    if (version !== 'A' && version !== 'K') return [];

    const scrollRoot = version === 'K' ? this.findKScrollRoot() : this.findAScrollRoot();
    if (!scrollRoot) {
      console.warn(`[TG Downloader][scan] ${version} media-list scroll root unavailable; using currently loaded identities`);
      return this.currentSidebarIdentities(version);
    }

    const originalTop = scrollRoot.scrollTop;
    const deadline = Date.now() + timeoutMs;
    const collected = new Map<string, ScannedMediaIdentity>();
    const collect = () => {
      for (const item of this.currentSidebarIdentities(version)) collected.set(item.stableKey, item);
    };
    let stableAtBottom = 0;
    try {
      scrollRoot.scrollTop = 0;
      await sleep(350);
      collect();
      while (Date.now() < deadline && stableAtBottom < 3) {
        const beforeCount = collected.size;
        const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 8;
        scrollRoot.scrollTop = atBottom
          ? scrollRoot.scrollHeight
          : Math.min(scrollRoot.scrollHeight, scrollRoot.scrollTop + Math.max(180, Math.floor(scrollRoot.clientHeight * 0.48)));
        await sleep(atBottom ? 520 : 320);
        collect();
        const nowAtBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 8;
        stableAtBottom = nowAtBottom && collected.size === beforeCount ? stableAtBottom + 1 : 0;
      }
    } finally {
      scrollRoot.scrollTop = originalTop;
    }
    return [...collected.values()];
  }

  private currentSidebarIdentities(version: 'A' | 'K' | 'unknown'): ScannedMediaIdentity[] {
    if (version === 'unknown') return [];
    const records = version === 'K' ? kSidebarItems() : aSidebarItems();
    const identities = new Map<string, ScannedMediaIdentity>();
    for (const record of records) {
      if (record.kind !== 'image' && record.kind !== 'video' && record.kind !== 'gif') continue;
      const identity = toScannedIdentity(record, version);
      identities.set(identity.stableKey, identity);
    }
    return [...identities.values()];
  }

  async loadAllMedia(timeoutMs = 45000): Promise<ScannedMediaIdentity[]> {
    return this.loadAllScannedIdentities(timeoutMs);
  }

  async openChannelMedia(): Promise<boolean> {
    const version = detectTelegramVersion();
    const timeoutMs = 8000;
    const deadline = Date.now() + timeoutMs;
    console.info('[TG Downloader][channel-info] checking current chat information');
    if (version === 'A') return this.openASharedMedia(deadline);
    if (version !== 'K') {
      console.warn('[TG Downloader][channel-info] Telegram layout was not recognized', { version });
      return false;
    }
    const isMediaActive = () => {
      const panel = document.querySelector('#column-right .search-super-container-media.active');
      return this.isKSidebarProfileOpen() && Boolean(panel && visible(panel));
    };
    if (document.querySelector('.media-viewer-whole.active, .media-viewer-whole.is-visible')) {
      console.info('[TG Downloader][channel-info] media viewer is open; leaving current viewer unchanged');
      return false;
    }
    if (isMediaActive()) {
      console.info('[TG Downloader][media-tab] already active');
      return true;
    }
    if (!this.isKSidebarProfileOpen()) {
      const topbar = document.querySelector('#column-center .topbar') || document.querySelector('#column-center .sidebar-header.topbar');
      const targets = [
        topbar?.querySelector<HTMLElement>('.chat-info'),
        '#column-center .topbar .chat-info', '#column-center .sidebar-header.topbar .chat-info',
        '#column-center .chat-info-container .chat-info', '#column-center .chat-info-container',
        '#column-center .sidebar-header.topbar .chat-info', '#column-center .topbar .chat-info',
        '#column-center .chat-info .avatar', '#column-center .chat-info .peer-title', '#column-center .topbar .peer-title',
      ].map((selector) => typeof selector === 'string' ? document.querySelector<HTMLElement>(selector) : selector).filter(Boolean) as HTMLElement[];
      const target = targets[0];
      if (!target) {
        console.warn('[TG Downloader][channel-info] current chat header was not found');
        return false;
      }
      await this.clickTelegramTab(target);
      while (Date.now() < deadline && !this.isKSidebarProfileOpen()) await sleep(120);
    }
    if (!this.isKSidebarProfileOpen() || !document.querySelector('#column-right .search-super')) {
      console.warn('[TG Downloader][channel-info] Channel Info did not open before timeout');
      return false;
    }
    console.info('[TG Downloader][channel-info] opened');
    if (isMediaActive()) {
      console.info('[TG Downloader][media-tab] already active');
      return true;
    }
    console.info('[TG Downloader][media-tab] activating');
    if (await this.clickKMediaSubtitle()) return true;
    const tabsMenu = this.getKTabsMenu();
    const mediaTab = tabsMenu ? Array.from(tabsMenu.querySelectorAll<HTMLElement>('.menu-horizontal-div-item'))
      .find((tab) => !tab.classList.contains('hide') && this.isKMediaLabel(this.kTabLabel(tab))) : null;
    if (mediaTab) {
      await this.clickTelegramTab(mediaTab);
      await sleep(500);
      if (isMediaActive()) return true;
    }
    const tabsContainer = document.querySelector('#column-right .search-super .search-super-tabs-container');
    const mediaPanel = tabsContainer?.querySelector('.search-super-container-media');
    const panelIndex = mediaPanel && tabsContainer ? Array.from(tabsContainer.children).indexOf(mediaPanel) : -1;
    const visibleTabs = tabsMenu ? Array.from(tabsMenu.querySelectorAll<HTMLElement>('.menu-horizontal-div-item')).filter((tab) => !tab.classList.contains('hide')) : [];
    const indexedTab = panelIndex >= 0 ? visibleTabs[panelIndex] : undefined;
    if (indexedTab && this.isKMediaLabel(this.kTabLabel(indexedTab))) {
      await this.clickTelegramTab(indexedTab);
      await sleep(500);
    }
    while (Date.now() < deadline && !isMediaActive()) await sleep(120);
    const active = isMediaActive();
    if (!active) console.warn('[TG Downloader][media-tab] Media tab did not activate before timeout');
    else console.info('[TG Downloader][media-tab] active', { loaded: document.querySelectorAll('.search-super-container-media.active .media-container[data-mid]').length });
    return active;
  }

  private isKSidebarProfileOpen(): boolean {
    const column = document.querySelector('#column-right');
    const panel = document.querySelector('#column-right .shared-media-container.profile-container.active, #column-right .sidebar-slider-item.profile-container.active, #column-right .profile-container.active');
    return Boolean(column && visible(column) && panel && visible(panel));
  }

  private getKTabsMenu(): Element | null {
    const root = document.querySelector('#column-right .search-super');
    return root?.querySelector('.search-super-tabs.menu-horizontal-div, .search-super-nav-scrollable .search-super-tabs, .search-super-tabs-scrollable .menu-horizontal-div') || null;
  }

  private kTabLabel(tab: Element): string {
    return (tab.querySelector('.menu-horizontal-div-item-span')?.textContent || tab.textContent || '').trim();
  }

  private isKMediaLabel(label: string): boolean {
    return /^media\b/i.test(label.trim()) || /媒体|媒體|медиа|メディア|미디어/i.test(label);
  }

  private async clickKMediaSubtitle(): Promise<boolean> {
    const items = Array.from(document.querySelectorAll<HTMLElement>('#column-right .sidebar-header__subtitle .transition-item'));
    for (const item of items) {
      const text = (item.textContent || '').trim();
      if (!/\d/.test(text) || !/(media|媒体|媒體|média|medien|медиа|メディア|미디어|medio|mídia)/i.test(text)) continue;
      await this.clickTelegramTab(item);
      await sleep(500);
      const mediaPanel = document.querySelector('#column-right .search-super-container-media.active');
      if (this.isKSidebarProfileOpen() && mediaPanel && visible(mediaPanel)) {
        console.info('[TG Downloader][media-tab] activated from Channel Info subtitle');
        return true;
      }
    }
    return false;
  }

  private async clickTelegramTab(tab: HTMLElement): Promise<void> {
    tab.scrollIntoView({ block: 'nearest', inline: 'center' });
    const target = tab.classList.contains('menu-horizontal-div-item') ? tab : tab.closest<HTMLElement>('.menu-horizontal-div-item') || tab;
    const clickTarget = target.querySelector<HTMLElement>('.menu-horizontal-div-item-span, .Tab_inner') || target;
    const rect = clickTarget.getBoundingClientRect();
    const clientX = rect.left + Math.max(1, rect.width / 2);
    const clientY = rect.top + Math.max(1, rect.height / 2);
    const pointer = { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    clickTarget.dispatchEvent(new PointerEvent('pointerdown', pointer));
    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 }));
    clickTarget.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 0 }));
    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 0 }));
    clickTarget.click();
    target.click();
  }

  private async openASharedMedia(deadline: number): Promise<boolean> {
    const root = document.querySelector('#RightColumn');
    const activeTab = root?.querySelector('.shared-media-tabs .TabList .Tab--active, [role="tab"][aria-selected="true"]');
    if (root && activeTab && /media|媒体|媒體/i.test(activeTab.textContent || '')) return true;
    if (!root) {
      const target = document.querySelector<HTMLElement>('.MiddleHeader .chat-info-wrapper, .MiddleHeader .ChatInfo, .MiddleHeader .chat-info');
      if (!target) return false;
      target.click();
      while (Date.now() < deadline && !document.querySelector('#RightColumn')) await sleep(120);
    }
    const mediaTab = Array.from(document.querySelectorAll<HTMLElement>(
      '#RightColumn [role="tab"], #RightColumn .Tab, #RightColumn .TabList > *, #RightColumn .shared-media-tabs > *',
    )).find((element) => /^(media|shared media|媒体|媒體)$/i.test(element.textContent?.replace(/\s+/g, ' ').trim() || ''));
    if (mediaTab) mediaTab.click();
    while (Date.now() < deadline) {
      const selected = document.querySelector('#RightColumn [role="tab"][aria-selected="true"], #RightColumn .Tab--active, #RightColumn .shared-media-tabs [aria-hidden="true"]');
      if (selected && /media|媒体|媒體/i.test(selected.textContent || '')) return true;
      if (document.querySelector('#RightColumn .Media.scroll-item, #RightColumn [id^="shared-mediamessage-"]')) return true;
      await sleep(120);
    }
    return false;
  }

  async resolveSidebarItem(messageId: string, preferredUrl?: string, force = true, onResolvedBeforeViewerClose?: (item: MediaItem) => Promise<void> | void): Promise<OriginalMediaRecord[]> {
    const container = this.findSidebarItem(messageId) || await this.locateKSidebarItem(messageId);
    if (!container) return [];
    const freshItems = kSidebarItems().filter((item) => item.messageId === messageId);
    const fresh = preferredUrl ? freshItems.filter((item) => item.url === preferredUrl) : freshItems;
    const currentUrl = fresh[0]?.url || freshItems[0]?.url || preferredUrl || '';
    const current = fresh.length ? fresh : await this.resolveMessage(messageId, currentUrl || undefined);
    if (!force || !current.length) return current;
    return this.resolveForce(messageId, currentUrl || undefined, onResolvedBeforeViewerClose, current[0]?.kind, container, {
      pinKViewerVideo: detectTelegramVersion() === 'K' && current[0]?.kind === 'video',
    });
  }

  async readSingleDownloadBaseline(): Promise<SingleDownloadCandidate[]> {
    return (await this.readRecentPageMediaUrls(0)).map((candidate) => ({
      url: candidate.url,
      source: candidate.source || 'bridge',
      capturedAt: candidate.capturedAt || 0,
      mimeType: candidate.contentType || '',
      objectUrlKind: candidate.objectUrlKind as MediaItem['objectUrlKind'],
      origin: 'bridge' as const,
    }));
  }

  private async waitForKActiveViewerMediaReady(
    viewer: Element,
    original: OriginalMediaRecord,
    session: AttachmentSession,
    forcedVideoIntent = false,
  ): Promise<ActiveViewerMediaReadyResult<KActiveViewerSnapshot>> {
    const preflightCache = new Map<string, KViewerHttpPreflightResult>();
    const preflight = async (candidate: KViewerHttpCandidate) => {
      let response = preflightCache.get(candidate.url);
      if (!response) {
        response = await this.preflightKViewerHttpCandidate(candidate);
        preflightCache.set(candidate.url, response);
      }
      return response;
    };
    return waitForActiveViewerMediaReady(async () => {
      const scope = getActiveViewerMediaScope(viewer);
      const visibleImages = viewerScopeNodes<HTMLImageElement>(scope.root, 'img')
        .filter((image) => visible(image) && !image.closest('.spoilers-container, .media-spoiler'));
      const visibleVideos = viewerScopeNodes<HTMLVideoElement>(scope.root, 'video').filter(visible);
      const current = this.readKViewerMedia(viewer, original);
      const candidateSet = await this.readKViewerCandidateSet(viewer, session.startedAt, false, session.baselineUrls);
      const allCandidates = [...candidateSet.menu, ...candidateSet.viewer, ...candidateSet.captured, ...candidateSet.performance];
      const mediaSourceCount = allCandidates.filter((candidate) => candidate.objectUrlKind === 'media-source').length;
      const videoWithSrcCount = visibleVideos.filter((video) => Boolean(mediaUrl(video))).length;
      const directVideoEvidence = forcedVideoIntent || activeViewerHasVideo(viewer) || current?.kind === 'video' || mediaSourceCount > 0 ||
        allCandidates.some((candidate) => /^(video|audio)\//i.test(candidate.contentType || ''));
      let verifiedVideoEvidence = false;
      if (!directVideoEvidence) {
        const httpVideo = allCandidates.find((candidate) => allowedKViewerHttpUrl(candidate.url) &&
          /\/(progressive|stream|download)\//i.test(candidate.url));
        if (httpVideo) {
          const response = await preflight(httpVideo);
          verifiedVideoEvidence = !kViewerProbeRejectReason(response);
        }
      }

      const rawImages = this.readSingleViewerImages(viewer, session.attachmentIndex, directVideoEvidence || verifiedVideoEvidence, false);
      const viewerImages: SingleDownloadCandidate[] = [];
      for (const image of rawImages) {
        if (image.url.startsWith('blob:')) {
          viewerImages.push(image);
          continue;
        }
        if (!allowedKViewerHttpUrl(image.url)) continue;
        const response = await preflight({ url: image.url, source: 'active-viewer-image', activeViewerMainMedia: true });
        const verified = verifiedActiveViewerHttpImage(image, response);
        if (verified) viewerImages.push(verified);
      }

      const snapshot: KActiveViewerSnapshot = {
        current,
        viewerImages,
        candidateSet,
        scopeReason: scope.reason,
        rootTag: scope.root.tagName.toLowerCase(),
        ownsCurrentAttachment: scope.ownsCurrentAttachment,
        visibleImageCount: visibleImages.length,
        loadedImageCount: visibleImages.filter((image) => image.naturalWidth > 0 && image.naturalHeight > 0).length,
        visibleVideoCount: visibleVideos.length,
        videoWithSrcCount,
        bridgeCandidateCount: candidateSet.captured.length,
        performanceCandidateCount: candidateSet.performance.length,
        mediaSourceCount,
      };
      if (directVideoEvidence || verifiedVideoEvidence) return { kind: 'video' as const, snapshot };
      if (viewerImages.length) return { kind: 'image' as const, snapshot };
      return { kind: null, snapshot };
    }, 3200, 120, (ms) => sleep(ms).then(() => undefined));
  }

  private cardHasVideoIntent(attachment: Element): boolean {
    if (attachment.matches('video, .media-video, .video-time, .video-play') ||
        attachment.querySelector('video, .media-video, .video-time, .video-play')) return true;
    return this.readCardLocalVideoSources(attachment).length > 0;
  }

  private readCardLocalVideoSources(attachment: Element): KViewerHttpCandidate[] {
    const videos = [
      ...(attachment.matches('video') ? [attachment as HTMLVideoElement] : []),
      ...Array.from(attachment.querySelectorAll<HTMLVideoElement>('video')),
    ];
    const sources = [
      ...(attachment.matches('source[src]') ? [attachment as HTMLSourceElement] : []),
      ...Array.from(attachment.querySelectorAll<HTMLSourceElement>('video source[src]')),
    ];
    const candidates: KViewerHttpCandidate[] = [];
    for (const video of videos) {
      const contentType = video.getAttribute('type') || video.getAttribute('data-mime-type') || '';
      for (const rawSrc of [video.currentSrc, video.getAttribute('src') || '']) {
        const url = normalizeCardLocalMediaUrl(rawSrc);
        if (url) candidates.push({ url, source: 'card-local', contentType, trustedMediaElement: true });
      }
    }
    for (const source of sources) {
      const url = normalizeCardLocalMediaUrl(source.getAttribute('src') || '');
      if (url) candidates.push({
        url, source: 'card-local', contentType: source.getAttribute('type') || source.getAttribute('data-mime-type') || '',
        trustedMediaElement: true,
      });
    }
    return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  }

  private async resolveCardLocalVideo(
    attachment: Element,
    original: OriginalMediaRecord,
    session: AttachmentSession,
  ): Promise<OriginalMediaRecord | null> {
    const candidates = this.readCardLocalVideoSources(attachment);
    if (!candidates.length) {
      console.info('[TG Downloader][single-download] card-source', {
        attachmentIndex: session.attachmentIndex, sourceType: 'none', owned: true, preflight: 'not-run',
      });
      return null;
    }
    for (const candidate of candidates) {
      const response = await this.preflightKViewerHttpCandidate(candidate);
      const sourceType = kViewerHttpPathClass(candidate.url);
      const streamRejected = sourceType === 'stream' &&
        (response.standalonePlayable !== true || response.fragmented === true);
      const rejected = kViewerProbeRejectReason(response) || (streamRejected ? response.containerRejectReason || 'MEDIA_CONTAINER_NOT_STANDALONE' : '');
      console.info('[TG Downloader][single-download] card-source', {
        attachmentIndex: session.attachmentIndex, sourceType, owned: true, preflight: rejected ? 'fail' : 'pass',
      });
      if (rejected || !response.finalUrl) continue;
      const metadata = parseCardLocalStreamMetadata(candidate.url);
      const mimeType = (response.contentType || metadata.mimeType || original.mimeType).split(';', 1)[0].trim();
      const resolvedAt = Date.now();
      return enrichCapturedMedia({
        ...original,
        id: `${session.messageId}:${response.finalUrl}`,
        url: response.finalUrl,
        filename: safeFilename(metadata.fileName || filenameFromUrl(response.finalUrl, 'video')),
        mimeType,
        size: metadata.size || (response.status === 200 ? Number(response.contentLength) || 0 : 0),
        kind: 'video' as const,
        source: 'fetch' as const,
        capturedAt: resolvedAt,
        requiresPageTransport: true,
        kSingleVideo: { viewerOpenMs: 0, candidateDiscoveryMs: 0, probeMs: 0, resolvedAt },
      });
    }
    return null;
  }

  private async activateCardLocalVideo(
    attachment: Element,
    original: OriginalMediaRecord,
    session: AttachmentSession,
  ): Promise<OriginalMediaRecord | null> {
    const play = attachment.matches('.video-play') ? attachment as HTMLElement : attachment.querySelector<HTMLElement>('.video-play');
    if (!play) {
      console.info('[TG Downloader][single-download] card-video-activate', {
        attachmentIndex: session.attachmentIndex, playButtonFound: false, videoAppeared: false, sourceAppeared: false,
      });
      return null;
    }
    const attemptedUrls = new Set(this.readCardLocalVideoSources(attachment).map((candidate) => candidate.url));
    play.click();
    const deadline = Date.now() + 2800;
    let videoAppeared = false;
    let resolved: OriginalMediaRecord | null = null;
    while (Date.now() < deadline) {
      videoAppeared ||= attachment.matches('video') || Boolean(attachment.querySelector('video'));
      const sources = this.readCardLocalVideoSources(attachment);
      if (sources.some((candidate) => !attemptedUrls.has(candidate.url))) {
        resolved = await this.resolveCardLocalVideo(attachment, original, session);
        sources.forEach((candidate) => attemptedUrls.add(candidate.url));
        if (resolved) break;
      }
      await sleep(120);
    }
    console.info('[TG Downloader][single-download] card-video-activate', {
      attachmentIndex: session.attachmentIndex,
      playButtonFound: true,
      videoAppeared,
      sourceAppeared: Boolean(resolved || this.readCardLocalVideoSources(attachment).length),
    });
    return resolved;
  }

  async resolveSingleAttachment(
    session: AttachmentSession,
    onResolvedBeforeViewerClose: (item: MediaItem) => Promise<void>,
  ): Promise<OriginalMediaRecord> {
    const version = detectTelegramVersion();
    const message = session.activationElement.closest(messageSelector()) || session.activationElement;
    const mediaNode = session.activationElement.matches('img, video, canvas, source')
      ? session.activationElement
      : session.activationElement.querySelector('video, img, canvas, source') || session.activationElement;
    const initialUrl = mediaUrl(mediaNode);
    const original: OriginalMediaRecord = recordFromNode(mediaNode, message, { fallbackUrl: initialUrl || undefined }) || {
      id: `${session.messageId}:attachment-${session.attachmentIndex}`,
      url: initialUrl,
      filename: `telegram-media-${session.messageId}-${session.attachmentIndex + 1}.bin`,
      mimeType: 'application/octet-stream',
      size: 0,
      kind: 'file',
      messageId: session.messageId,
      peerId: activePeerId(),
      fileId: '',
      source: 'dom',
      capturedAt: session.startedAt,
      monthGroup: '',
      hasDownloaded: false,
    };
    original.messageId = session.messageId;
    const videoIntent = this.cardHasVideoIntent(session.activationElement);
    const directCardVideo = await this.resolveCardLocalVideo(session.activationElement, original, session);
    if (directCardVideo) {
      await onResolvedBeforeViewerClose(directCardVideo);
      return directCardVideo;
    }
    if (videoIntent) {
      const activatedCardVideo = await this.activateCardLocalVideo(session.activationElement, original, session);
      if (activatedCardVideo) {
        await onResolvedBeforeViewerClose(activatedCardVideo);
        return activatedCardVideo;
      }
    }
    const bridgeStatus = await this.readPageBridgeStatus();
    const captureSession: KViewerCaptureSession = {
      viewerOpenRequestAt: session.startedAt,
      bridgeStatus,
      bridgeInstalledBeforeViewer: Boolean(bridgeStatus && bridgeStatus.bridgeInstalledAt <= session.startedAt),
      baselineUrls: session.baselineUrls,
    };
    let viewer: Element | null = null;
    let closed = false;
    const close = async () => {
      if (!viewer || closed) return;
      const didClose = await this.closeViewer(version, viewer);
      if (didClose) {
        closed = true;
        return;
      }
      const error = Object.assign(new Error('Viewer 关闭操作后仍保持可见'), { code: 'SINGLE_DOWNLOAD_VIEWER_CLOSE_FAILED' });
      console.error(formatErrorLog('[TG Downloader][single-download] viewer-close-failed', error, {
        messageId: session.messageId,
        attachmentIndex: session.attachmentIndex,
        scope: version === 'K' ? 'media-viewer-whole' : 'MediaViewer',
      }));
      throw error;
    };
    console.info('[TG Downloader][single-download] activate', {
      messageId: session.messageId, sessionId: session.sessionId,
      attachmentIndex: session.attachmentIndex, attachmentKey: session.attachmentKey,
    });
    try {
      const target = session.activationElement.querySelector<HTMLElement>('.media-inner, .media-photo, .media-video') ||
        session.activationElement as HTMLElement;
      target.click();
      viewer = await this.waitForViewer(version, 3000);
      console.info('[TG Downloader][single-download] viewer/player-active', {
        messageId: session.messageId, sessionId: session.sessionId,
        attachmentIndex: session.attachmentIndex, active: Boolean(viewer),
      });
      if (!viewer) {
        throw Object.assign(new Error('附件激活后未出现 Viewer'), { code: 'SINGLE_DOWNLOAD_VIEWER_TIMEOUT' });
      }

      const readiness = version === 'K' ? await this.waitForKActiveViewerMediaReady(viewer, original, session, videoIntent) : null;
      const activeViewerMedia = readiness?.snapshot.current ||
        (version === 'K' ? this.readKViewerMedia(viewer, original) : this.readViewerMedia(viewer, original));
      const viewerHasActiveVideo = readiness?.kind === 'video' || activeViewerHasVideo(viewer) || activeViewerMedia?.kind === 'video';
      if (version === 'K' && viewerHasActiveVideo) {
        const resolved = await this.resolveKViewerSidebarVideo(viewer, original, captureSession, { allowNativeFallback: false });
        console.info('[TG Downloader][single-download] source-selected', {
          messageId: session.messageId, sessionId: session.sessionId, attachmentIndex: session.attachmentIndex,
          sourceType: singleCandidateSourceType(resolved), mime: resolved.mimeType || '', route: 'k-single-video',
        });
        await onResolvedBeforeViewerClose(resolved);
        await close();
        return resolved;
      }

      const preflightCache = new Map<string, KViewerHttpPreflightResult>();
      const firstWait = version === 'K'
        ? {
            candidate: null,
            polls: 1,
            weakCandidateCount: 0,
            rejectedCandidates: [],
            ...(readiness?.snapshot.candidateSet || { menu: [], viewer: [], captured: [], performance: [] }),
          }
        : await waitForKViewerHttpSource(
          () => this.readKViewerCandidateSet(viewer!, session.startedAt, false, session.baselineUrls),
          2800,
          120,
          (ms) => sleep(ms).then(() => undefined),
          (candidate) => this.preflightKViewerHttpCandidate(candidate),
          preflightCache,
        );
      const viewerHasVideo = version === 'K' ? false : viewerHasActiveVideo ||
        [...firstWait.captured, ...firstWait.viewer, ...firstWait.performance].some((candidate) =>
          candidate.objectUrlKind === 'media-source' || /^(video|audio)\//i.test(candidate.contentType || '') ||
          /\/(progressive|stream|download)\//i.test(candidate.url));
      const candidates: SingleDownloadCandidate[] = [];
      if (firstWait.candidate) {
        candidates.push({
          url: firstWait.candidate.url,
          source: firstWait.candidate.source || 'page-capture',
          capturedAt: firstWait.candidate.capturedAt || Date.now(),
          mimeType: firstWait.candidate.verifiedContentType || firstWait.candidate.contentType || '',
          objectUrlKind: firstWait.candidate.objectUrlKind as MediaItem['objectUrlKind'],
          origin: firstWait.candidate.source === 'performance-resource' ? 'performance' : 'bridge',
          validated: true,
          activeViewerMainMedia: firstWait.candidate.activeViewerMainMedia === true || firstWait.candidate.trustedQualityMenu === true,
        });
      }
      const viewerScope = getActiveViewerMediaScope(viewer);
      const viewerImages = readiness?.snapshot.viewerImages ||
        this.readSingleViewerImages(viewer, session.attachmentIndex, viewerHasVideo);
      for (const image of viewerImages) console.info('[TG Downloader][single-download] viewer-image-candidate', {
        attachmentIndex: session.attachmentIndex,
        hasUrl: Boolean(image.url),
        urlType: image.url.startsWith('blob:') ? 'blob' : /^https?:/i.test(image.url) ? 'http' : 'other',
        mime: image.mimeType || '',
        naturalWidth: image.width || 0,
        naturalHeight: image.height || 0,
        activeViewerMainMedia: image.activeViewerMainMedia === true,
        kindHint: image.kindHint || 'n/a',
      });
      const imageCount = viewerScopeNodes<HTMLElement>(viewerScope.root, 'img').filter(visible).length;
      const videoCount = viewerScopeNodes<HTMLElement>(viewerScope.root, 'video').filter(visible).length;
      console.info('[TG Downloader][single-download] active-scope', {
        messageId: session.messageId,
        attachmentIndex: session.attachmentIndex,
        scopeReason: viewerScope.reason,
        rootTag: viewerScope.root.tagName.toLowerCase(),
        ownsCurrentAttachment: viewerScope.ownsCurrentAttachment,
        imageCount,
        videoCount,
      });
      for (const image of viewerImages) candidates.push(image);
      const current = activeViewerMedia || (version === 'K' ? null : this.readViewerMedia(viewer, original));
      let imageAdoptFailure: PinnedViewerBlob | undefined;
      if (current?.url.startsWith('blob:')) {
        const captured = firstWait.captured.find((candidate) => candidate.url === current.url);
        if (captured?.objectUrlKind === 'media-source') {
          candidates.push({
            url: current.url, source: captured.source || 'object-url', capturedAt: captured.capturedAt || Date.now(),
            mimeType: captured.contentType || current.mimeType, objectUrlKind: 'media-source', origin: 'bridge',
            trustedMainMedia: true, activeViewerMainMedia: true,
          });
        } else {
          const pinned = await this.pinKViewerBlob(current.url, session.messageId, captureSession);
          if (pinned.ok && pinned.leaseId && pinned.objectUrlKind === 'blob' && Number(pinned.size) > 0) {
            candidates.push({
              url: current.url, source: 'pinned-blob', capturedAt: Date.now(), mimeType: pinned.mimeType || current.mimeType,
              objectUrlKind: 'blob', origin: 'viewer', trustedMainMedia: true, activeViewerMainMedia: true,
              ...(current.kind === 'image' ? { kindHint: 'image' as const } : {}), validated: true,
            });
            current.blobLeaseId = pinned.leaseId;
            current.objectUrlKind = 'blob';
            current.size = Number(pinned.size) || current.size;
            current.mimeType = pinned.mimeType || current.mimeType;
          } else if (pinned.objectUrlKind === 'media-source') {
            candidates.push({
              url: current.url, source: 'object-url', capturedAt: Date.now(), mimeType: pinned.mimeType || '',
              objectUrlKind: 'media-source', origin: 'viewer', trustedMainMedia: true, activeViewerMainMedia: true,
            });
          } else {
            const activeImage = viewerImages.find((image) => image.url === current.url &&
              image.activeViewerMainMedia === true && image.kindHint === 'image');
            if (activeImage && viewerScope.ownsCurrentAttachment && !viewerHasVideo && current.kind === 'image') {
              const adopted = await this.adoptActiveImageBlob(current.url, session.messageId, session.attachmentIndex);
              console.info('[TG Downloader][single-download] image-blob-adopt', {
                attachmentIndex: session.attachmentIndex,
                adopt: adopted.ok ? 'pass' : 'fail',
                size: Number(adopted.size) || 0,
                mime: adopted.mimeType || '',
                code: adopted.code || 'n/a',
              });
              if (adopted.ok && adopted.leaseId && adopted.objectUrlKind === 'blob' && Number(adopted.size) > 0) {
                candidates.push({
                  ...activeImage,
                  source: 'pinned-blob',
                  capturedAt: Date.now(),
                  mimeType: adopted.mimeType || activeImage.mimeType,
                  objectUrlKind: 'blob',
                  validated: true,
                });
                current.blobLeaseId = adopted.leaseId;
                current.objectUrlKind = 'blob';
                current.size = Number(adopted.size) || 0;
                current.mimeType = adopted.mimeType || current.mimeType;
              } else {
                imageAdoptFailure = adopted;
              }
            }
          }
        }
      }

      console.info('[TG Downloader][single-download] candidates', {
        messageId: session.messageId, sessionId: session.sessionId, attachmentIndex: session.attachmentIndex,
        count: firstWait.menu.length + firstWait.viewer.length + firstWait.captured.length + firstWait.performance.length + viewerImages.length,
        sourceTypes: [...new Set([
          ...candidates.map((candidate) => singleCandidateSourceType(candidate)),
          ...firstWait.menu.map((candidate) => kViewerHttpPathClass(candidate.url)),
          ...firstWait.viewer.map((candidate) => kViewerHttpPathClass(candidate.url)),
          ...firstWait.captured.map((candidate) => candidate.objectUrlKind === 'media-source' ? 'media-source' :
            candidate.url.startsWith('blob:') ? 'blob' : kViewerHttpPathClass(candidate.url)),
          ...firstWait.performance.map((candidate) => kViewerHttpPathClass(candidate.url)),
        ])],
      });
      for (const rejection of firstWait.rejectedCandidates) {
        console.info('[TG Downloader][single-download] candidate-rejected', {
          messageId: session.messageId, sessionId: session.sessionId, attachmentIndex: session.attachmentIndex,
          reason: rejection.code, sourceType: rejection.source || 'unknown', mime: rejection.contentType || '',
        });
      }
      let decision = selectSingleDownloadCandidate(candidates, session, viewerHasVideo);
      for (const rejection of decision.rejected) {
        console.info('[TG Downloader][single-download] candidate-rejected', {
          messageId: session.messageId, sessionId: session.sessionId, attachmentIndex: session.attachmentIndex,
          reason: rejection.reason, sourceType: singleCandidateSourceType(rejection.candidate), mime: rejection.candidate.mimeType || '',
        });
      }

      if (!decision.selected || !decision.kind) {
        const rejectedReasons = decision.rejected.reduce<Record<string, number>>((counts, rejection) => {
          counts[rejection.reason] = (counts[rejection.reason] || 0) + 1;
          return counts;
        }, {});
        const snapshot = readiness?.snapshot;
        console.error('[TG Downloader][single-download] unresolved-summary ' + [
          `messageId=${session.messageId}`,
          `attachmentIndex=${session.attachmentIndex}`,
          `version=${version}`,
          'viewerFound=true',
          `scopeReason=${snapshot?.scopeReason || viewerScope.reason}`,
          `rootTag=${snapshot?.rootTag || viewerScope.root.tagName.toLowerCase()}`,
          `ownsCurrentAttachment=${snapshot?.ownsCurrentAttachment ?? viewerScope.ownsCurrentAttachment}`,
          `visibleImageCount=${snapshot?.visibleImageCount ?? imageCount}`,
          `loadedImageCount=${snapshot?.loadedImageCount ?? viewerImages.length}`,
          `visibleVideoCount=${snapshot?.visibleVideoCount ?? videoCount}`,
          `videoWithSrcCount=${snapshot?.videoWithSrcCount ?? 0}`,
          `bridgeCandidateCount=${snapshot?.bridgeCandidateCount ?? firstWait.captured.length}`,
          `performanceCandidateCount=${snapshot?.performanceCandidateCount ?? firstWait.performance.length}`,
          `mediaSourceCount=${snapshot?.mediaSourceCount ?? 0}`,
          `acceptedCandidateCount=${Math.max(0, candidates.length - decision.rejected.length)}`,
          `rejectedReasons=${JSON.stringify(rejectedReasons)}`,
        ].join(' '));
        const code = imageAdoptFailure?.code || 'SINGLE_DOWNLOAD_SOURCE_UNRESOLVED';
        throw Object.assign(new Error(imageAdoptFailure?.error || '当前附件没有可验证的媒体来源'), { code });
      }
      const selected = decision.selected;
      const resolved: OriginalMediaRecord = enrichCapturedMedia({
        ...original,
        id: `${session.messageId}:${selected.url}`,
        url: selected.url,
        filename: safeFilename(filenameFromUrl(selected.url, decision.kind)),
        mimeType: selected.mimeType || original.mimeType,
        kind: decision.kind,
        source: selected.url.startsWith('blob:') ? 'blob' : selected.origin === 'viewer' ? 'dom' : 'fetch',
        capturedAt: selected.capturedAt,
        objectUrlKind: selected.objectUrlKind,
        blobLeaseId: selected.url === current?.url ? current?.blobLeaseId : undefined,
        size: selected.url === current?.url ? current?.size || 0 : 0,
      });
      console.info('[TG Downloader][single-download] source-selected', {
        messageId: session.messageId, sessionId: session.sessionId, attachmentIndex: session.attachmentIndex,
        sourceType: singleCandidateSourceType(selected), mime: resolved.mimeType || '',
      });
      await onResolvedBeforeViewerClose(resolved);
      await close();
      return resolved;
    } finally {
      await close();
    }
  }

  private readSingleViewerImages(
    viewer: Element,
    attachmentIndex = -1,
    viewerHasVideo = false,
    logCandidates = true,
  ): SingleDownloadCandidate[] {
    const scope = getActiveViewerMediaScope(viewer);
    return viewerScopeNodes<HTMLImageElement>(scope.root, 'img').flatMap((image) => {
      if (!visible(image)) return [];
      const url = image.currentSrc || image.src || image.getAttribute('src') || '';
      const mime = image.getAttribute('type') || image.getAttribute('data-mime-type') ||
        (/\.png(?:$|[?#])/i.test(url) ? 'image/png' : /\.webp(?:$|[?#])/i.test(url) ? 'image/webp' :
          /\.gif(?:$|[?#])/i.test(url) ? 'image/gif' : /\.jpe?g(?:$|[?#])/i.test(url) ? 'image/jpeg' : '');
      const mainImage = scope.ownsCurrentAttachment && !image.closest('.spoilers-container, .media-spoiler') &&
        (image.naturalWidth || 0) > 0 && (image.naturalHeight || 0) > 0 && !viewerHasVideo;
      if (logCandidates) console.info('[TG Downloader][single-download] viewer-image-candidate', {
          attachmentIndex,
          hasUrl: Boolean(url),
          urlType: url.startsWith('blob:') ? 'blob' : /^https?:/i.test(url) ? 'http' : 'other',
          mime: mime || '',
          naturalWidth: image.naturalWidth || 0,
          naturalHeight: image.naturalHeight || 0,
          activeViewerMainMedia: mainImage,
          kindHint: mainImage ? 'image' : 'n/a',
        });
      if (!url || !mainImage) return [];
      return [{
        url, source: 'viewer-image', capturedAt: Date.now(), mimeType: mime,
        origin: 'viewer' as const,
        trustedMainMedia: true,
        activeViewerMainMedia: true,
        kindHint: 'image' as const,
        width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0,
      }];
    });
  }

  async resolveMessage(messageId: string, preferredUrl?: string): Promise<OriginalMediaRecord[]> {
    let message = Array.from(document.querySelectorAll(messageSelector())).find((node) => getMessageId(node) === messageId) || null;
    let nodes = message ? mediaElements(message) : [];
    if (preferredUrl && !nodes.some((node) => mediaUrl(node) === preferredUrl)) {
      const sidebar = this.findSidebarItem(messageId);
      const sidebarNodes = sidebar ? mediaElements(sidebar) : [];
      if (sidebarNodes.some((node) => mediaUrl(node) === preferredUrl)) {
        message = sidebar;
        nodes = sidebarNodes;
      }
    }
    message ||= this.findSidebarItem(messageId);
    if (!message) return [];
    if (!nodes.length) nodes = mediaElements(message);
    const exact = preferredUrl ? nodes.filter((node) => mediaUrl(node) === preferredUrl) : [];
    const selected = exact.length ? exact : nodes;
    const result = dedupe(selected.map((node) => recordFromNode(node, message)).filter(Boolean) as OriginalMediaRecord[]);
    for (const item of result) this.nodesByItem.set(item.id, nodes.find((node) => mediaUrl(node) === item.url) || message);
    return result;
  }

  async resolveForce(
    messageId: string,
    preferredUrl?: string,
    onResolvedBeforeViewerClose?: (item: MediaItem) => Promise<void> | void,
    expectedKind?: MediaItem['kind'],
    sidebarContainer?: Element,
    options: { pinKViewerVideo?: boolean } = {},
  ): Promise<OriginalMediaRecord[]> {
    console.info('[TG Downloader][force] start', { messageId, urlType: urlType(preferredUrl || ''), expectedKind });
    const initial = await this.resolveMessage(messageId);
    if (!initial.length) {
      console.error(`[TG Downloader][viewer] NO_MEDIA_URL messageId=${messageId} stage=initial-resolution`);
      return [];
    }
    const version = detectTelegramVersion();
    const output: OriginalMediaRecord[] = [];
    let selected = preferredUrl ? initial.filter((item) => item.url === preferredUrl) : initial;
    if (preferredUrl && !selected.length && initial.length) {
      const sameKind = expectedKind ? initial.filter((item) => item.kind === expectedKind) : [];
      if (sameKind.length === 1) selected = sameKind;
      else if (initial.length === 1) selected = initial;
      else {
        const code = sameKind.length ? 'SIDEBAR_MEDIA_MATCH_AMBIGUOUS' : 'SIDEBAR_MEDIA_MATCH_NOT_FOUND';
        throw Object.assign(new Error(`侧栏媒体与当前消息无法唯一匹配：${code}`), { code, messageId, expectedKind, candidateCount: sameKind.length || initial.length });
      }
    }
    for (const item of selected) {
      const media = this.nodesByItem.get(item.id);
      if (!media) continue;
      const current = mediaUrl(media);
      const isKViewerSingleVideo = version === 'K' && sidebarContainer !== undefined && expectedKind === 'video';
      const bridgeStatus = isKViewerSingleVideo ? await this.readPageBridgeStatus() : null;
      const viewerOpenRequestAt = Date.now();
      const captureSession: KViewerCaptureSession | null = isKViewerSingleVideo ? {
        viewerOpenRequestAt,
        bridgeStatus,
        bridgeInstalledBeforeViewer: Boolean(bridgeStatus && bridgeStatus.bridgeInstalledAt <= viewerOpenRequestAt),
      } : null;
      if (captureSession) {
        console.info('[TG Downloader][viewer] capture session', {
          messageId,
          viewerOpenRequestAt,
          bridgeInstalledAt: bridgeStatus?.bridgeInstalledAt ?? null,
          bridgeInstalledBeforeViewer: captureSession.bridgeInstalledBeforeViewer,
          createObjectURLHookInstalled: bridgeStatus?.createObjectURLHookInstalled ?? false,
          fetchHookInstalled: bridgeStatus?.fetchHookInstalled ?? false,
          xhrHookInstalled: bridgeStatus?.xhrHookInstalled ?? false,
          capturedObjectUrlCount: bridgeStatus?.capturedObjectUrlCount ?? 0,
          capturedMediaUrlCount: bridgeStatus?.capturedMediaUrlCount ?? 0,
        });
      }
      console.info('[TG Downloader][force] opening current Telegram viewer', { messageId, kind: item.kind, urlType: urlType(current) });
      let viewer: Element | null = null;
      if (expectedKind === 'image' && sidebarContainer) {
        viewer = await openSidebarImageViewer(
          sidebarContainer,
          () => this.waitForKImageViewer(2000),
          (target) => console.info('[TG Downloader][image-viewer] click-target', {
            tag: target.tagName.toLowerCase(), className: String(target.className || ''), messageId,
          }),
          (target, error) => {
            const details = formatError(error);
            console.error(formatErrorLog('[TG Downloader][image-viewer] click failed', error, {
              messageId, tag: target.tagName.toLowerCase(), className: String(target.className || ''),
            }));
          },
        );
      } else {
        const clickTarget = media.closest('.media-inner, .media-container, .media-photo, .media-video') || media;
        (clickTarget as HTMLElement).click();
        viewer = await this.waitForViewer(version, 2500);
      }
      console.info('[TG Downloader][viewer] open', { messageId, opened: Boolean(viewer) });
      if (expectedKind === 'image') console.info('[TG Downloader][image-viewer] open', { messageId, opened: Boolean(viewer) });
      if (!viewer) {
        if (onResolvedBeforeViewerClose) {
          console.error(`[TG Downloader][viewer] NO_MEDIA_URL messageId=${messageId} stage=viewer-not-opened`);
          continue;
        }
        output.push({ ...item, url: current || item.url, sourceUrl: item.url });
        continue;
      }
      const candidates = viewerCandidateDetails(viewer);
      console.info('[TG Downloader][viewer] candidate', { messageId, candidates });
      if (expectedKind === 'image') console.info('[TG Downloader][image-viewer] candidate', { messageId, candidates });
      let finalUrlBeforeClose = '';
      let finalObjectUrlKindBeforeClose: string | undefined;
      if (isKViewerSingleVideo && captureSession) {
        const resolvedKVideo = await this.resolveKViewer(viewer, item, { pinVideoSource: true, captureSession });
        if (!resolvedKVideo) {
          throw Object.assign(new Error('K Viewer 媒体来源未解析；Viewer 已保留'), { code: 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED', messageId });
        }
        if (resolvedKVideo.nativeDownloadStarted) {
          finalObjectUrlKindBeforeClose = resolvedKVideo.objectUrlKind;
          console.info('[TG Downloader][viewer] source', {
            messageId, source: 'telegram-native-download', finalUrlType: 'native-download',
            objectUrlKind: resolvedKVideo.objectUrlKind || 'unknown', cacheState: 'n/a', sourceStable: true,
          });
          console.info('[TG Downloader][viewer] close', { messageId, finalUrlType: 'native-download', objectUrlKind: finalObjectUrlKindBeforeClose || 'n/a' });
          await this.closeViewer(version, viewer);
          output.push(resolvedKVideo);
          continue;
        }
        const finalItem = {
          ...resolvedKVideo,
          id: `${item.messageId}:${resolvedKVideo.url}`,
          filename: safeFilename(filenameFromUrl(resolvedKVideo.url, resolvedKVideo.kind)),
          sourceUrl: item.url,
        };
        const completed = await startKViewerDownloadAfterSourceResolution(
          async () => finalItem,
          (candidate) => {
            finalUrlBeforeClose = candidate.url;
            finalObjectUrlKindBeforeClose = candidate.objectUrlKind;
            console.info('[TG Downloader][viewer] resolved', {
              messageId, kind: candidate.kind, mime: candidate.mimeType,
              size: candidate.size || 0, urlType: urlType(candidate.url),
            });
            return onResolvedBeforeViewerClose?.(candidate);
          },
          async () => {
            console.info('[TG Downloader][viewer] close', {
              messageId, finalUrlType: urlType(finalUrlBeforeClose), objectUrlKind: finalObjectUrlKindBeforeClose || 'n/a',
            });
            await this.closeViewer(version, viewer);
          },
        );
        output.push(enrichCapturedMedia(completed));
        continue;
      }
      const resolved = await resolveViewerMediaBeforeClose(
        async () => version === 'K' ? await this.resolveKViewer(viewer, item) : this.readViewerMedia(viewer, item),
        (candidate) => {
          const finalItem = { ...candidate, id: `${item.messageId}:${candidate.url}`, filename: safeFilename(filenameFromUrl(candidate.url, candidate.kind)), sourceUrl: item.url };
          finalUrlBeforeClose = finalItem.url;
          finalObjectUrlKindBeforeClose = finalItem.objectUrlKind;
          console.info('[TG Downloader][viewer] resolved', { messageId, kind: finalItem.kind, mime: finalItem.mimeType, size: finalItem.size || 0, urlType: urlType(finalItem.url) });
          if (expectedKind === 'image') console.info('[TG Downloader][image-viewer] resolved', { messageId, urlType: urlType(finalItem.url), mime: finalItem.mimeType, size: finalItem.size || 0 });
          if (onResolvedBeforeViewerClose) return onResolvedBeforeViewerClose(finalItem);
        },
        async () => {
          if (options.pinKViewerVideo && sidebarContainer && expectedKind === 'video') {
            console.info('[TG Downloader][viewer] close', {
              messageId, finalUrlType: urlType(finalUrlBeforeClose), objectUrlKind: finalObjectUrlKindBeforeClose || 'n/a',
            });
          } else {
            console.info('[TG Downloader][viewer] close', { messageId, finalUrl: finalUrlBeforeClose || undefined });
          }
          await this.closeViewer(version, viewer);
        },
      );
      if (!resolved) {
        if (onResolvedBeforeViewerClose) {
          console.error(`[TG Downloader][viewer] NO_MEDIA_URL messageId=${messageId} stage=viewer-media-resolution`);
          continue;
        }
        const fallback = { ...item, url: current || item.url, sourceUrl: item.url };
        output.push(fallback);
        continue;
      }
      const finalItem = { ...resolved, id: `${item.messageId}:${resolved.url}`, filename: safeFilename(filenameFromUrl(resolved.url, resolved.kind)), sourceUrl: item.url };
      output.push(enrichCapturedMedia(finalItem));
    }
    const result = dedupe(output);
    console.info('[TG Downloader][force] resolved', result.map(({ messageId: mid, kind, url }) => ({ messageId: mid, kind, urlType: urlType(url) })));
    return result;
  }

  async scanMessage(messageId: string): Promise<OriginalMediaRecord[]> {
    return this.resolveMessage(messageId);
  }

  findSidebarItem(messageId: string): Element | null {
    return document.querySelector(`.search-super-container-media.active .media-container[data-mid="${CSS.escape(messageId)}"]`) ||
      document.querySelector(`#RightColumn [id="shared-mediamessage-${CSS.escape(messageId)}"]`);
  }

  private async prepareKMediaSidebar(timeoutMs: number): Promise<void> {
    if (timeoutMs === 8000) { await this.openChannelMedia(); return; }
    const deadline = Date.now() + timeoutMs;
    if (document.querySelector('.search-super-container-media.active')) return;
    await this.openChannelMedia();
    while (Date.now() < deadline && !document.querySelector('.search-super-container-media.active')) await sleep(120);
  }

  private findAScrollRoot(): HTMLElement | null {
    const candidates = A_SIDEBAR_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node, index, all) => all.indexOf(node) === index && node.isConnected)
      .filter((node) => node instanceof HTMLElement && visible(node) && node.scrollHeight > node.clientHeight + 8) as HTMLElement[];
    return candidates[0] || null;
  }

  private findKScrollRoot(): HTMLElement | null {
    for (const selector of K_SIDEBAR_SCROLL_SELECTORS) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement && node.isConnected && visible(node) && node.scrollHeight > node.clientHeight + 8) return node;
    }
    return null;
  }

  private findIdentityCard(identity: ScannedMediaIdentity): Element | null {
    const escaped = CSS.escape(identity.messageId);
    const candidates = identity.version === 'K'
      ? Array.from(document.querySelectorAll(`.search-super-container-media.active .media-container[data-mid="${escaped}"]`))
      : Array.from(document.querySelectorAll(`#RightColumn .Media.scroll-item, #RightColumn [id^="shared-mediamessage-"], #RightColumn .shared-media-transition .Transition_slide-active .Media`))
        .filter((node) => node.getAttribute('data-message-id') === identity.messageId || node.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') === identity.messageId);
    return candidates.find((node) => {
      const peerId = node.getAttribute('data-peer-id') || node.closest('[data-peer-id]')?.getAttribute('data-peer-id') || activePeerId();
      return !identity.peerId || !peerId || peerId === identity.peerId;
    }) || null;
  }

  private async locateIdentityCard(identity: ScannedMediaIdentity): Promise<Element | null> {
    let found = this.findIdentityCard(identity);
    if (found) return found;
    const root = identity.version === 'K' ? this.findKScrollRoot() : this.findAScrollRoot();
    if (!root) return null;
    const originalTop = root.scrollTop;
    const deadline = Date.now() + 45000;
    root.scrollTop = 0;
    let stableAtBottom = 0;
    while (Date.now() < deadline && stableAtBottom < 3) {
      found = this.findIdentityCard(identity);
      if (found) return found;
      const beforeHeight = root.scrollHeight;
      const atBottom = root.scrollTop + root.clientHeight >= beforeHeight - 8;
      root.scrollTop = atBottom
        ? beforeHeight
        : Math.min(beforeHeight, root.scrollTop + Math.max(180, Math.floor(root.clientHeight * 0.48)));
      await sleep(atBottom ? 520 : 320);
      found = this.findIdentityCard(identity);
      if (found) return found;
      const nowAtBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      stableAtBottom = nowAtBottom && root.scrollHeight <= beforeHeight + 4 ? stableAtBottom + 1 : 0;
    }
    root.scrollTop = originalTop;
    return null;
  }

  async resolveScannedIdentity(
    identity: ScannedMediaIdentity,
    onResolvedBeforeViewerClose: (item: MediaItem) => Promise<void>,
  ): Promise<MediaItem | null> {
    const version = detectTelegramVersion();
    if (version !== identity.version) throw Object.assign(new Error('扫描身份与当前 Telegram 页面版本不一致'), { code: 'MEDIA_IDENTITY_VERSION_MISMATCH' });
    if (version === 'K') await this.prepareKMediaSidebar(8000);
    else if (version === 'A') await this.openChannelMedia();

    const card = await this.locateIdentityCard(identity);
    if (!card) throw Object.assign(new Error('当前 Media card 已无法定位'), { code: 'MEDIA_CARD_NOT_FOUND' });
    const nodes = version === 'K' ? kSidebarMediaNodes(card, identity.kind) : aSidebarMediaNodes(card, identity.kind);
    const mediaNode = nodes[identity.mediaIndex] || (nodes.length === 1 ? nodes[0] : undefined);
    if (!mediaNode) throw Object.assign(new Error('当前 Media card 中未找到对应媒体节点'), { code: 'MEDIA_NODE_NOT_FOUND' });

    (card as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'nearest' });
    await sleep(100);
    const original: OriginalMediaRecord = {
      id: identity.stableKey,
      url: '',
      filename: safeFilename(`${identity.messageId}.${identity.kind === 'image' ? 'jpg' : identity.kind === 'gif' ? 'gif' : 'mp4'}`),
      mimeType: identity.kind === 'image' ? 'image/jpeg' : identity.kind === 'gif' ? 'image/gif' : 'video/mp4',
      size: 0,
      kind: identity.kind,
      messageId: identity.messageId,
      peerId: identity.peerId,
      fileId: '',
      source: 'dom',
      capturedAt: Date.now(),
      monthGroup: identity.monthGroup,
      dateTimestamp: identity.dateTimestamp,
      hasDownloaded: Boolean(identity.hasDownloaded),
      stableKey: identity.stableKey,
      sidebarKey: identity.sidebarKey,
      mediaIndex: identity.mediaIndex,
      duration: identity.duration,
      thumbnail: identity.thumbnail,
    };

    let viewer: Element | null = null;
    try {
      if (version === 'K' && identity.kind === 'image') {
        viewer = await openSidebarImageViewer(card, () => this.waitForKImageViewer(3000));
      } else {
        const clickTarget = mediaNode.closest('.media-inner, .media-container, .media-photo, .media-video') || mediaNode;
        (clickTarget as HTMLElement).click();
        viewer = await this.waitForViewer(version, 4000);
      }
      if (!viewer) throw Object.assign(new Error('打开 Telegram Viewer 超时'), { code: 'VIEWER_NOT_OPEN' });

      const deadline = Date.now() + 10000;
      let resolved: OriginalMediaRecord | null = null;
      while (!resolved && Date.now() < deadline) {
        resolved = version === 'K' ? await this.resolveKViewer(viewer, original) : this.readViewerMedia(viewer, original);
        if (!resolved?.url || !/^(?:blob:|https?:)/i.test(resolved.url)) {
          resolved = null;
          await sleep(180);
        }
      }
      if (!resolved?.url) throw Object.assign(new Error('Viewer 中未解析到当前有效媒体地址'), { code: 'VIEWER_MEDIA_URL_NOT_FOUND' });

      const finalItem = enrichCapturedMedia({
        ...resolved,
        id: identity.stableKey,
        url: String(resolved.url),
        filename: safeFilename(filenameFromUrl(resolved.url, identity.kind)),
        messageId: identity.messageId,
        peerId: identity.peerId,
        kind: identity.kind,
      });
      await onResolvedBeforeViewerClose(finalItem);
      return finalItem;
    } finally {
      if (viewer) await this.closeViewer(version, viewer);
    }
  }

  private async locateKSidebarItem(messageId: string): Promise<Element | null> {
    if (detectTelegramVersion() !== 'K') return null;
    const scrollRoot = this.findKScrollRoot();
    if (!scrollRoot) return null;
    const oldTop = scrollRoot.scrollTop;
    scrollRoot.scrollTop = 0;
    let stableAtBottom = 0;
    for (let attempt = 0; attempt < 100 && stableAtBottom < 4; attempt += 1) {
      const found = this.findSidebarItem(messageId);
      if (found) return found;
      const beforeHeight = scrollRoot.scrollHeight;
      const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= beforeHeight - 8;
      scrollRoot.scrollTop = atBottom
        ? beforeHeight
        : Math.min(beforeHeight, scrollRoot.scrollTop + Math.max(180, Math.floor(scrollRoot.clientHeight * 0.48)));
      await sleep(atBottom ? 520 : 320);
      const after = this.findSidebarItem(messageId);
      if (after) return after;
      const unchangedBottom = atBottom && scrollRoot.scrollHeight <= beforeHeight + 4;
      stableAtBottom = unchangedBottom ? stableAtBottom + 1 : 0;
    }
    scrollRoot.scrollTop = oldTop;
    return null;
  }

  private async waitForViewer(version: 'A' | 'K' | 'unknown', timeoutMs: number): Promise<Element | null> {
    const selector = version === 'K'
      ? '.media-viewer-whole.active, .media-viewer-whole.is-visible'
      : '.MediaViewerSlide--active';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const viewer = document.querySelector(selector);
      if (viewer) return viewer;
      await sleep(100);
    }
    return document.querySelector(selector);
  }

  private async waitForKImageViewer(timeoutMs: number): Promise<Element | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const movers = document.querySelector('.media-viewer-movers');
      if (movers) return movers.closest('.media-viewer-whole') || movers;
      await sleep(100);
    }
    const movers = document.querySelector('.media-viewer-movers');
    return movers ? movers.closest('.media-viewer-whole') || movers : null;
  }

  private async closeViewer(version: 'A' | 'K' | 'unknown', viewer: Element): Promise<boolean> {
    const activeViewer = () => version === 'K'
      ? document.querySelector('.media-viewer-whole.active, .media-viewer-whole.is-visible')
      : document.querySelector('.MediaViewer, .MediaViewer.active');
    const isOpen = () => {
      const active = activeViewer();
      if (active) return visible(active);
      return viewer.isConnected !== false && visible(viewer);
    };
    const waitUntilClosed = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (isOpen() && Date.now() < deadline) await sleep(80);
      return !isOpen();
    };
    const closeButton = () => {
      if (version === 'K') {
        const buttons = Array.from(viewer.querySelectorAll<HTMLElement>(
          '.media-viewer-buttons .btn-icon, .MediaViewerClose, [aria-label*="close" i], [aria-label*="back" i]',
        )).filter((node) => visible(node) && !node.classList.contains('btn-menu-toggle') &&
          !node.classList.contains('quality-download-options-button-menu'));
        return buttons.find((node) => /close|back/i.test(`${node.title} ${node.getAttribute('aria-label') || ''}`)) ||
          viewer.querySelector<HTMLElement>('.MediaViewerClose, .media-viewer-close, [data-action="close"], [aria-label*="close" i], [aria-label*="back" i]');
      }
      return viewer.querySelector<HTMLElement>('.MediaViewerClose, [aria-label*="close" i], .close');
    };
    const firstClose = closeButton();
    firstClose?.click();
    if (await waitUntilClosed(600)) return true;

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    (document.activeElement || viewer).dispatchEvent(escape);
    if (await waitUntilClosed(600)) return true;

    closeButton()?.click();
    return waitUntilClosed(600);
  }

  private readViewerMedia(viewer: Element, original: OriginalMediaRecord): OriginalMediaRecord | null {
    const node = viewer.querySelector('video[src], video, img[src], img, source[src]');
    if (!node) return null;
    const url = mediaUrl(node);
    if (!url) return null;
    const item = recordFromNode(node, viewer, { fallbackUrl: url, monthGroup: original.monthGroup });
    if (!item) return { ...original, url, mimeType: node.getAttribute('type') || node.getAttribute('data-mime-type') || original.mimeType || 'application/octet-stream' };
    return { ...item, id: `${original.messageId}:${url}`, messageId: original.messageId, peerId: original.peerId, kind: original.kind };
  }

  private async resolveKViewer(
    viewer: Element,
    original: OriginalMediaRecord,
    resolutionOptions?: { pinVideoSource: true; captureSession: KViewerCaptureSession },
  ): Promise<OriginalMediaRecord | null> {
    if (resolutionOptions?.pinVideoSource) {
      return this.resolveKViewerSidebarVideo(viewer, original, resolutionOptions.captureSession);
    }
    const menuVisible = () => Array.from(document.querySelectorAll<HTMLElement>('.btn-menu-item')).some(visible);
    if (!menuVisible()) {
      await this.openKViewerQualityMenu(viewer);
    }
    const options = Array.from(document.querySelectorAll<HTMLElement>('.btn-menu-item')).filter(visible);
    const addresses = options.flatMap((option) => {
      const values = [option.getAttribute('data-url'), option.getAttribute('href'), option.querySelector('a[href]')?.getAttribute('href')].filter(Boolean) as string[];
      return values.map((url) => ({ option, url })).filter(({ url }) => /^(https?:|blob:)/i.test(url));
    });
    if (addresses.length) {
      const highest = addresses.find(({ option }) => /highest|original|最高|原始/i.test(option.textContent || '')) || addresses[0];
      return enrichCapturedMedia({ ...original, id: `${original.messageId}:${highest.url}`, url: highest.url });
    }
    const deadline = Date.now() + 8000;
    let resolved = this.readKViewerMedia(viewer, original);
    while (!resolved && Date.now() < deadline) {
      await sleep(200);
      resolved = this.readKViewerMedia(viewer, original);
    }
    return resolved;
  }

  private async resolveKViewerSidebarVideo(
    viewer: Element,
    original: OriginalMediaRecord,
    session: KViewerCaptureSession,
    options: { allowNativeFallback?: boolean } = {},
  ): Promise<OriginalMediaRecord> {
    const discoveryStartedAt = Date.now();
    const viewerOpenMs = Math.max(0, discoveryStartedAt - session.viewerOpenRequestAt);
    let candidateDiscoveredAt: number | undefined;
    let probeMs = 0;
    let openedByToggle = false;
    let latest: KViewerCandidateSet = { menu: [], viewer: [], captured: [], performance: [] };
    const preflightCache = new Map<string, KViewerHttpPreflightResult>();
    let latestWait: Awaited<ReturnType<typeof waitForKViewerHttpSource>> | null = null;
    const preflight = async (candidate: KViewerHttpCandidate) => {
      candidateDiscoveredAt ??= Date.now();
      const startedAt = Date.now();
      try { return await this.preflightKViewerHttpCandidate(candidate); }
      finally { probeMs += Date.now() - startedAt; }
    };
    const withSingleVideoTiming = (item: OriginalMediaRecord): OriginalMediaRecord => {
      const timing = {
        viewerOpenMs,
        candidateDiscoveryMs: Math.max(0, (candidateDiscoveredAt ?? Date.now()) - discoveryStartedAt),
        probeMs,
        resolvedAt: Date.now(),
      };
      console.info('[TG Downloader][viewer] timing', {
        viewerOpenMs: timing.viewerOpenMs,
        candidateDiscoveryMs: timing.candidateDiscoveryMs,
        probeMs: timing.probeMs,
      });
      return { ...item, kSingleVideo: timing };
    };
    const loggedProbeUrls = new Set<string>();
    const logProbe = (candidate: KViewerHttpCandidate, response: KViewerHttpPreflightResult, accepted: boolean, rejectReason: string) => {
      if (loggedProbeUrls.has(candidate.url)) return;
      loggedProbeUrls.add(candidate.url);
      const safeHost = (value: string | undefined) => {
        try { return value ? new URL(value).host : 'unknown'; } catch { return 'unknown'; }
      };
      console.info('[TG Downloader][viewer] HTTP candidate probe', {
        candidateSource: candidate.source || 'unknown',
        pathClass: kViewerHttpPathClass(candidate.url),
        initialHost: safeHost(candidate.url),
        probeTransport: 'main-world-page-bridge',
        probeStatus: Number(response.status) || 0,
        probeContentType: (response.contentType || '').split(';', 1)[0].trim().toLowerCase(),
        probeRedirected: response.redirected === true,
        finalHost: safeHost(response.finalUrl),
        accepted,
        rejectReason: rejectReason || '',
      });
    };
    const firstWait = await waitForKViewerHttpSource(
      () => this.readKViewerCandidateSet(viewer, session.viewerOpenRequestAt, openedByToggle, session.baselineUrls),
      1200,
      80,
      (ms) => sleep(ms).then(() => undefined),
      preflight,
      preflightCache,
      logProbe,
    );
    latestWait = firstWait;
    latest = firstWait;
    let current = this.readKViewerMedia(viewer, original);
    let pinFailure: PinnedViewerBlob | undefined;
    let pinnedUrl = '';

    const sourceFromHttp = async (candidate: KViewerHttpCandidate, media: OriginalMediaRecord | null): Promise<OriginalMediaRecord> => {
      const isMenuCandidate = candidate.source === 'quality-menu';
      const source = await resolveKViewerVideoSource(
        isMenuCandidate ? [candidate] : [],
        isMenuCandidate ? [] : [candidate],
        '',
        async () => ({ ok: false, code: 'K_VIEWER_SOURCE_UNRESOLVED', error: '已有 HTTP 媒体来源，不需要读取 Blob' }),
      );
      return withSingleVideoTiming(this.makeKViewerResolvedItem(original, media, source));
    };

    const tryPinCurrentBlob = async (): Promise<OriginalMediaRecord | null> => {
      if (!current?.url.startsWith('blob:') || current.url === pinnedUrl) return null;
      pinnedUrl = current.url;
      try {
        const source = await resolveKViewerVideoSource([], [], current.url,
          (url) => this.pinKViewerBlob(url, original.messageId, session));
        return withSingleVideoTiming(this.makeKViewerResolvedItem(original, current, source));
      } catch (error) {
        const value = error as PinnedViewerBlob;
        pinFailure = {
          ok: false,
          code: value.code || 'BLOB_REFERENCE_NOT_CAPTURED',
          objectUrlKind: value.objectUrlKind || 'unknown',
          cacheState: value.cacheState || 'miss',
          createdAfterBridge: value.createdAfterBridge,
          capturedRealm: value.capturedRealm,
          hasObjectReference: value.hasObjectReference,
          size: value.size,
          mimeType: value.mimeType,
          error: value.error || 'Viewer Blob 未通过稳定性验证',
        };
        return null;
      }
    };

    const outcome = await resolveKViewerSourceOrNativeFallback(
      async () => {
        if (firstWait.candidate) {
          try { return await sourceFromHttp(firstWait.candidate, current); }
          catch { /* Continue to the captured Blob and then Telegram's native action. */ }
        }

        const pinned = await tryPinCurrentBlob();
        if (pinned) return pinned;

        // Ordinary message single-download must never click Telegram's download/quality UI.
        // Other callers retain the legacy menu-discovery fallback.
        if (options.allowNativeFallback !== false) {
          ({ openedByToggle } = await this.openKViewerQualityMenu(viewer, 360));
        }
        const observedCandidateCount = firstWait.menu.length + firstWait.viewer.length +
          firstWait.captured.length + firstWait.performance.length;
        const secondWait = await waitForKViewerHttpSource(
          () => this.readKViewerCandidateSet(viewer, session.viewerOpenRequestAt, openedByToggle, session.baselineUrls),
          observedCandidateCount === 0 ? 6500 : 1600,
          100,
          (ms) => sleep(ms).then(() => undefined),
          preflight,
          preflightCache,
          logProbe,
        );
        latestWait = secondWait;
        latest = secondWait;
        current = this.readKViewerMedia(viewer, original);
        if (secondWait.candidate) {
          try { return await sourceFromHttp(secondWait.candidate, current); }
          catch { /* A rejected HTTP candidate must not bypass the final native fallback. */ }
        }
        return tryPinCurrentBlob();
      },
      () => options.allowNativeFallback === false
        ? Promise.resolve(false)
        : this.triggerKViewerNativeDownload(viewer, original.messageId),
      async () => {
        const capturedBlob = latest.captured.find((entry) => entry.url === current?.url);
        const finalBridgeStatus = await this.readPageBridgeStatus(300);
        const diagnostics = {
          messageId: original.messageId,
          qualityMenuCandidates: latest.menu.length,
          capturedHttpCandidates: [...latest.captured, ...latest.viewer, ...latest.performance].filter((entry) => /^https:/i.test(entry.url)).length,
          viewerUrlType: urlType(current?.url || ''),
          objectUrlKind: pinFailure?.objectUrlKind || capturedBlob?.objectUrlKind || 'unknown',
          cacheState: pinFailure?.cacheState || 'miss',
          createdAfterBridge: pinFailure?.createdAfterBridge ?? capturedBlob?.createdAfterBridge ?? null,
          capturedRealm: pinFailure?.capturedRealm || capturedBlob?.capturedRealm || 'unknown',
          hasObjectReference: pinFailure?.hasObjectReference ?? capturedBlob?.hasObjectReference ?? false,
          size: pinFailure?.size ?? capturedBlob?.size ?? 0,
          mimeType: pinFailure?.mimeType || '',
          bridgeInstalledBeforeViewer: session.bridgeInstalledBeforeViewer,
          bridgeInstalledAt: finalBridgeStatus?.bridgeInstalledAt ?? session.bridgeStatus?.bridgeInstalledAt ?? null,
          createObjectURLHookInstalled: finalBridgeStatus?.createObjectURLHookInstalled ?? session.bridgeStatus?.createObjectURLHookInstalled ?? false,
          fetchHookInstalled: finalBridgeStatus?.fetchHookInstalled ?? session.bridgeStatus?.fetchHookInstalled ?? false,
          xhrHookInstalled: finalBridgeStatus?.xhrHookInstalled ?? session.bridgeStatus?.xhrHookInstalled ?? false,
          capturedObjectUrlCount: finalBridgeStatus?.capturedObjectUrlCount ?? session.bridgeStatus?.capturedObjectUrlCount ?? 0,
          capturedMediaUrlCount: finalBridgeStatus?.capturedMediaUrlCount ?? session.bridgeStatus?.capturedMediaUrlCount ?? 0,
          weakCandidateCount: latestWait?.weakCandidateCount ?? 0,
          preflightRejectedCandidates: (latestWait?.rejectedCandidates || []).map((entry) => ({
            source: entry.source, status: entry.status, contentType: entry.contentType, code: entry.code,
          })),
        };
        const unresolved = Object.assign(new Error('K Viewer 媒体来源未解析；Viewer 已保留，请检查诊断日志'), {
          code: 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED',
          ...diagnostics,
        });
        console.error(formatErrorLog('[TG Downloader][viewer] source unresolved', unresolved, {
          messageId: original.messageId,
          stage: 'viewer-source',
          qualityMenuCandidates: diagnostics.qualityMenuCandidates,
          capturedHttpCandidates: diagnostics.capturedHttpCandidates,
          viewerUrlType: diagnostics.viewerUrlType,
          objectUrlKind: diagnostics.objectUrlKind,
          code: unresolved.code,
        }));
        return unresolved;
      },
    );

    if (outcome.kind === 'native-download') {
      const capturedHttpCandidates = [...latest.captured, ...latest.viewer, ...latest.performance].filter((entry) => /^https:/i.test(entry.url)).length;
      console.info('[TG Downloader][viewer] native fallback started', {
        messageId: original.messageId,
        qualityMenuCandidates: latest.menu.length,
        capturedHttpCandidates,
        viewerUrlType: urlType(current?.url || ''),
        objectUrlKind: pinFailure?.objectUrlKind || latest.captured.find((entry) => entry.url === current?.url)?.objectUrlKind || 'unknown',
        cacheState: pinFailure?.cacheState || 'miss',
        bridgeInstalledBeforeViewer: session.bridgeInstalledBeforeViewer,
      });
      return { ...original, nativeDownloadStarted: true };
    }
    return outcome.item;
  }

  private makeKViewerResolvedItem(
    original: OriginalMediaRecord,
    current: OriginalMediaRecord | null,
    source: Awaited<ReturnType<typeof resolveKViewerVideoSource>>,
  ): OriginalMediaRecord {
    const resolved = enrichCapturedMedia({
      ...(current || original),
      id: `${original.messageId}:${source.url}`,
      url: source.url,
      kind: 'video' as const,
      mimeType: source.mimeType || current?.mimeType || original.mimeType,
      size: source.size || current?.size || 0,
      source: source.source === 'page-capture' ? 'fetch' as const : current?.source || original.source,
      objectUrlKind: source.objectUrlKind,
      blobLeaseId: source.blobLeaseId,
      nativeDownloadStarted: false,
      requiresPageTransport: source.source !== 'pinned-blob',
    });
    console.info('[TG Downloader][viewer] source', {
      messageId: original.messageId,
      source: source.source,
      finalUrlType: urlType(source.url),
      objectUrlKind: source.objectUrlKind || 'unknown',
      cacheState: source.blobLeaseId ? 'hit' : 'miss',
      sourceStable: true,
      hasBlobLease: Boolean(source.blobLeaseId),
    });
    return resolved;
  }

  private async openKViewerQualityMenu(viewer: Element, timeoutMs = 1800): Promise<{ openedByToggle: boolean }> {
    if (this.readVisibleKViewerQualityOptions().length) return { openedByToggle: false };
    const downloadToggle = this.findKViewerDownloadButton(viewer);
    if (!downloadToggle || !await this.dispatchOriginalKViewerClick(downloadToggle)) return { openedByToggle: false };
    const options = await this.waitForKViewerQualityOptions(timeoutMs);
    return { openedByToggle: options.length > 0 };
  }

  private findKViewerDownloadButton(viewer: Element): HTMLElement | null {
    const selectors = [
      '.media-viewer-whole.active .quality-download-options-button-menu:not(.hide):not([data-tg-injected])',
      '.media-viewer-whole.active .btn-icon.tgico-download',
      '.media-viewer-whole.active [title*="Download" i]',
      '.media-viewer-whole.active [aria-label*="Download" i]',
      '.media-viewer-whole.active [class*="download" i]:not([data-tg-injected])',
      '.media-viewer-whole .quality-download-options-button-menu:not(.hide):not([data-tg-injected])',
      '.media-viewer-topbar .quality-download-options-button-menu:not(.hide):not([data-tg-injected])',
    ];
    for (const selector of selectors) {
      const candidate = document.querySelector<HTMLElement>(selector);
      if (!candidate) continue;
      const button = candidate.closest<HTMLElement>('.btn-icon, button') || candidate;
      if (viewer.contains(button) && visible(button) && !button.hasAttribute('data-tg-injected')) return button;
    }

    const buttons = Array.from(viewer.querySelectorAll<HTMLElement>('.media-viewer-buttons .btn-icon')).filter(visible);
    return buttons.find((button) => /download/i.test(`${button.title} ${button.getAttribute('aria-label') || ''} ${button.className}`)) ||
      buttons.find((button) => button.classList.contains('quality-download-options-button-menu')) ||
      Array.from(viewer.querySelectorAll<HTMLElement>('.media-viewer-buttons .quality-download-options-button-menu:not(.hide)')).find(visible) ||
      null;
  }

  private async dispatchOriginalKViewerClick(target: HTMLElement): Promise<boolean> {
    try {
      const event = document.createEvent('MouseEvents');
      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        event.initEvent(type, true, true);
        target.dispatchEvent(event);
      }
      return true;
    } catch (error) {
      console.warn('[TG Downloader][viewer] native action dispatch failed', { error: formatError(error).message });
      return false;
    }
  }

  private readVisibleKViewerQualityOptions(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.btn-menu-item')).filter(visible);
  }

  private async waitForKViewerQualityOptions(timeoutMs: number): Promise<HTMLElement[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const options = this.readVisibleKViewerQualityOptions();
      if (options.length) return options;
      await sleep(150);
    }
    return this.readVisibleKViewerQualityOptions();
  }

  private readKViewerQualityMenuCandidates(trustedMenu: boolean): KViewerHttpCandidate[] {
    return Array.from(document.querySelectorAll<HTMLElement>('.btn-menu-item')).filter(visible).flatMap((option) => {
      const values = [option.getAttribute('data-url'), option.getAttribute('href'), option.querySelector('a[href]')?.getAttribute('href')]
        .filter(Boolean) as string[];
      return values.map((rawUrl) => {
        let url = rawUrl;
        try { url = new URL(rawUrl, window.location.href).href; } catch { /* helper rejects invalid URL */ }
        const label = option.textContent || '';
        return {
          url,
          label,
          source: 'quality-menu',
          trustedQualityMenu: trustedMenu || /download|original|highest|\b\d{3,4}\s*p\b|下载|原画|最高|高清/i.test(label),
        };
      });
    });
  }

  private readKViewerDomCandidates(viewer: Element): KViewerHttpCandidate[] {
    const scope = getActiveViewerMediaScope(viewer);
    return viewerScopeNodes<HTMLElement>(scope.root, 'video, source').flatMap((node) => {
      const ownerVideo = node.matches('video') ? node : node.closest('video');
      if (!scope.ownsCurrentAttachment || (ownerVideo && !visible(ownerVideo))) return [];
      const media = node as HTMLMediaElement;
      const rawUrls = [media.currentSrc, media.src, node.getAttribute('src')].filter(Boolean) as string[];
      const contentType = node.getAttribute('type') || node.getAttribute('data-mime-type') || '';
      return [...new Set(rawUrls)].map((rawUrl) => {
        let url = rawUrl;
        try { url = new URL(rawUrl, window.location.href).href; } catch { /* helper rejects invalid URL */ }
        return { url, source: 'viewer-element', contentType, trustedMediaElement: true, activeViewerMainMedia: true };
      });
    });
  }

  private readPerformanceResourceCandidates(since: number): KViewerHttpCandidate[] {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return [];
    const origin = Number(performance.timeOrigin || performance.timing?.navigationStart || 0);
    return performance.getEntriesByType('resource').flatMap((entry) => {
      const resource = entry as PerformanceResourceTiming;
      if (origin + resource.startTime < since) return [];
      return [{ url: resource.name, source: 'performance-resource', capturedAt: origin + resource.startTime }];
    }).slice(-150);
  }

  private async readKViewerCandidateSet(
    viewer: Element,
    since: number,
    trustedMenu: boolean,
    baselineUrls: ReadonlySet<string> = new Set(),
  ): Promise<KViewerCandidateSet> {
    const [captured] = await Promise.all([this.readRecentPageMediaUrls(since)]);
    const freshHistorical = (candidates: KViewerHttpCandidate[]) => candidates.filter((candidate) => !baselineUrls.has(candidate.url));
    const currentMenu = (candidates: KViewerHttpCandidate[]) => candidates.filter((candidate) =>
      !baselineUrls.has(candidate.url) || candidate.trustedQualityMenu === true);
    const currentViewer = (candidates: KViewerHttpCandidate[]) => candidates.filter((candidate) =>
      !baselineUrls.has(candidate.url) || candidate.activeViewerMainMedia === true);
    return {
      menu: currentMenu(this.readKViewerQualityMenuCandidates(trustedMenu)),
      viewer: currentViewer(this.readKViewerDomCandidates(viewer)),
      captured: freshHistorical(captured),
      performance: freshHistorical(this.readPerformanceResourceCandidates(since)),
    };
  }

  private async triggerKViewerNativeDownload(viewer: Element, messageId: string): Promise<boolean> {
    const outcome = await runKViewerNativeDownloadAction<HTMLElement>({
      findDownloadButton: () => this.findKViewerDownloadButton(viewer),
      visibleOptions: () => this.readVisibleKViewerQualityOptions(),
      waitForOptions: (timeoutMs) => this.waitForKViewerQualityOptions(timeoutMs),
      label: (option) => option.textContent || '',
      dispatchOriginalClick: (target) => this.dispatchOriginalKViewerClick(target),
    });
    console.info('[TG Downloader][viewer] native quality action', {
      messageId, dispatched: outcome.started, reason: outcome.reason,
      optionIndex: outcome.optionIndex ?? null, actionKind: outcome.actionKind || 'n/a',
    });
    return outcome.started;
  }

  private readPageBridgeStatus(timeoutMs = 500): Promise<KViewerBridgeStatus | null> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (status: KViewerBridgeStatus | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(status);
      };
      const timeout = window.setTimeout(() => finish(null), timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== PAGE_BRIDGE_MARK ||
            event.data?.type !== 'TG_DOWNLOADER_BRIDGE_STATUS_RESPONSE' || event.data?.requestId !== requestId) return;
        const status = event.data.status;
        if (!status || typeof status.bridgeInstalledAt !== 'number') return finish(null);
        finish({
          bridgeInstalledAt: status.bridgeInstalledAt,
          createObjectURLHookInstalled: status.createObjectURLHookInstalled === true,
          fetchHookInstalled: status.fetchHookInstalled === true,
          xhrHookInstalled: status.xhrHookInstalled === true,
          capturedObjectUrlCount: Number(status.capturedObjectUrlCount) || 0,
          capturedMediaUrlCount: Number(status.capturedMediaUrlCount) || 0,
        });
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ mark: PAGE_BRIDGE_MARK, type: 'TG_DOWNLOADER_GET_BRIDGE_STATUS', requestId }, '*');
      } catch {
        finish(null);
      }
    });
  }

  private readRecentPageMediaUrls(since: number): Promise<KViewerHttpCandidate[]> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish([]), 700);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.type !== 'TG_DOWNLOADER_MEDIA_URLS_RESPONSE' || event.data?.requestId !== requestId || !Array.isArray(event.data.items)) return;
        const candidates = event.data.items.flatMap((entry: {
          url?: unknown; contentType?: unknown; source?: unknown; objectUrlKind?: unknown;
          capturedRealm?: unknown; createdAfterBridge?: unknown; hasObjectReference?: unknown; size?: unknown; time?: unknown;
        }) =>
          typeof entry.url === 'string'
            ? [{
                url: entry.url,
                contentType: typeof entry.contentType === 'string' ? entry.contentType : '',
                source: typeof entry.source === 'string' ? entry.source : '',
                objectUrlKind: typeof entry.objectUrlKind === 'string' ? entry.objectUrlKind : undefined,
                capturedRealm: typeof entry.capturedRealm === 'string' ? entry.capturedRealm : undefined,
                createdAfterBridge: typeof entry.createdAfterBridge === 'boolean' ? entry.createdAfterBridge : null,
                hasObjectReference: entry.hasObjectReference === true,
                size: Number(entry.size) || 0,
                capturedAt: Number(entry.time) || 0,
              }]
            : []);
        finish(candidates);
      };
      const finish = (items: KViewerHttpCandidate[]) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(items);
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ type: 'TG_DOWNLOADER_GET_MEDIA_URLS', requestId, since }, '*');
      } catch {
        finish([]);
      }
    });
  }

  private async preflightKViewerHttpCandidate(candidate: KViewerHttpCandidate): Promise<KViewerHttpPreflightResult> {
    const requestId = crypto.randomUUID();
    const timeoutMs = 2200;
    const response = await new Promise<KViewerHttpPreflightResult>((resolve) => {
      let settled = false;
      const finish = (result: KViewerHttpPreflightResult) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(result);
      };
      const timeout = window.setTimeout(() => {
        try { window.postMessage({ mark: PAGE_BRIDGE_MARK, kind: 'CANCEL_PAGE_MEDIA_RANGE', requestId }, '*'); } catch { /* page may be unloading */ }
        finish({ ok: false, status: 0, code: 'PREFLIGHT_TIMEOUT' });
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== PAGE_BRIDGE_MARK ||
            event.data?.type !== 'K_VIEWER_HTTP_PREFLIGHT_RESPONSE' || event.data?.requestId !== requestId) return;
        finish({
          ok: event.data.ok === true,
          status: Number(event.data.status) || 0,
          finalUrl: typeof event.data.finalUrl === 'string' ? event.data.finalUrl : undefined,
          redirected: event.data.redirected === true,
          contentType: typeof event.data.contentType === 'string' ? event.data.contentType : '',
          contentRange: typeof event.data.contentRange === 'string' ? event.data.contentRange : '',
          contentLength: Number(event.data.contentLength) || 0,
          code: typeof event.data.code === 'string' ? event.data.code : undefined,
        });
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({
          mark: PAGE_BRIDGE_MARK,
          kind: 'PREFLIGHT_K_VIEWER_MEDIA_SOURCE',
          requestId,
          url: candidate.url,
        }, '*');
      } catch {
        finish({ ok: false, status: 0, code: 'PREFLIGHT_MESSAGE_FAILED' });
      }
    });
    const isStream = kViewerHttpPathClass(candidate.url) === 'stream' ||
      kViewerHttpPathClass(response.finalUrl || '') === 'stream';
    if (!isStream || kViewerProbeRejectReason(response)) return response;
    return this.inspectKViewerStreamSource(response);
  }

  private async inspectKViewerStreamSource(response: KViewerHttpPreflightResult): Promise<KViewerHttpPreflightResult> {
    const rangeTotal = /\/(\d+)$/.exec(response.contentRange || '');
    const total = rangeTotal ? Number(rangeTotal[1]) : response.status === 200 ? Number(response.contentLength) : 0;
    if (!Number.isSafeInteger(total) || total <= 0 || !response.finalUrl) {
      return { ...response, standalonePlayable: false, containerRejectReason: 'K_VIEWER_STREAM_SIZE_UNKNOWN' };
    }
    const deadline = Date.now() + 2500;
    const blockSize = 64 * 1024;
    const blocks = new Map<number, Promise<ArrayBuffer>>();
    const readBlock = (offset: number): Promise<ArrayBuffer> => {
      let block = blocks.get(offset);
      if (!block) {
        if (blocks.size >= 128 || Date.now() >= deadline) throw new Error('K_VIEWER_STREAM_INSPECTION_LIMIT');
        block = this.readKViewerContainerRange(response.finalUrl!, offset, Math.min(total, offset + blockSize), total, deadline);
        blocks.set(offset, block);
      }
      return block;
    };
    const container = await inspectMediaContainer({
      size: total,
      read: async (start, endExclusive) => {
        if (Date.now() >= deadline || !Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) ||
            start < 0 || endExclusive < start || endExclusive > total || endExclusive - start > 8 * 1024 * 1024) {
          throw new Error('K_VIEWER_STREAM_INSPECTION_LIMIT');
        }
        const bytes = new Uint8Array(endExclusive - start);
        for (let offset = Math.floor(start / blockSize) * blockSize; offset < endExclusive; offset += blockSize) {
          const block = new Uint8Array(await readBlock(offset));
          const from = Math.max(start, offset);
          const to = Math.min(endExclusive, offset + block.byteLength);
          bytes.set(block.subarray(from - offset, to - offset), from - start);
        }
        return bytes.buffer;
      },
    });
    console.info('[TG Downloader][viewer] stream container probe', {
      detectedContainer: container.detectedContainer,
      firstBox: container.firstBox,
      standalonePlayable: container.standalonePlayable && !container.fragmented,
      fragmented: container.fragmented,
      reason: container.reason,
    });
    return {
      ...response,
      standalonePlayable: container.standalonePlayable && !container.fragmented,
      fragmented: container.fragmented,
      detectedContainer: container.detectedContainer,
      containerRejectReason: container.fragmented ? 'K_VIEWER_STREAM_FRAGMENTED' : container.reason,
    };
  }

  private readKViewerContainerRange(url: string, start: number, endExclusive: number, total: number, deadline: number): Promise<ArrayBuffer> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, bytes?: ArrayBuffer) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        if (error) reject(error); else resolve(bytes!);
      };
      const timeout = window.setTimeout(() => {
        window.postMessage({ mark: PAGE_BRIDGE_MARK, kind: 'CANCEL_PAGE_MEDIA_RANGE', requestId }, '*');
        finish(new Error('K_VIEWER_STREAM_INSPECTION_TIMEOUT'));
      }, Math.max(1, deadline - Date.now()));
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== PAGE_BRIDGE_MARK ||
            event.data?.type !== 'FETCH_PAGE_MEDIA_RANGE_RESPONSE' || event.data?.requestId !== requestId) return;
        const result = event.data;
        if (!result.ok || !allowedKViewerHttpUrl(String(result.finalUrl || '')) ||
            /^text\//i.test(String(result.contentType || '')) || !(result.bytes instanceof ArrayBuffer)) {
          finish(new Error('K_VIEWER_STREAM_RANGE_INVALID'));
          return;
        }
        const bytes = result.bytes as ArrayBuffer;
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(result.contentRange || '').trim());
        if (result.status === 206 && range && Number(range[1]) === start && Number(range[2]) === endExclusive - 1 &&
            Number(range[3]) === total && bytes.byteLength === endExclusive - start) {
          finish(undefined, bytes);
        } else if (result.status === 200 && total <= 64 * 1024 && bytes.byteLength === total) {
          finish(undefined, bytes.slice(start, endExclusive));
        } else finish(new Error('K_VIEWER_STREAM_RANGE_MISMATCH'));
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({
          mark: PAGE_BRIDGE_MARK, kind: 'FETCH_PAGE_MEDIA_RANGE', requestId, url,
          start, end: endExclusive - 1, responseEncoding: 'arraybuffer', maxResponseBytes: 64 * 1024,
        }, '*');
      } catch { finish(new Error('K_VIEWER_STREAM_RANGE_MESSAGE_FAILED')); }
    });
  }

  private pinKViewerBlob(url: string, messageId: string, session: KViewerCaptureSession): Promise<PinnedViewerBlob> {
    const requestId = crypto.randomUUID();
    console.info('[TG Downloader][blob] pin request', {
      messageId, urlType: 'blob', objectUrlKind: 'unknown', cacheState: 'miss',
      createdAfterBridge: null, capturedRealm: 'unknown', hasObjectReference: false,
      size: 0, mimeType: '', bridgeInstalledBeforeViewer: session.bridgeInstalledBeforeViewer,
    });
    return new Promise((resolve) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish({
        ok: false, requestId, code: 'BLOB_PIN_TIMEOUT', objectUrlKind: 'unknown', cacheState: 'miss',
        createdAfterBridge: null, capturedRealm: 'unknown', hasObjectReference: false, size: 0, mimeType: '',
        error: '等待 Blob pin 响应超时',
      }), 5000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== PAGE_BRIDGE_MARK || event.data?.kind !== 'BLOB_PIN_RESULT' || event.data?.requestId !== requestId) return;
        finish(event.data as PinnedViewerBlob);
      };
      const finish = (result: PinnedViewerBlob) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        console.info('[TG Downloader][blob] pin result', {
          messageId, urlType: 'blob', objectUrlKind: result.objectUrlKind || 'unknown',
          cacheState: result.cacheState || 'miss',
          createdAfterBridge: result.createdAfterBridge ?? null,
          capturedRealm: result.capturedRealm || 'unknown',
          hasObjectReference: result.hasObjectReference === true,
          size: result.size || 0, mimeType: result.mimeType || '',
          code: result.code || 'n/a', hasLease: Boolean(result.leaseId),
        });
        resolve(result);
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ mark: PAGE_BRIDGE_MARK, kind: 'PIN_BLOB', requestId, url }, '*');
      } catch {
        finish({ ok: false, requestId, code: 'BLOB_PIN_FAILED', objectUrlKind: 'unknown', cacheState: 'miss', error: '无法发送 Blob pin 请求' });
      }
    });
  }

  private adoptActiveImageBlob(url: string, messageId: string, attachmentIndex: number): Promise<PinnedViewerBlob> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish({
        ok: false, requestId, code: 'ACTIVE_IMAGE_BLOB_ADOPT_TIMEOUT', objectUrlKind: 'unknown', cacheState: 'miss',
        size: 0, mimeType: '', error: '等待当前主图片 Blob 收养响应超时',
      }), 5000);
      const finish = (result: PinnedViewerBlob) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(result);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window || event.data?.mark !== PAGE_BRIDGE_MARK ||
            event.data?.kind !== 'ACTIVE_IMAGE_BLOB_ADOPT_RESULT' || event.data?.requestId !== requestId) return;
        finish(event.data as PinnedViewerBlob);
      };
      window.addEventListener('message', onMessage);
      try {
        window.postMessage({ mark: PAGE_BRIDGE_MARK, kind: 'ADOPT_ACTIVE_IMAGE_BLOB', requestId, url }, '*');
      } catch {
        finish({
          ok: false, requestId, code: 'ACTIVE_IMAGE_BLOB_ADOPT_FAILED', objectUrlKind: 'unknown', cacheState: 'miss',
          size: 0, mimeType: '', error: `无法发送当前主图片 Blob 收养请求 (${messageId}:${attachmentIndex})`,
        });
      }
    });
  }

  private readKViewerMedia(viewer: Element, original: OriginalMediaRecord): OriginalMediaRecord | null {
    const scope = getActiveViewerMediaScope(viewer);
    const videos = viewerScopeNodes(scope.root, 'video').filter((node) => visible(node) && Boolean(mediaUrl(node)));
    if (!scope.ownsCurrentAttachment && videos.length !== 1) return null;
    if (videos.length) {
      const video = videos[0];
      const url = mediaUrl(video);
      return enrichCapturedMedia({ ...original, id: `${original.messageId}:${url}`, url, kind: 'video' as const, mimeType: video.getAttribute('type') || video.getAttribute('data-mime-type') || 'application/octet-stream' });
    }
    const images = viewerScopeNodes<HTMLImageElement>(scope.root, 'img').filter((node) =>
      visible(node) && Boolean(mediaUrl(node)) && !node.closest('.spoilers-container, .media-spoiler'));
    if (!scope.ownsCurrentAttachment && images.length !== 1) return null;
    const candidate = largestViewerImageCandidate(images.map((image) => ({
      image, currentSrc: image.currentSrc, src: image.getAttribute('src') || '',
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.width, height: image.height,
    })));
    if (!candidate) return null;
    const largest = candidate.image.image;
    return enrichCapturedMedia({ ...original, id: `${original.messageId}:${candidate.url}`, url: candidate.url, kind: 'image' as const, mimeType: largest.getAttribute('type') || largest.getAttribute('data-mime-type') || 'application/octet-stream' });
  }
}

function urlType(value: string): string {
  if (value.startsWith('blob:')) return 'blob';
  if (value.includes('/progressive/')) return 'progressive';
  if (value.includes('/stream/')) return 'stream';
  return 'http';
}

export function mediaItemFromFreshNode(node: Element, message: Element): MediaItem | null {
  return recordFromNode(node, message);
}

export function originalASidebarRoots(): Element[] {
  return A_SIDEBAR_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter((node, index, all) => all.indexOf(node) === index);
}
