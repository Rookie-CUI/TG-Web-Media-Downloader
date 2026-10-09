export type TelegramPageVersion = 'A' | 'K' | 'unknown';

export function getMessageActionHost(message: Element, version: TelegramPageVersion): Element | null {
  return message.querySelector(version === 'A' ? '.message-content-wrapper' : '.bubble-content-wrapper');
}

export function hasDirectMessageActions(host: Element): boolean {
  return Boolean(host.querySelector(':scope > .tg-k-download-actions, :scope > [data-tg-media-actions="1"]'));
}
