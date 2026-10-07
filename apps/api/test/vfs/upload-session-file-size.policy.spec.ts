/**
 * DB 없이 staging 파일 크기 정책의 경계·최솟값·BigInt 정밀도를 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md의 생성·재생 규칙을 따른다.
 */
import {
  UploadSessionStagingFileTooLargeError,
  assertUploadSessionFileFitsStaging,
} from '../../src/vfs/upload-session-file-size.policy.js';

// 파일 크기와 설정 한도만 비교한다. 경계값과 인접한 큰 정수로 초과 판정의 정확성을 고정한다.
describe('업로드 세션 staging 파일 크기 정책', () => {
  it('한도와 같거나 작으면 통과한다', () => {
    expect(() => assertUploadSessionFileFitsStaging(7n, 8n, 8n)).not.toThrow();
    expect(() => assertUploadSessionFileFitsStaging(8n, 8n, 8n)).not.toThrow();
    expect(() => assertUploadSessionFileFitsStaging(9n, 8n, 8n)).toThrow(
      UploadSessionStagingFileTooLargeError,
    );
  });

  it('전역과 namespace 중 작은 한도를 적용한다', () => {
    expect(() => assertUploadSessionFileFitsStaging(6n, 8n, 6n)).not.toThrow();
    expect(() => assertUploadSessionFileFitsStaging(7n, 8n, 6n)).toThrow(
      expect.objectContaining({ maxStagedBytes: 6n }),
    );
    expect(() => assertUploadSessionFileFitsStaging(6n, 6n, 8n)).not.toThrow();
    expect(() => assertUploadSessionFileFitsStaging(7n, 6n, 8n)).toThrow(
      expect.objectContaining({ maxStagedBytes: 6n }),
    );
  });

  it('0바이트는 통과한다', () => {
    expect(() => assertUploadSessionFileFitsStaging(0n, 8n, 8n)).not.toThrow();
  });

  it('2의 53승을 넘는 인접 정수를 구분한다', () => {
    expect(() =>
      assertUploadSessionFileFitsStaging(9007199254740992n, 9007199254740992n, 9007199254740992n),
    ).not.toThrow();
    expect(() =>
      assertUploadSessionFileFitsStaging(9007199254740993n, 9007199254740992n, 9007199254740992n),
    ).toThrow(new UploadSessionStagingFileTooLargeError(9007199254740993n, 9007199254740992n));
    expect(() =>
      assertUploadSessionFileFitsStaging(9007199254740993n, 9007199254740993n, 9007199254740993n),
    ).not.toThrow();
  });
});
