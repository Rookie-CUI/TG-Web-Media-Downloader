export function safeFilename(input: string, fallback = 'telegram-media.bin'): string {
  const cleaned = input.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  return (cleaned || fallback).slice(0, 180);
}

export function filenameFromUrl(url: string, kind: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    const decoded = segment ? decodeURIComponent(segment) : '';
    if (decoded && /\.[a-z0-9]{2,8}$/i.test(decoded)) return safeFilename(decoded);
  } catch { /* blob URLs do not have a filename */ }
  const label = ['image', 'video', 'gif', 'audio', 'file'].includes(kind) ? kind : 'media';
  return `telegram-${label}-${Date.now()}.bin`;
}

export function filenameFromCaption(caption: string, originalFilename: string, maxBaseLength = 72): string {
  const extension = originalFilename.match(/\.[a-z0-9]{2,8}$/i)?.[0] || '';
  const normalized = caption.normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/^[. ]+|[. ]+$/g, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  const base = [...normalized].slice(0, maxBaseLength).join('').replace(/[. ]+$/g, '').trim();
  return base ? safeFilename(`${base}${extension}`, originalFilename) : safeFilename(originalFilename);
}

function extensionFromResolvedMedia(mimeType: string, url: string, kind: string): string {
  const mime = mimeType.split(';', 1)[0].trim().toLowerCase();
  const byMime: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/flac': 'flac',
  };
  if (byMime[mime]) return byMime[mime];
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,8})$/i);
    if (match) return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  } catch { /* Blob URLs have no useful pathname extension. */ }
  return kind === 'image' ? 'jpg' : kind === 'video' || kind === 'gif' ? 'mp4' : kind === 'audio' ? 'mp3' : 'bin';
}

export function filenameForResolvedMedia(
  caption: string,
  item: { filename: string; mimeType: string; url: string; kind: string },
  attachmentIndex: number,
  attachmentCount: number,
  messageId: string,
): string {
  const extension = extensionFromResolvedMedia(item.mimeType || '', item.url, item.kind);
  const originalBase = item.filename.replace(/\.[a-z0-9]{2,8}$/i, '') || messageId || 'telegram-media';
  const normalizedCaption = caption.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const withoutLeadingHashtags = normalizedCaption.replace(/^(?:#[^\s#]+\s*)+/u, '').trim();
  const captionBase = withoutLeadingHashtags || normalizedCaption;
  const base = [...(captionBase || originalBase)].slice(0, 80).join('').replace(/[. ]+$/g, '').trim() || originalBase;
  const suffix = attachmentCount > 1 ? `_${String(attachmentIndex + 1).padStart(2, '0')}` : '';
  return safeFilename(`${base}${suffix}.${extension}`, `telegram-media${suffix}.${extension}`);
}

