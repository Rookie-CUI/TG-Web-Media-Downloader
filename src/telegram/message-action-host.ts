export type TelegramPageVersion = 'A' | 'K' | 'unknown';

export function getMessageActionHost(message: Element, version: TelegramPageVersion): Element | null {
  return message.querySelector(version === 'A' ? '.message-content-wrapper' : '.bubble-content-wrapper');
}

export function hasDirectMessageActions(host: Element): boolean {
  return Boolean(host.querySelector(':scope > .tg-k-download-actions, :scope > [data-tg-media-actions="1"]'));
}

export interface MessageAttachmentTarget {
  key: string;
  index: number;
  activationElement: Element;
}

const MEDIA_NODE_SELECTOR = [
  'img.full-media', 'video.full-media', 'canvas.thumbnail',
  'img.media-photo', '.media-photo img', 'video.media-video', '.media-video video',
  '.media-gif-wrapper video', '.media-gif-wrapper img',
].join(',');

function usableAttachment(element: Element): boolean {
  if (element.closest('.EmbeddedMessage, .embedded-thumb, .message-subheader, [hidden], .hide, .is-hidden')) return false;
  return Boolean(element.matches(MEDIA_NODE_SELECTOR) || element.querySelector(MEDIA_NODE_SELECTOR));
}

/** Finds stable clickable attachment boundaries only; it deliberately does not classify media type. */
export function findMessageAttachments(message: Element, version: TelegramPageVersion): MessageAttachmentTarget[] {
  const albumSelector = version === 'A' ? '.album-item-select-wrapper' : '.album-item';
  let boundaries = Array.from(message.querySelectorAll(albumSelector)).filter(usableAttachment);
  if (!boundaries.length) {
    const selectors = version === 'A'
      ? ['.message-content .media-inner', '.message-content.media', '.media-inner']
      : ['.attachment.media-container', '.bubble-content > .attachment', '.media-inner', '.media-container'];
    for (const selector of selectors) {
      boundaries = Array.from(message.querySelectorAll(selector)).filter(usableAttachment);
      if (boundaries.length) break;
    }
  }
  if (!boundaries.length && usableAttachment(message)) boundaries = [message];
  const unique = boundaries.filter((candidate, index, all) =>
    all.indexOf(candidate) === index && !all.some((other) => other !== candidate && other.contains(candidate)));
  return unique.map((activationElement, index) => ({
    key: activationElement.getAttribute('data-mid') || activationElement.getAttribute('data-message-id') ||
      activationElement.getAttribute('data-index') || `attachment-${index}`,
    index,
    activationElement,
  }));
}

const A_CAPTION_SELECTORS = [
  '.message-content .text-content',
  '.message-content-wrapper .text-content',
  '.text-content.clearfix',
];

const K_CAPTION_SELECTORS = [
  '.bubble-content .translatable-message',
  '.bubble-content-wrapper .translatable-message',
  '.bubble-content .message',
  '.bubble-content-wrapper .message',
  '.translatable-message',
  '.message.spoilers-container',
  '.message',
];

function captionText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  clone.querySelectorAll([
    'time', '.time', '.time-inner', '.MessageMeta', '.message-time', '.message-views',
    '.video-time', '.video-duration', '.Reactions', '.reactions', '.message-reactions',
    '.reply', '.quote-like', '[class*="reply"]', '[class*="status"]',
    'button', '[role="button"]', '.tg-k-download-actions', '[data-tg-media-actions="1"]',
  ].join(',')).forEach((element) => element.remove());
  clone.querySelectorAll('img.emoji, img[class*="emoji"], tg-emoji, tg-animated-emoji, span.emoji, [data-emoji], [data-emoji-text]')
    .forEach((element) => {
      const text = element.getAttribute('alt') || element.getAttribute('aria-label') ||
        element.getAttribute('data-emoji-text') || element.getAttribute('data-emoji') || element.textContent || '';
      element.replaceWith(document.createTextNode(text));
    });
  return (clone.textContent || '').replace(/\uFFFD/g, '').replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ').trim();
}

export function extractMessageCaption(message: Element, version: TelegramPageVersion): string {
  const selectors = version === 'A' ? A_CAPTION_SELECTORS : version === 'K' ? K_CAPTION_SELECTORS : [];
  for (const selector of selectors) {
    const candidate = message.querySelector(selector);
    if (!candidate || candidate.closest('.EmbeddedMessage, .message-subheader, .reply, .quote-like')) continue;
    const text = captionText(candidate);
    if (text && !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) && !/^gif$/i.test(text)) return text;
  }
  return '';
}
