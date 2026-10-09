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

