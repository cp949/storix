import { derivePublicPath } from '../../src/storix-client/public-path.js';

describe('derivePublicPath', () => {
  it('16자리 16진수 접두어와 원본 파일명으로 구성된 경로를 반환한다', () => {
    expect(derivePublicPath('/documents/alice/reports/a.txt')).toMatch(/^\/[0-9a-f]{16}\/a\.txt$/);
  });

  it('같은 internalPath는 항상 같은 결과를 반환한다(publish/unpublish가 같은 공개 경로를 가리켜야 함)', () => {
    expect(derivePublicPath('/documents/alice/a.txt')).toBe(derivePublicPath('/documents/alice/a.txt'));
  });

  it('사용자가 다르면 같은 파일명이어도 다른 결과를 반환한다(충돌 방지)', () => {
    expect(derivePublicPath('/documents/alice/report.txt')).not.toBe(
      derivePublicPath('/documents/bob/report.txt'),
    );
  });

  it('결과에 원본 root prefix나 사용자 이름이 남지 않는다(유출 방지)', () => {
    const result = derivePublicPath('/documents/alice/report.txt');
    expect(result).not.toContain('documents');
    expect(result).not.toContain('alice');
  });
});
