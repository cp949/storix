import { S3ServiceException } from '@aws-sdk/client-s3';
import { DomainError } from '../common/domain-error.js';
import { StorageFailureError, StorageUnavailableError } from '../common/storage-failure.errors.js';

// Blob 저장 장애 분류표. S3 코드는 S3ServiceException.name(서버 응답의 오류 코드)이고, transport 코드는
// SDK 호출과 SDK가 반환한 다운로드 stream의 Node Error.code다. 업로드 원본 stream 오류는 adapter가
// 이 분류 전에 걸러낸다.
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
  if (error instanceof S3ServiceException) {
    if (TEMPORARY_S3_CODES.has(error.name)) return new StorageUnavailableError(undefined, { cause: error });
    if (PERMANENT_S3_CODES.has(error.name)) return new StorageFailureError(undefined, { cause: error });
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && TEMPORARY_TRANSPORT_CODES.has(code)) {
      return new StorageUnavailableError(undefined, { cause: error });
    }
  }
  return null;
}
