export interface KViewerHttpCandidate {
  url: string;
  source?: string;
  contentType?: string;
  label?: string;
  trustedQualityMenu?: boolean;
  trustedMediaElement?: boolean;
  objectUrlKind?: string;
  capturedRealm?: string;
  createdAfterBridge?: boolean | null;
  hasObjectReference?: boolean;
  size?: number;
  capturedAt?: number;
  preflightVerified?: boolean;
  preflightStatus?: number;
  verifiedContentType?: string;
  verifiedContentRange?: string;
  verifiedStrongEvidence?: boolean;
  initialPathClass?: ReturnType<typeof kViewerHttpPathClass>;
  standalonePlayable?: boolean;
}

export interface KViewerHttpPreflightResult {
  ok: boolean;
  status: number;
  finalUrl?: string;
  redirected?: boolean;
  contentType?: string;
  contentRange?: string;
  contentLength?: number;
  standalonePlayable?: boolean;
  fragmented?: boolean;
  detectedContainer?: string;
  containerRejectReason?: string;
  code?: string;
}

export interface KViewerPreflightDiagnostic {
  source: string;
  status: number;
  contentType: string;
  code: string;
}

export interface KViewerCandidateSet {
  menu: readonly KViewerHttpCandidate[];
  viewer: readonly KViewerHttpCandidate[];
  captured: readonly KViewerHttpCandidate[];
  performance: readonly KViewerHttpCandidate[];
}

export interface KViewerSourceWaitResult extends KViewerCandidateSet {
  candidate: KViewerHttpCandidate | null;
  polls: number;
  weakCandidateCount: number;
  rejectedCandidates: readonly KViewerPreflightDiagnostic[];
}

export interface PinnedViewerBlob {
  ok: boolean;
  requestId?: string;
  leaseId?: string;
  size?: number;
  mimeType?: string;
  objectUrlKind?: 'blob' | 'media-source' | 'unknown';
  cacheState?: 'hit' | 'miss' | string;
  createdAfterBridge?: boolean | null;
  capturedRealm?: string;
  hasObjectReference?: boolean;
  code?: string;
  error?: string;
}

export interface KViewerVideoSource {
  url: string;
  source: 'quality-menu' | 'page-capture' | 'pinned-blob';
  mimeType: string;
  size: number;
  objectUrlKind?: 'blob';
  blobLeaseId?: string;
}

export type KViewerFallbackOutcome<T> =
  | { kind: 'source'; item: T }
  | { kind: 'native-download' };

export interface KViewerNativeDownloadDriver<T> {
  findDownloadButton: () => T | null;
  visibleOptions: () => T[];
  waitForOptions: (timeoutMs: number) => Promise<T[]>;
  label: (option: T) => string;
  dispatchOriginalClick: (target: T) => Promise<boolean>;
}

export async function resolveKViewerSourceOrNativeFallback<T>(
  resolveLaterSource: () => Promise<T | null>,
  triggerNativeDownload: () => Promise<boolean>,
  createUnresolvedError: () => Error | Promise<Error> = () => Object.assign(
    new Error('K Viewer 媒体来源未解析；Viewer 已保留'),
    { code: 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED' },
  ),
): Promise<KViewerFallbackOutcome<T>> {
  try {
    const item = await resolveLaterSource();
    if (item) return { kind: 'source', item };
  } catch {
    // A rejected Blob candidate is not terminal; Telegram's own Viewer action is next.
  }

  try {
    if (await triggerNativeDownload()) return { kind: 'native-download' };
  } catch {
    // Convert native-action failures to the single K Viewer unresolved diagnostic below.
  }
  throw await createUnresolvedError();
}

export async function runKViewerNativeDownloadAction<T>(
  driver: KViewerNativeDownloadDriver<T>,
): Promise<{ started: boolean; reason: string; optionIndex?: number; actionKind?: 'download' | 'quality' | 'first-visible' }> {
  let options = driver.visibleOptions();
  if (!options.length) {
    const button = driver.findDownloadButton();
    if (!button) return { started: false, reason: 'viewer-download-button-not-found' };
    if (!await driver.dispatchOriginalClick(button)) return { started: false, reason: 'viewer-download-button-dispatch-failed' };
    options = await driver.waitForOptions(2500);
  }
  if (!options.length) return { started: false, reason: 'quality-menu-option-not-found' };

  const downloadIndex = options.findIndex((option) => /download|save|下载|保存/i.test(driver.label(option)));
  const qualityIndex = options.findIndex((option) => /original|highest|best|原画|原始|最高/i.test(driver.label(option)));
  const optionIndex = downloadIndex >= 0 ? downloadIndex : qualityIndex >= 0 ? qualityIndex : 0;
  const actionKind = downloadIndex >= 0 ? 'download' : qualityIndex >= 0 ? 'quality' : 'first-visible';
  if (!await driver.dispatchOriginalClick(options[optionIndex])) {
    return { started: false, reason: 'quality-menu-option-dispatch-failed', optionIndex, actionKind };
  }
  return { started: true, reason: 'quality-menu-option-dispatched', optionIndex, actionKind };
}

export function allowedKViewerHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = host === 'web.telegram.org' || host === 'telegram.org' || host.endsWith('.telegram.org') ||
      host === 'telegram-cdn.org' || host.endsWith('.telegram-cdn.org') || host === 't.me' || host.endsWith('.t.me');
    return url.protocol === 'https:' && allowed;
  } catch {
    return false;
  }
}

function normalizedContentType(candidate: KViewerHttpCandidate): string {
  return (candidate.contentType || '').split(';', 1)[0].trim().toLowerCase();
}

function isExplicitImageCandidate(candidate: KViewerHttpCandidate): boolean {
  const url = candidate.url.toLowerCase();
  return normalizedContentType(candidate).startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|#|$)/.test(url);
}

export function kViewerHttpPathClass(value: string): 'progressive' | 'stream' | 'download' | 'other' {
  let pathname = value.toLowerCase();
  try { pathname = new URL(value).pathname.toLowerCase(); } catch { /* classify the available string */ }
  if (pathname.includes('/progressive/')) return 'progressive';
  if (pathname.includes('/stream/')) return 'stream';
  if (pathname.includes('/download/')) return 'download';
  return 'other';
}

function finalUrlProvesMedia(value: string): boolean {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    return /\/(progressive|stream)\//.test(pathname) ||
      /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|opus|aac|mpeg|mpga|wav|flac|weba)$/.test(pathname);
  } catch {
    return false;
  }
}

function responseMimeProvesMedia(contentType: string): boolean {
  return /^(video|audio)\//.test(contentType) ||
    /^application\/(mp4|ogg|x-matroska|vnd\.apple\.mpegurl)(?:$|\+)/.test(contentType);
}

/** Strong source evidence comes from the URL or a real media MIME, never from a media element alone. */
export function mediaPathOrType(candidate: KViewerHttpCandidate): boolean {
  if (isExplicitImageCandidate(candidate)) return false;
  if (candidate.preflightVerified === true && candidate.verifiedStrongEvidence === true) return true;
  const url = candidate.url.toLowerCase();
  const contentType = normalizedContentType(candidate);
  return /\/(progressive|stream|download)\//.test(url) ||
    /^(video|audio)\//.test(contentType) ||
    /\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|opus|aac|mpeg|mpga|wav|flac|weba)(\?|#|$)/.test(url);
}

function candidateNeedsPreflight(candidate: KViewerHttpCandidate): boolean {
  return allowedKViewerHttpUrl(candidate.url) && !isExplicitImageCandidate(candidate) &&
    (mediaPathOrType(candidate) || candidate.trustedQualityMenu === true || candidate.trustedMediaElement === true);
}

function rangeLooksValid(contentRange: string): boolean {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange.trim());
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return start === 0 && end >= start && total > end;
}

export function kViewerProbeRejectReason(response: KViewerHttpPreflightResult): string {
  const status = Number(response.status) || 0;
  const contentType = (response.contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!response.ok) return response.code || (status >= 300 && status < 400 ? 'HTTP_REDIRECT_NOT_FOLLOWED' : 'K_VIEWER_HTTP_PROBE_FAILED');
  if (status >= 300 && status < 400) return 'HTTP_REDIRECT_NOT_FOLLOWED';
  if (![200, 206].includes(status)) return 'K_VIEWER_PREFLIGHT_HTTP_FAILED';
  if (!response.finalUrl) return 'K_VIEWER_FINAL_URL_MISSING';
  if (!allowedKViewerHttpUrl(response.finalUrl)) return 'TELEGRAM_REDIRECT_NOT_ALLOWED';
  if (contentType === 'text/html' || contentType.startsWith('text/')) return 'NON_MEDIA_RESPONSE';
  if (contentType.startsWith('image/')) return 'NON_VIDEO_MEDIA_RESPONSE';
  if (status === 206 && !rangeLooksValid(response.contentRange || '')) return 'INVALID_CONTENT_RANGE';
  if (!responseMimeProvesMedia(contentType) && !finalUrlProvesMedia(response.finalUrl)) return 'FINAL_MEDIA_TYPE_UNVERIFIED';
  if (isExplicitImageCandidate({ url: response.finalUrl, contentType })) return 'NON_VIDEO_MEDIA_RESPONSE';
  return '';
}

function candidateAfterPreflight(
  candidate: KViewerHttpCandidate,
  response: KViewerHttpPreflightResult,
): KViewerHttpCandidate | null {
  const contentType = (response.contentType || '').split(';', 1)[0].trim().toLowerCase();
  const contentRange = response.contentRange || '';
  const status = Number(response.status) || 0;
  const finalUrl = response.finalUrl || '';
  if (kViewerProbeRejectReason(response)) return null;
  const initialPathClass = candidate.initialPathClass || kViewerHttpPathClass(candidate.url);
  if ((initialPathClass === 'stream' || kViewerHttpPathClass(finalUrl) === 'stream') &&
      (response.standalonePlayable !== true || response.fragmented === true)) return null;

  const verified: KViewerHttpCandidate = {
    ...candidate,
    url: finalUrl,
    contentType: contentType || candidate.contentType || '',
    preflightVerified: true,
    preflightStatus: status,
    verifiedContentType: contentType,
    verifiedContentRange: contentRange,
    verifiedStrongEvidence: true,
    initialPathClass,
    standalonePlayable: response.standalonePlayable,
  };
  return verified;
}

function candidateRank(candidate: KViewerHttpCandidate): number {
  const url = candidate.url.toLowerCase();
  const pathClass = candidate.initialPathClass || kViewerHttpPathClass(url);
  if (pathClass === 'progressive') return 0;
  if (pathClass === 'download') return 1;
  if (pathClass === 'stream') return 9;
  if (/^(video|audio)\//.test(normalizedContentType(candidate))) return 3;
  if (/\.(mp4|webm|mov|mkv|m4v|mp3|m4a|ogg|opus|aac|mpeg|mpga|wav|flac|weba)(\?|#|$)/.test(url)) return 4;
  if (candidate.trustedQualityMenu) return 5;
  if (candidate.trustedMediaElement) return 6;
  if (candidate.source === 'performance-resource') return 8;
  return 7;
}

export function chooseKViewerVideoHttpSource(
  menuCandidates: readonly KViewerHttpCandidate[],
  capturedCandidates: readonly KViewerHttpCandidate[],
  viewerCandidates: readonly KViewerHttpCandidate[] = [],
  performanceCandidates: readonly KViewerHttpCandidate[] = [],
): KViewerHttpCandidate | null {
  const valid = [...menuCandidates, ...viewerCandidates, ...capturedCandidates, ...performanceCandidates]
    .filter((candidate) => allowedKViewerHttpUrl(candidate.url) && !isExplicitImageCandidate(candidate) &&
      candidate.preflightVerified === true && candidate.verifiedStrongEvidence === true && mediaPathOrType(candidate) &&
      (!(candidate.initialPathClass === 'stream' || kViewerHttpPathClass(candidate.url) === 'stream') || candidate.standalonePlayable === true));
  const byUrl = new Map<string, KViewerHttpCandidate>();
  for (const candidate of valid) {
    const prior = byUrl.get(candidate.url);
    if (!prior || candidateRank(candidate) < candidateRank(prior)) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()].sort((left, right) => candidateRank(left) - candidateRank(right))[0] || null;
}

export async function waitForKViewerHttpSource(
  readCandidates: () => Promise<KViewerCandidateSet>,
  timeoutMs = 7000,
  pollMs = 180,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  preflight?: (candidate: KViewerHttpCandidate) => Promise<KViewerHttpPreflightResult>,
  preflightCache: Map<string, KViewerHttpPreflightResult> = new Map(),
  onPreflightResult?: (candidate: KViewerHttpCandidate, response: KViewerHttpPreflightResult, accepted: boolean, rejectReason: string) => void,
): Promise<KViewerSourceWaitResult> {
  const deadline = Date.now() + timeoutMs;
  let latest: KViewerCandidateSet = { menu: [], viewer: [], captured: [], performance: [] };
  let polls = 0;
  const rejected = new Map<string, KViewerPreflightDiagnostic>();
  const weakUrls = new Set<string>();
  do {
    latest = await readCandidates();
    polls += 1;
    const candidates = [...latest.menu, ...latest.viewer, ...latest.captured, ...latest.performance]
      .filter(candidateNeedsPreflight);
    const byUrl = new Map<string, KViewerHttpCandidate>();
    for (const candidate of candidates) {
      const previous = byUrl.get(candidate.url);
      if (!previous || candidateRank(candidate) < candidateRank(previous)) byUrl.set(candidate.url, candidate);
      if (!mediaPathOrType(candidate)) weakUrls.add(candidate.url);
    }
    const ordered = [...byUrl.values()].sort((left, right) => candidateRank(left) - candidateRank(right));
    if (preflight) {
      for (const candidate of ordered) {
        let response = preflightCache.get(candidate.url);
        if (!response) {
          try {
            response = await preflight(candidate);
          } catch {
            response = { ok: false, status: 0, code: 'PREFLIGHT_FAILED' };
          }
          preflightCache.set(candidate.url, response);
        }
        const isStream = (candidate.initialPathClass || kViewerHttpPathClass(candidate.url)) === 'stream' ||
          kViewerHttpPathClass(response.finalUrl || '') === 'stream';
        const rejectReason = kViewerProbeRejectReason(response) ||
          (isStream && (response.standalonePlayable !== true || response.fragmented === true)
            ? response.containerRejectReason || 'K_VIEWER_STREAM_NOT_STANDALONE' : '');
        const verified = candidateAfterPreflight(candidate, response);
        if (!verified) rejected.set(candidate.url, {
          source: candidate.source || 'unknown',
          status: Number(response.status) || 0,
          contentType: (response.contentType || '').split(';', 1)[0].trim().toLowerCase(),
          code: rejectReason || 'K_VIEWER_SOURCE_REJECTED',
        });
        try { onPreflightResult?.(candidate, response, Boolean(verified), verified ? '' : rejectReason || 'K_VIEWER_SOURCE_REJECTED'); } catch { /* Diagnostics must not interrupt resolution. */ }
        // Ordered candidates have already placed progressive/download ahead of stream.
        // A stable result must not wait for unrelated lower-priority probes or the timeout.
        if (verified) return { ...latest, candidate: verified, polls, weakCandidateCount: weakUrls.size, rejectedCandidates: [...rejected.values()] };
      }
    }
    if (Date.now() < deadline) await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { ...latest, candidate: null, polls, weakCandidateCount: weakUrls.size, rejectedCandidates: [...rejected.values()] };
}

export async function resolveKViewerVideoSource(
  menuCandidates: readonly KViewerHttpCandidate[],
  capturedCandidates: readonly KViewerHttpCandidate[],
  currentSrc: string,
  pinBlob: (url: string) => Promise<PinnedViewerBlob>,
  viewerCandidates: readonly KViewerHttpCandidate[] = [],
  performanceCandidates: readonly KViewerHttpCandidate[] = [],
): Promise<KViewerVideoSource> {
  const verifiedMenu = menuCandidates.filter((candidate) => candidate.preflightVerified === true);
  const verifiedCaptured = capturedCandidates.filter((candidate) => candidate.preflightVerified === true);
  const verifiedViewer = viewerCandidates.filter((candidate) => candidate.preflightVerified === true);
  const verifiedPerformance = performanceCandidates.filter((candidate) => candidate.preflightVerified === true);
  const http = chooseKViewerVideoHttpSource(verifiedMenu, verifiedCaptured, verifiedViewer, verifiedPerformance);
  if (http) {
    const isMenu = http.source === 'quality-menu';
    return {
      url: http.url,
      source: isMenu ? 'quality-menu' : 'page-capture',
      mimeType: http.verifiedContentType || http.contentType || '',
      size: 0,
    };
  }

  if (!currentSrc.startsWith('blob:')) {
    throw Object.assign(new Error('K Viewer 中没有找到可稳定下载的 HTTP 媒体源或可 pin 的 Blob'), { code: 'K_VIEWER_SOURCE_UNSTABLE' });
  }
  const pinned = await pinBlob(currentSrc);
  if (!pinned.ok || !pinned.leaseId || !Number.isSafeInteger(pinned.size) || Number(pinned.size) <= 0 || pinned.objectUrlKind !== 'blob') {
    const code = pinned.code || (pinned.objectUrlKind === 'media-source' ? 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE' : 'BLOB_REFERENCE_NOT_CAPTURED');
    throw Object.assign(new Error(pinned.error || 'Viewer Blob 未通过稳定性验证'), {
      code,
      objectUrlKind: pinned.objectUrlKind || 'unknown',
      cacheState: pinned.cacheState || 'miss',
      createdAfterBridge: pinned.createdAfterBridge ?? null,
      capturedRealm: pinned.capturedRealm || 'unknown',
      hasObjectReference: pinned.hasObjectReference === true,
      size: Number(pinned.size) || 0,
      mimeType: pinned.mimeType || '',
    });
  }
  return {
    url: currentSrc,
    source: 'pinned-blob',
    mimeType: pinned.mimeType || '',
    size: Number(pinned.size),
    objectUrlKind: 'blob',
    blobLeaseId: pinned.leaseId,
  };
}
