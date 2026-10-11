import { VfsArchiveBusyError, VfsFeatureDisabledError } from '../../src/vfs/vfs.errors.js';

describe('VfsFeatureDisabledError', () => {
  it('비활성 capability의 식별자를 담은 안정된 409 오류를 반환한다', () => {
    const error = new VfsFeatureDisabledError('content-search');

    expect(error).toMatchObject({
      code: 'VFS_FEATURE_DISABLED',
      status: 409,
      message: 'Capability disabled: content-search',
    });
  });
});

// gate 거부가 기존 오류와 구별되는 503임을 확인한다.
describe('VfsArchiveBusyError gate 초과 응답', () => {
  it('gate 한도 초과를 재시도 가능한 503 오류로 나타낸다', () => {
    const error = new VfsArchiveBusyError();
    expect(error.status).toBe(503);
    expect(error.code).toBe('VFS_ARCHIVE_BUSY');
  });
});
