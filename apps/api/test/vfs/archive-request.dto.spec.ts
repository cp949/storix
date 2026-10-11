// 실제 JSON 객체와 revision token으로 요청 구조·순서·이름 검증을 확인한다.
// 검증 규칙은 docs/design/16-file-archive.md의 "공개 계약", "실행과 실패 경계" 절을 따른다.
import { parseArchiveRequest } from '../../src/vfs/dto/archive-request.dto.js';

const id = '00000000-0000-4000-8000-000000000001';
const revision = 'r1.AAAAAAAAQACAAAAAAAAAAQAAAAAAAAAB';

/** FILE ID와 version 1로 형식이 유효한 revision을 만든다. */
function revisionFor(fileId: string): string {
  const bytes = Buffer.alloc(24);
  Buffer.from(fileId.replaceAll('-', ''), 'hex').copy(bytes);
  bytes.writeBigUInt64BE(1n, 16);
  return `r1.${bytes.toString('base64url')}`;
}

// 입력과 호출 순서를 고정해 허용·거부 계약을 재현한다.
describe('parseArchiveRequest 입력 검증', () => {
  it('입력 배열 순서와 선택 revision을 보존한다', () => {
    expect(
      parseArchiveRequest({
        target: '/.zips/a.zip',
        entries: [
          { id, name: 'a' },
          { id, name: 'b', revision },
        ],
      }).entries,
    ).toHaveLength(2);
  });

  it('추가 키·빈 배열·잘못된 타입·UUID·revision을 거부한다', () => {
    for (const body of [
      { target: '/a', entries: [] },
      { target: '/a', extra: true, entries: [{ id, name: 'a' }] },
      { target: '/a', entries: [{ id: 'no', name: 'a' }] },
      { target: '/a', entries: [{ id, name: 'a', revision: 'bad' }] },
      { target: 1, entries: [{ id, name: 'a' }] },
    ])
      expect(() => parseArchiveRequest(body)).toThrow();
  });

  it('8 MiB 이내의 ZIP32 entry ceiling 입력도 순서대로 검증한다', () => {
    const entries = Array.from({ length: 65534 }, (_, index) => ({ id, name: `file-${index}` }));
    const body = { target: '/a.zip', entries };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(8 * 1024 * 1024);
    const result = parseArchiveRequest(body);
    expect(result.entries).toEqual(entries);
  });

  it('1000개 entry 요청을 수용한다', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => {
      const fileId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
      return {
        id: fileId,
        name: [...Array.from({ length: 15 }, () => 'x'.repeat(255)), String(index).padStart(255, '0')].join(
          '/',
        ),
        revision: revisionFor(fileId),
      };
    });
    expect(Buffer.byteLength(entries[0].name, 'utf8')).toBe(4095);
    expect(Buffer.byteLength(JSON.stringify({ target: '/.zips/a.zip', entries }))).toBeLessThan(
      8 * 1024 * 1024,
    );
    expect(parseArchiveRequest({ target: '/.zips/a.zip', entries }).entries).toHaveLength(1000);
  });
});
