import type { MediaItem } from '../types';
import { safeFilename } from '../utils/filename';

export function exportMediaManifest(items: MediaItem[], chatUrl: string): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    sourcePage: chatUrl,
    scope: 'Only media currently rendered by the signed-in Telegram Web session.',
    items: items.map(({ filename, kind, mimeType, size, messageId, peerId, fileId, capturedAt }) => ({
      filename, kind, mimeType, size, messageId, peerId, fileId, capturedAt,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(`telegram-chat-media-${Date.now()}.json`);
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
