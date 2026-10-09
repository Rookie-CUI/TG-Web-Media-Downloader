import { formatError } from '../utils/errors';

export interface RangeFailureResponse {
  ok: false;
  status: number;
  error: string;
  requestId?: string;
  code?: string | number;
  retryable?: boolean;
}

export function rangeFailureResponse(error: unknown, requestId = '', statusOverride?: number): RangeFailureResponse {
  const details = formatError(error);
  const status = statusOverride ?? details.status ?? 0;
  return {
    ok: false,
    status: Number.isFinite(status) ? status : 0,
    error: details.message,
    ...(requestId || details.requestId ? { requestId: requestId || details.requestId } : {}),
    ...(details.code ? { code: details.code } : {}),
  };
}
