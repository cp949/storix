import { DocumentPathEscapesRootError } from './document-archive.errors.js';
import { resolveInternalPath } from './path-guard.js';

describe('resolveInternalPath', () => {
  it('alice의 경로를 alice root 아래로 변환한다', () => {
    expect(resolveInternalPath('alice', '/report.txt')).toBe('/documents/alice/report.txt');
  });

  it('bob의 경로를 bob root 아래로 변환한다', () => {
    expect(resolveInternalPath('bob', '/notes/a.txt')).toBe('/documents/bob/notes/a.txt');
  });

  it('빈 경로는 root 자체로 취급한다', () => {
    expect(resolveInternalPath('alice', '')).toBe('/documents/alice');
    expect(resolveInternalPath('alice', '/')).toBe('/documents/alice');
  });

  it('선행 슬래시가 없어도 정규화한다', () => {
    expect(resolveInternalPath('alice', 'report.txt')).toBe('/documents/alice/report.txt');
  });

  it('..이나 .을 포함하면 예외를 던진다', () => {
    expect(() => resolveInternalPath('alice', '../bob/secret.txt')).toThrow(DocumentPathEscapesRootError);
    expect(() => resolveInternalPath('alice', './x')).toThrow(DocumentPathEscapesRootError);
  });
});
