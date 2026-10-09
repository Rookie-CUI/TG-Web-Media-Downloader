export interface HttpRangeResponse {
  ok: boolean;
  status: number;
  bytes: ArrayBuffer;
  contentType?: string;
  contentLength?: string;
  contentRange?: string;
  code?: string;
  retryable?: boolean;
  error?: string;
}

/** Kept by the owner across pauses; only validated, non-overlapping bytes enter parts. */
export interface HttpRangeState {
  total: number;
  parts: Map<number, ArrayBuffer>;
  contentType: string;
  contentRange: string;
}

export interface HttpRangeQueueOptions {
  request: (start: number, end: number, signal: AbortSignal) => Promise<HttpRangeResponse>;
  signal: AbortSignal;
  chunkSize: number;
  concurrency?: number;
  maxRetries: number;
  onProgress?: (received: number, total: number) => void | Promise<void>;
}

export function createHttpRangeState(): HttpRangeState {
  return { total: 0, parts: new Map(), contentType: '', contentRange: '' };
}

function failure(code: string, message: string, retryable = false, status?: number) {
  return Object.assign(new Error(message), { code, retryable, status });
}

function aborted(): DOMException {
  return new DOMException('Range request aborted', 'AbortError');
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw aborted();
}

function integer(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function rangeHeader(value: string) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const start = integer(match[1]);
  const end = integer(match[2]);
  const total = integer(match[3]);
  if (start === null || end === null || total === null || start > end || end >= total) return null;
  return { start, end, total };
}

function waitForRetry(signal: AbortSignal, attempt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    assertActive(signal);
    const onAbort = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(100 * 2 ** attempt, 1000));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Race transport cancellation as well: an uncooperative request cannot block pause. */
function requestWithAbort(options: HttpRangeQueueOptions, start: number, end: number, signal: AbortSignal): Promise<HttpRangeResponse> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      assertActive(signal);
      return options.request(start, end, signal);
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function validateResponse(response: HttpRangeResponse, start: number, end: number, total: number) {
  const mime = (response.contentType || '').split(';')[0].trim().toLowerCase();
  if (response.status >= 300 && response.status < 400) {
    throw failure('HTTP_REDIRECT_NOT_FOLLOWED', 'Range response is an unresolved redirect', false, response.status);
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    throw failure('NON_MEDIA_RESPONSE', 'Range response contains HTML', false, response.status);
  }
  if (!response.ok || (response.status !== 200 && response.status !== 206)) {
    const transient = response.status === 0 || response.status === 408 || response.status === 429 || response.status >= 500;
    throw failure(response.code || 'HTTP_RANGE_FAILED', response.error || `HTTP ${response.status}`, response.retryable !== false && transient, response.status);
  }
  const bytes = response.bytes.byteLength;
  const length = response.contentLength ? integer(response.contentLength.trim()) : null;
  if (response.contentLength && (length === null || length !== bytes)) {
    throw failure('CONTENT_LENGTH_MISMATCH', 'Range Content-Length does not match returned bytes');
  }
  if (response.status === 200) {
    if (start !== 0 || total !== 0 || length === null || length < 1 || bytes !== length || response.contentRange) {
      throw failure('RANGE_NOT_HONORED', 'HTTP 200 is allowed only for an initial, complete body with a matching Content-Length');
    }
    return { start: 0, end: bytes - 1, total: bytes, fullBody: true };
  }
  const range = rangeHeader(response.contentRange || '');
  if (!range || range.start !== start || range.end > end || range.end - range.start + 1 !== bytes || bytes < 1) {
    throw failure('INVALID_CONTENT_RANGE', 'Range offsets or returned byte count are invalid');
  }
  if (total && range.total !== total) throw failure('CONTENT_RANGE_TOTAL_CHANGED', 'Media total changed between Range responses');
  return { ...range, fullBody: false };
}

function validateStoredParts(state: HttpRangeState) {
  if (!Number.isSafeInteger(state.total) || state.total < 0) throw failure('INVALID_RANGE_STATE', 'Invalid retained total');
  let cursor = 0;
  for (const [offset, bytes] of [...state.parts].sort(([a], [b]) => a - b)) {
    if (!Number.isSafeInteger(offset) || offset < cursor || bytes.byteLength < 1 || offset + bytes.byteLength > state.total) {
      throw failure('INVALID_RANGE_STATE', 'Retained parts overlap or exceed total');
    }
    cursor = offset + bytes.byteLength;
  }
}

function missingSpans(state: HttpRangeState, chunkSize: number) {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  const addUntil = (end: number) => {
    while (cursor < end) {
      const next = Math.min(cursor + chunkSize, end);
      spans.push({ start: cursor, end: next - 1 });
      cursor = next;
    }
  };
  for (const [offset, bytes] of [...state.parts].sort(([a], [b]) => a - b)) {
    addUntil(offset);
    cursor = offset + bytes.byteLength;
  }
  addUntil(state.total);
  return spans;
}

/** Fetch validated ranges with at most four workers; callers merge returned chunks in order. */
export async function downloadHttpRangeQueue(state: HttpRangeState, options: HttpRangeQueueOptions) {
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize < 1) throw failure('INVALID_CHUNK_SIZE', 'Chunk size must be a positive safe integer');
  validateStoredParts(state);
  assertActive(options.signal);
  const controller = new AbortController();
  const signal = controller.signal;
  const onAbort = () => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) controller.abort();
  const concurrency = Math.max(1, Math.min(4, Math.trunc(options.concurrency || 4)));
  const maxRetries = Math.max(0, Math.min(10, Math.trunc(options.maxRetries) || 0));
  let progress = Promise.resolve();
  const report = () => {
    const received = [...state.parts.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    progress = progress.then(async () => {
      assertActive(signal);
      await options.onProgress?.(received, state.total);
    });
    return progress;
  };
  const fetchPart = async (start: number, end: number) => {
    let nextOffset: number;
    for (let attempt = 0; ; attempt++) {
      assertActive(signal);
      try {
        const response = await requestWithAbort(options, start, end, signal);
        assertActive(signal);
        const verified = validateResponse(response, start, end, state.total);
        if (!state.total) state.total = verified.total;
        state.contentType ||= response.contentType || '';
        state.contentRange ||= response.contentRange || '';
        state.parts.set(start, response.bytes);
        nextOffset = verified.end + 1;
        break;
      } catch (error) {
        if (signal.aborted) throw aborted();
        const info = error as { name?: string; retryable?: boolean };
        const retryable = info.retryable === true || (info.retryable === undefined && info.name === 'TypeError');
        if (!retryable || attempt >= maxRetries) throw error;
        await waitForRetry(signal, attempt);
      }
    }
    await report();
    return nextOffset;
  };
  try {
    if (!state.total) await fetchPart(0, options.chunkSize - 1);
    else await report();
    const spans = missingSpans(state, options.chunkSize);
    let nextSpan = 0;
    let terminalError: unknown;
    const worker = async () => {
      try {
        while (nextSpan < spans.length) {
          assertActive(signal);
          const span = spans[nextSpan++];
          let start = span.start;
          while (start <= span.end) start = await fetchPart(start, span.end);
        }
      } catch (error) {
        terminalError ??= error;
        controller.abort();
        throw error;
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, spans.length) }, worker));
    if (terminalError) throw terminalError;
    assertActive(signal);
    await progress;
    const parts = [...state.parts].sort(([a], [b]) => a - b);
    let cursor = 0;
    for (const [offset, bytes] of parts) {
      if (offset !== cursor) throw failure('INCOMPLETE_RANGE_FILE', 'Missing or overlapping bytes before merge');
      cursor += bytes.byteLength;
    }
    if (cursor !== state.total) throw failure('INCOMPLETE_RANGE_FILE', 'Merged byte count does not match authoritative total');
    return { chunks: parts.map(([, bytes]) => bytes), total: state.total, contentType: state.contentType, contentRange: state.contentRange };
  } finally {
    controller.abort();
    options.signal.removeEventListener('abort', onAbort);
  }
}
