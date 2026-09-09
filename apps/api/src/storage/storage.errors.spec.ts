import { VfsInvalidRangeError } from './storage.errors.js';

describe('VfsInvalidRangeError', () => {
  it('code는 VFS_INVALID_RANGE, status는 416이다', () => {
    const error = new VfsInvalidRangeError(0, -1);

    expect(error.code).toBe('VFS_INVALID_RANGE');
    expect(error.status).toBe(416);
  });
});
