import { S3ServiceException } from '@aws-sdk/client-s3';
import { classifyBlobFailure } from '../../src/storage/storage-failure.js';

function s3(name: string): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'server', $metadata: {}, message: 'private object key' });
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

  it('SDK handler가 만든 TimeoutError는 code가 없어도 503이다', () => {
    const timeout = Object.assign(new Error('the request socket timed out after 120000 ms'), {
      name: 'TimeoutError',
    });

    expect(classifyBlobFailure(timeout)).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

  it('name만 TimeoutError를 흉내 낸 값은 Error가 아니면 분류하지 않는다', () => {
    expect(classifyBlobFailure({ name: 'TimeoutError' })).toBeNull();
  });

  it('message만 같은 오류, 일반 code 모방, DomainError 및 미확인 코드는 분류하지 않는다', () => {
    expect(classifyBlobFailure(new Error('ECONNRESET SlowDown'))).toBeNull();
    expect(classifyBlobFailure({ name: 'SlowDown' })).toBeNull();
    expect(classifyBlobFailure(s3('SomeFutureError'))).toBeNull();
  });
});
