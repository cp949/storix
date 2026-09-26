import { S3Error } from 'minio';
import { classifyBlobFailure } from './storage-failure.js';

function s3(code: string): S3Error {
  return Object.assign(new S3Error('private object key'), { code });
}

describe('classifyBlobFailure', () => {
  it.each(['SlowDown', 'ServiceUnavailable', 'InternalError', 'RequestTimeout'])(
    '%s SDK 응답은 503이다',
    (code) => {
      expect(classifyBlobFailure(s3(code))).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
    },
  );

  it.each([
    'NoSuchKey',
    'NoSuchBucket',
    'AccessDenied',
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'NotFound',
  ])('%s SDK 응답은 영구 저장 오류다', (code) => {
    expect(classifyBlobFailure(s3(code))).toMatchObject({ code: 'STORAGE_FAILURE', status: 500 });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])(
    '%s SDK transport 오류는 503이다',
    (code) => {
      expect(classifyBlobFailure(Object.assign(new Error('private endpoint'), { code }))).toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        status: 503,
      });
    },
  );

  it('message만 같은 오류, 일반 code 모방, DomainError 및 미확인 코드는 분류하지 않는다', () => {
    expect(classifyBlobFailure(new Error('ECONNRESET SlowDown'))).toBeNull();
    expect(classifyBlobFailure({ code: 'SlowDown' })).toBeNull();
    expect(classifyBlobFailure(s3('SomeFutureError'))).toBeNull();
  });
});
