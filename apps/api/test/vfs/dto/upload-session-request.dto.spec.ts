import { parseUploadSessionCreateRequest } from '../../../src/vfs/dto/upload-session-request.dto.js';

describe('parseUploadSessionCreateRequest', () => {
  const base = { path: '/file', sizeBytes: '0', mimeType: 'text/plain' };

  it.each([
    ['조건 누락', {}],
    ['ifAbsent false', { ifAbsent: false }],
    ['양쪽 조건', { ifAbsent: true, ifRevision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['revision 조건', { ifRevision: 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
  ])('만료 입력과 %s 조합은 VFS_INVALID_EXPIRY다', (_label, condition) => {
    expect(() => parseUploadSessionCreateRequest({ ...base, ...condition, expiresInSeconds: 600 })).toThrow(
      expect.objectContaining({ code: 'VFS_INVALID_EXPIRY' }),
    );
  });

  it('만료 입력이 없으면 기존 조건 오류 코드를 유지한다', () => {
    expect(() => parseUploadSessionCreateRequest(base)).toThrow(
      expect.objectContaining({ code: 'VFS_PRECONDITION_REQUIRED' }),
    );
    expect(() => parseUploadSessionCreateRequest({ ...base, ifAbsent: false })).toThrow(
      expect.objectContaining({ code: 'VFS_INVALID_MUTATION_REQUEST' }),
    );
  });
});
