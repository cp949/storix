import { VfsFeatureDisabledError } from './vfs.errors.js';

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
