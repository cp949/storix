import { NamespaceInvalidTotalLogicalBytesError } from '../namespace.errors.js';

export interface UpdateNamespaceQuotaRequest {
  readonly maxTotalLogicalBytes: string | null;
}

export function parseUpdateNamespaceQuotaRequest(body: unknown): UpdateNamespaceQuotaRequest {
  const record =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const value = record.maxTotalLogicalBytes;
  // openapi의 additionalProperties: false와 맞춰 maxTotalLogicalBytes 외의 필드는 거부한다.
  const hasExtraField = Object.keys(record).some((key) => key !== 'maxTotalLogicalBytes');
  if (hasExtraField || (value !== null && !isPositiveInt64Decimal(value))) {
    throw new NamespaceInvalidTotalLogicalBytesError(value);
  }
  return { maxTotalLogicalBytes: value as string | null };
}

function isPositiveInt64Decimal(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false;
  return BigInt(value) <= 9223372036854775807n;
}
