import type { MediaItem, MediaKind } from '../types';

export interface SidebarMediaCounts {
  total: number;
  image: number;
  video: number;
  gif: number;
}

const classificationLog = new WeakMap<Element, string>();
const VIDEO_SELECTOR = 'video, video.media-video, .media-video video, .media-video, .btn-circle.video-play, [data-video], [class*="video"]';
const IMAGE_SELECTOR = 'img, img.media-photo, canvas.media-photo, canvas.canvas-thumbnail';
const GIF_SELECTOR = '.gif, .media-gif-wrapper, [data-media-type="gif"], [data-type="gif"]';
const AUDIO_SELECTOR = '.audio, .audio-container, .audio-waveform, .voice, .media-audio';

function hasMatch(card: Element, selector: string): boolean {
  return card.matches(selector) || Boolean(card.querySelector(selector));
}

function mediaMessageId(card: Element): string {
  return card.getAttribute('data-mid') || card.getAttribute('data-message-id') ||
    card.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') || '';
}

export function classifySidebarMedia(card: Element): MediaKind | null {
  const durationNode = card.matches('.video-time, .video-duration')
    ? card
    : card.querySelector('.video-time, .video-duration');
  const durationText = durationNode?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const hasImg = hasMatch(card, IMAGE_SELECTOR);
  const hasVideo = hasMatch(card, VIDEO_SELECTOR);
  const hasVideoTime = Boolean(durationNode);
  const isDuration = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(durationText);
  const isGifDuration = /^gif$/i.test(durationText);
  const hasGifMarker = hasMatch(card, GIF_SELECTOR) || Boolean(card.closest('.gif, .media-gif-wrapper'));
  const hasAudio = hasMatch(card, AUDIO_SELECTOR);

  let kind: MediaKind | null = null;
  if (isGifDuration) kind = 'gif';
  else if (hasVideo || hasVideoTime || isDuration) kind = 'video';
  else if (hasGifMarker) kind = 'gif';
  else if (hasAudio) kind = 'audio';
  else if (hasImg) kind = 'image';

  const signature = JSON.stringify({
    messageId: mediaMessageId(card), kind, hasImg, hasVideo, hasVideoTime, durationText, className: String(card.className || ''),
  });
  if (classificationLog.get(card) !== signature) {
    classificationLog.set(card, signature);
    console.info('[TG Downloader][sidebar-scan]', {
      messageId: mediaMessageId(card), kind: kind || 'unknown', hasImg, hasVideo, hasVideoTime, durationText,
      className: String(card.className || ''),
    });
  }
  return kind;
}

export function countSidebarMediaKinds(items: readonly Pick<MediaItem, 'kind'>[]): SidebarMediaCounts {
  return {
    total: items.length,
    image: items.filter((item) => item.kind === 'image').length,
    video: items.filter((item) => item.kind === 'video').length,
    gif: items.filter((item) => item.kind === 'gif').length,
  };
}
