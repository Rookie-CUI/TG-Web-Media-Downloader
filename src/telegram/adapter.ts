import { filenameFromUrl, safeFilename } from '../utils/filename';
import { classifySidebarMedia } from './sidebar-classifier';
import { rememberCapturedMedia } from './captured-media-registry';
import type { MediaItem, MediaKind } from '../types';

export { classifySidebarMedia } from './sidebar-classifier';

export type TelegramVersion = 'A' | 'K' | 'unknown';
export type OriginalMediaType = 'image' | 'video' | 'gif' | 'audio' | null;

const A_MESSAGES = '.Message.message-list-item[data-message-id], .ActionMessage.message-list-item[data-message-id]';
const K_MESSAGES = '.bubble[data-mid], .bubbles-group .bubble, .bubble.is-in, .bubble.is-out';
const A_MEDIA_ROOT = '.message-content.media, .message-content[class*="media"], .message-content.no-text.media';
const K_MEDIA_SELECTORS = '.video.media-video, .media-video video, .media-video source, .media-video, img.media-photo, .media-photo img, .media-photo';
const SIDEBAR_MEDIA = [
  '#RightColumn .Media.scroll-item',
  '#RightColumn [id^="shared-mediamessage-"]',
  '#RightColumn .shared-media-transition .Transition_slide-active .Media.scroll-item',
  '#RightColumn .shared-media-transition .Transition_slide-active .Media',
  '#RightColumn .Transition_slide-active .Media.scroll-item',
  '#RightColumn .Transition_slide-active .Media',
];

export function detectTelegramVersion(): TelegramVersion {
  if (location.href.includes('web.telegram.org/a') || document.querySelector('.MessageList.custom-scroll')) return 'A';
  if (location.href.includes('web.telegram.org/k')) return 'K';
  return 'unknown';
}

function messageContainer(): Element {
  if (detectTelegramVersion() === 'A') {
    return document.querySelector('.MessageList.custom-scroll') || document.querySelector('.MessageList') || document.documentElement;
  }
  return document.querySelector('#column-center .bubbles .scrollable') ||
    document.querySelector('[data-testid="MessagesList"], [class*="messages-container"]') || document.documentElement;
}

export function messageSelector(): string {
  return detectTelegramVersion() === 'A' ? A_MESSAGES : K_MESSAGES;
}

export function getMessageId(element: Element): string {
  return detectTelegramVersion() === 'A'
    ? element.getAttribute('data-message-id') || ''
    : element.getAttribute('data-mid') || element.getAttribute('data-message-id') || '';
}

function getActivePeerId(): string {
  if (detectTelegramVersion() === 'A') {
    const avatarPeer = document.querySelector('.MiddleHeader .Avatar[data-peer-id]')?.getAttribute('data-peer-id');
    if (avatarPeer) return avatarPeer;
    return location.hash.startsWith('#') ? location.hash.slice(1) : '';
  }
  return document.querySelector('#column-center .bubble[data-peer-id]')?.getAttribute('data-peer-id') || '';
}

export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
}

function fullMedia(element: Element, type: 'image' | 'video'): Element[] {
  const selector = type === 'video' ? 'video.full-media' : 'img.full-media';
  return Array.from(element.querySelectorAll(selector)).filter((media) => {
    if (media.closest('.EmbeddedMessage, .embedded-thumb, .message-subheader')) return false;
    if (media.closest('[hidden], .hide, .is-hidden, .spoilers-container')) return false;
    return true;
  });
}

function kVideoTime(element: Element): string {
  return element.querySelector('.video-time, .video-duration')?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

export function classifyMessage(element: Element): OriginalMediaType {
  if (detectTelegramVersion() === 'A') {
    if (element.classList.contains('ActionMessage')) return null;
    const mediaRoot = element.querySelector(A_MEDIA_ROOT)?.querySelector('.media-inner');
    if (!mediaRoot && !element.querySelector('.message-content.media, .message-content.no-text.media')) return null;
    if (element.querySelector('audio, .Audio, .audio')) return 'audio';
    const duration = element.querySelector('.message-media-duration, .video-duration, .video-time')?.textContent?.trim() || '';
    const video = mediaRoot?.querySelector('video.full-media, video');
    if (video) return /^gif$/i.test(duration) || ((video as HTMLVideoElement).loop && (video as HTMLVideoElement).muted) ? 'gif' : 'video';
    const image = mediaRoot?.querySelector('img.full-media');
    if (image && !image.closest('.EmbeddedMessage, .embedded-thumb, .message-subheader')) return 'image';
    if (mediaRoot?.querySelector('canvas.thumbnail, .thumbnail')) {
      return /^gif$/i.test(duration) ? 'gif' : /\d+:\d+/.test(duration) ? 'video' : 'image';
    }
    return null;
  }

  if (element.querySelector('.audio, .audio-container')) return 'audio';
  if (element.classList.contains('gif')) return 'gif';
  if (element.classList.contains('video') || element.classList.contains('round')) return /^gif$/i.test(kVideoTime(element)) ? 'gif' : 'video';
  if (element.classList.contains('photo')) return 'image';
  const container = element.querySelector('.media-inner, .attachment.media-container, .bubble-content > .attachment, .attachment') || element;
  const time = kVideoTime(container);
  if (time) return /^gif$/i.test(time) ? 'gif' : 'video';
  if (container.querySelector('video.media-video, .media-video video')) return 'video';
  if (container.querySelector('img.media-photo, canvas.media-photo, canvas.canvas-thumbnail')) return 'image';
  return null;
}

function messageNodes(includeHidden = false): Element[] {
  const selector = messageSelector();
  const root = messageContainer();
  if (!root.querySelectorAll) return [];
  const seen = new Set<Element>();
  const results: Element[] = [];
  root.querySelectorAll(selector).forEach((element) => {
    if (!seen.has(element) && (includeHidden || isVisible(element))) {
      seen.add(element);
      results.push(element);
    }
  });
  return results;
}

function mediaUrl(element: Element): string {
  const media = element as HTMLMediaElement;
  return media.currentSrc || media.src || element.getAttribute('src') || element.querySelector('img[src], video[src], source[src]')?.getAttribute('src') || '';
}

function mediaKind(type: OriginalMediaType): MediaKind {
  if (type === 'image') return 'image';
  if (type === 'audio') return 'audio';
  if (type === 'gif') return 'gif';
  return 'video';
}

function makeItem(element: Element, message: Element, type: OriginalMediaType, source: MediaItem['source'] = 'dom', urlOverride = '', midOverride = ''): MediaItem | null {
  const url = urlOverride || mediaUrl(element);
  if (!url || url.startsWith('data:') || !/^(?:https?:|blob:)/i.test(url)) return null;
  const mid = midOverride || getMessageId(message);
  if (!mid) return null;
  const kind = mediaKind(type);
  const mime = element.getAttribute('type') || element.getAttribute('data-mime-type') || 'application/octet-stream';
  const id = mid;
  return {
    id: `${id}:${url}`, url, filename: safeFilename(filenameFromUrl(url, kind)), mimeType: mime,
    size: Number(element.getAttribute('data-size')) || 0, kind, messageId: mid,
    peerId: message.getAttribute('data-peer-id') || message.closest('[data-peer-id]')?.getAttribute('data-peer-id') || getActivePeerId(),
    fileId: url.match(/(?:\/id\/|[?&](?:file_)?id=)([^/?&#]+)/i)?.[1] || '',
    source, capturedAt: Date.now(),
  };
}

function elementsForMessage(message: Element, type: OriginalMediaType): Element[] {
  if (detectTelegramVersion() === 'A') {
    const root = message.querySelector(A_MEDIA_ROOT)?.querySelector('.media-inner') || message;
    return type === 'video' || type === 'gif' ? fullMedia(root, 'video') : type === 'image' ? fullMedia(root, 'image') : Array.from(root.querySelectorAll('audio, .Audio, .audio'));
  }
  const wrapper = message.querySelector('.bubble-content-wrapper') || message;
  const target = wrapper.querySelector('.attachment.media-container, .bubble-content > .attachment, .attachment') || wrapper;
  const selector = type === 'video' || type === 'gif' ? K_MEDIA_SELECTORS : type === 'image' ? 'img.media-photo, .media-photo img, .media-photo' : '.audio, .audio-container';
  return Array.from(target.querySelectorAll(selector)).filter((element) => {
    if (element.closest('[hidden], .hide, .is-hidden, .spoilers-container')) return false;
    const url = mediaUrl(element);
    return Boolean(url);
  });
}

export function scanLoadedMedia(options: { captureImages?: boolean; captureFiles?: boolean } = {}): MediaItem[] {
  const result = new Map<string, MediaItem>();
  for (const message of messageNodes()) {
    const type = classifyMessage(message);
    if (!type || (type === 'image' && options.captureImages === false) || (type === 'audio' && options.captureFiles === false)) continue;
    for (const element of elementsForMessage(message, type)) {
      const item = makeItem(element, message, type);
      if (item) result.set(item.url, item);
    }
  }
  return [...result.values()];
}

export function scanSidebarMedia(): MediaItem[] {
  const result = new Map<string, MediaItem>();
  const version = detectTelegramVersion();
  const nodes = version === 'K'
    ? Array.from(document.querySelectorAll('.search-super-container-media.active .media-container[data-mid]'))
    : SIDEBAR_MEDIA.flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(isVisible);
  for (const node of nodes) {
    const id = node.getAttribute('data-mid') || node.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') || '';
    if (!id) continue;
    const message = node;
    const type = classifySidebarMedia(node);
    if (!type || type === 'audio' || type === 'file') continue;
    const selector = 'img.media-photo, img, video.media-video, .media-video video, .media-video';
    for (const media of Array.from(node.querySelectorAll(selector))) {
      const url = mediaUrl(media);
      if (!url) continue;
      const item = makeItem(media, message, type, 'dom', url, id);
      if (item) result.set(item.url, item);
    }
    if (!Array.from(node.querySelectorAll(selector)).some((element) => mediaUrl(element))) {
      const image = node.querySelector('img.media-photo, img');
      const video = node.querySelector('video.media-video, .media-video video, .media-video');
      const target = video || image;
      const url = target && mediaUrl(target);
      if (target && url) {
        const item = makeItem(target, message, video ? 'video' : 'image', 'dom', url, id);
        if (item) result.set(item.url, item);
      }
    }
  }
  return [...result.values()];
}

export function mediaFromPageEvent(detail: { url?: string; mimeType?: string; size?: number; source?: string; objectUrlKind?: 'blob' | 'media-source' | 'unknown' }): MediaItem | null {
  if (!detail.url) return null;
  if (detail.source === 'blob' || detail.url.startsWith('blob:')) rememberCapturedMedia(detail);
  const version = detectTelegramVersion();
  const elements = Array.from(document.querySelectorAll(version === 'A'
    ? '.Message.message-list-item .message-content-wrapper video.full-media, .Message.message-list-item .message-content-wrapper img.full-media, .Message.message-list-item .message-content-wrapper audio'
    : '.bubble-content-wrapper .media-photo, .bubble-content-wrapper .media-video, .bubble-content-wrapper .media-video video, .bubble-content-wrapper .media-photo img'));
  const media = elements.find((element) => mediaUrl(element) === detail.url);
  if (!media) return null;
  const message = media.closest(messageSelector());
  if (!message) return null;
  const type = classifyMessage(message);
  const item = makeItem(media, message, type, detail.source === 'blob' ? 'blob' : 'fetch', detail.url);
  if (item) {
    if (detail.mimeType) item.mimeType = detail.mimeType;
    if (Number.isSafeInteger(detail.size) && Number(detail.size) >= 0) item.size = Number(detail.size);
    if (detail.objectUrlKind) item.objectUrlKind = detail.objectUrlKind;
  }
  return item;
}

