import { S3Error } from 'minio';
import { DomainError } from '../common/domain-error.js';
import { StorageFailureError, StorageUnavailableError } from '../common/storage-failure.errors.js';

// MinIO SDK 8 S3Error.code (server response), Node transport Error.code (SDK call only).
const TEMPORARY_S3_CODES = new Set(['SlowDown', 'ServiceUnavailable', 'InternalError', 'RequestTimeout']);
const PERMANENT_S3_CODES = new Set([
  'NoSuchKey',
  'NoSuchBucket',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'NotFound',
]);
const TEMPORARY_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export function classifyBlobFailure(error: unknown): DomainError | null {
  if (error instanceof DomainError) return null;
  if (error instanceof S3Error) {
    if (TEMPORARY_S3_CODES.has(error.code ?? ''))
      return new StorageUnavailableError(undefined, { cause: error });
    if (PERMANENT_S3_CODES.has(error.code ?? '')) return new StorageFailureError(undefined, { cause: error });
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && TEMPORARY_TRANSPORT_CODES.has(code)) {
      return new StorageUnavailableError(undefined, { cause: error });
    }
  }
  return null;
}
