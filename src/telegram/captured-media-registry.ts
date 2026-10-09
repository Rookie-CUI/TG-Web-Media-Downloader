import type { MediaItem, ObjectUrlKind } from '../types';

export interface CapturedMediaMetadata {
  url: string;
  mimeType: string;
  size: number;
  source?: string;
  objectUrlKind?: ObjectUrlKind;
}

const MAX_CAPTURED_MEDIA = 300;
const metadataByUrl = new Map<string, CapturedMediaMetadata>();

export function rememberCapturedMedia(value: Partial<CapturedMediaMetadata> & { url?: string }): void {
  if (!value.url || !value.url.startsWith('blob:')) return;
  const metadata: CapturedMediaMetadata = {
    url: value.url,
    mimeType: String(value.mimeType || ''),
    size: Number.isSafeInteger(value.size) && Number(value.size) >= 0 ? Number(value.size) : 0,
    source: value.source,
    objectUrlKind: value.objectUrlKind,
  };
  metadataByUrl.delete(value.url);
  metadataByUrl.set(value.url, metadata);
  while (metadataByUrl.size > MAX_CAPTURED_MEDIA) metadataByUrl.delete(metadataByUrl.keys().next().value as string);
}

export function getCapturedMediaMetadata(url: string): CapturedMediaMetadata | undefined {
  const metadata = metadataByUrl.get(url);
  if (!metadata) return undefined;
  metadataByUrl.delete(url);
  metadataByUrl.set(url, metadata);
  return metadata;
}

export function enrichCapturedMedia<T extends Pick<MediaItem, 'url' | 'mimeType' | 'size'>>(item: T): T {
  const captured = getCapturedMediaMetadata(item.url);
  if (!captured) return item;
  return {
    ...item,
    mimeType: captured.mimeType || item.mimeType,
    size: captured.size || item.size,
    ...(captured.objectUrlKind ? { objectUrlKind: captured.objectUrlKind } : {}),
  };
}
