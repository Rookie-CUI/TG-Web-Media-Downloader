export interface FormattedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  status?: number;
  error?: string;
  requestId?: string;
  reason?: string;
}

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
  code?: unknown;
  status?: unknown;
  error?: unknown;
  requestId?: unknown;
  reason?: unknown;
  cause?: unknown;
  statusText?: unknown;
};

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function nestedMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const direct = textValue(value);
  if (direct !== undefined) return direct;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as ErrorLike;
  for (const key of ['message', 'error', 'reason', 'cause', 'statusText'] as const) {
    const nested = record[key];
    if (nested === value) continue;
    const result = nestedMessage(nested, depth + 1);
    if (result) return result;
  }
  const keys = Object.keys(value).slice(0, 8);
  return `未提供错误消息的对象${keys.length ? `（字段：${keys.join(', ')}）` : ''}`;
}

function redactUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    const trailing = raw.match(/[),.;]+$/)?.[0] || '';
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    try {
      const url = new URL(candidate);
      return `${url.protocol}//${url.host}/[已隐藏路径和参数]${trailing}`;
    } catch {
      return `[已隐藏 URL]${trailing}`;
    }
  });
}

export function formatError(error: unknown): FormattedError {
  const record = error && typeof error === 'object' ? error as ErrorLike : undefined;
  const knownName = textValue(record?.name) || (error instanceof Error ? error.name : undefined);
  const name = knownName || 'Error';
  const nested = nestedMessage(error);
  const rawMessage = !nested || nested.startsWith('未提供错误消息的对象') ? knownName || nested || '未知错误' : nested;
  const message = rawMessage === '[object Object]' ? '收到未序列化的对象错误' : redactUrls(rawMessage);
  const stack = textValue(record?.stack);
  const code = textValue(record?.code);
  const statusValue = record?.status;
  const status = typeof statusValue === 'number' && Number.isFinite(statusValue)
    ? statusValue
    : typeof statusValue === 'string' && /^\d{3}$/.test(statusValue) ? Number(statusValue) : undefined;
  const nestedError = record?.error;
  const errorMessage = nestedError === undefined || nestedError === error ? undefined : nestedMessage(nestedError);
  const requestId = textValue(record?.requestId);
  const rawReason = record?.reason ?? record?.cause;
  const reason = rawReason === undefined || rawReason === error ? undefined : nestedMessage(rawReason);
  return {
    name,
    message,
    ...(stack ? { stack: redactUrls(stack) } : {}),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(errorMessage ? { error: redactUrls(errorMessage) } : {}),
    ...(requestId ? { requestId } : {}),
    ...(reason ? { reason: redactUrls(reason) } : {}),
  };
}

function diagnosticValue(value: unknown): string {
  if (value === undefined || value === null) return 'n/a';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); }
  catch { return '[unserializable]'; }
}

export function formatErrorLog(prefix: string, error: unknown, context: Record<string, unknown> = {}): string {
  const details = formatError(error);
  const contextFields = Object.entries(context).map(([key, value]) => `${key}=${diagnosticValue(value)}`);
  return [
    `${prefix}:`,
    `name=${details.name}`,
    `message=${details.message}`,
    `code=${details.code ?? 'n/a'}`,
    `requestId=${details.requestId ?? context.requestId ?? 'n/a'}`,
    `status=${details.status ?? 'n/a'}`,
    ...contextFields,
    ...(details.stack ? [`stack=${details.stack}`] : []),
  ].join(' ');
}
