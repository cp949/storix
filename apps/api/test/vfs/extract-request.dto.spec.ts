// extract 요청 JSON의 필수·선택 필드, 허용 키, 경로·revision·exclude·mimeTypes 검증과 오류 코드를 단위 테스트한다.
// 순수 함수 단위 테스트이며 DB와 저장소를 쓰지 않는다. 규칙은 docs/design/17-file-extract.md "공개 계약"을 따른다.
import { parseExtractRequest } from '../../src/vfs/dto/extract-request.dto.js';
import { encodeRevision } from '../../src/vfs/revision.js';

const SOURCE_REVISION = encodeRevision({ id: '00000000-0000-4000-8000-000000000001', version: 1 });
const DESTINATION_REVISION = encodeRevision({ id: '00000000-0000-4000-8000-000000000002', version: 3 });

function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: '/.staging/u/upload.zip',
    sourceRevision: SOURCE_REVISION,
    destination: '/site',
    mode: 'overwrite',
    ...extra,
  };
}

/** 던진 DomainError의 code를 돌려준다. 던지지 않으면 undefined다. */
function codeOf(value: unknown): string | undefined {
  try {
    parseExtractRequest(value);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const INVALID = 'VFS_INVALID_EXTRACT_REQUEST';

describe('parseExtractRequest', () => {
  it('필수 필드만 있으면 기본값을 채워 정규화한다', () => {
    expect(parseExtractRequest(validBody())).toEqual({
      source: '/.staging/u/upload.zip',
      sourceSegments: ['.staging', 'u', 'upload.zip'],
      sourceRevision: SOURCE_REVISION,
      destination: '/site',
      destinationSegments: ['site'],
      mode: 'overwrite',
      exclude: [],
      mimeTypes: {},
      dryRun: false,
    });
  });

  it('경로를 정규화하고 선택 필드를 그대로 담는다', () => {
    const parsed = parseExtractRequest(
      validBody({
        source: '/a//b/./c.tar',
        destination: '/site/./x//y',
        mode: 'clean',
        destinationRevision: DESTINATION_REVISION,
        exclude: ['__MACOSX/**'],
        mimeTypes: { '.html': 'text/html', '.js': 'TEXT/JAVASCRIPT' },
        dryRun: true,
      }),
    );
    expect(parsed).toMatchObject({
      source: '/a/b/c.tar',
      destination: '/site/x/y',
      destinationSegments: ['site', 'x', 'y'],
      mode: 'clean',
      destinationRevision: DESTINATION_REVISION,
      exclude: ['__MACOSX/**'],
      mimeTypes: { '.html': 'text/html', '.js': 'text/javascript' },
      dryRun: true,
    });
  });

  it('필수 필드 4개 중 하나라도 없으면 요청 오류다', () => {
    for (const key of ['source', 'sourceRevision', 'destination', 'mode']) {
      const body = validBody();
      delete body[key];
      expect(codeOf(body)).toBe(INVALID);
    }
  });

  it('객체가 아니거나 알 수 없는 키가 있으면 요청 오류다', () => {
    for (const value of [null, [], 'text', 1, undefined]) expect(codeOf(value)).toBe(INVALID);
    expect(codeOf(validBody({ stripComponents: 1 }))).toBe(INVALID);
  });

  it('root source와 root destination은 요청 오류다', () => {
    for (const root of ['/', '//', '/.']) {
      expect(codeOf(validBody({ source: root }))).toBe(INVALID);
      expect(codeOf(validBody({ destination: root }))).toBe(INVALID);
    }
  });

  it('잘못된 경로는 VFS_INVALID_PATH가 아니라 extract 요청 오류로 바꾼다', () => {
    for (const path of ['site', '/a/../b', '/a\\b', 7, null]) {
      expect(codeOf(validBody({ source: path }))).toBe(INVALID);
      expect(codeOf(validBody({ destination: path }))).toBe(INVALID);
    }
  });

  it('mode와 dryRun은 정해진 값만 받는다', () => {
    expect(codeOf(validBody({ mode: 'merge' }))).toBe(INVALID);
    expect(codeOf(validBody({ mode: 1 }))).toBe(INVALID);
    expect(codeOf(validBody({ mode: 'clean' }))).toBeUndefined();
    expect(codeOf(validBody({ dryRun: 'true' }))).toBe(INVALID);
    expect(codeOf(validBody({ dryRun: 1 }))).toBe(INVALID);
    expect(codeOf(validBody({ dryRun: false }))).toBeUndefined();
  });

  it('문자열 revision의 형식 오류는 VFS_INVALID_REVISION, 문자열이 아니면 요청 오류다', () => {
    const legacy = 'r1.00000000-0000-4000-8000-000000000001.1';
    for (const key of ['sourceRevision', 'destinationRevision']) {
      expect(codeOf(validBody({ [key]: 'r1.zzz' }))).toBe('VFS_INVALID_REVISION');
      expect(codeOf(validBody({ [key]: legacy }))).toBe('VFS_INVALID_REVISION');
      expect(codeOf(validBody({ [key]: '' }))).toBe('VFS_INVALID_REVISION');
      expect(codeOf(validBody({ [key]: 123 }))).toBe(INVALID);
      expect(codeOf(validBody({ [key]: null }))).toBe(INVALID);
    }
  });

  it('구조 오류가 revision 형식 오류보다 먼저 보고된다', () => {
    expect(codeOf(validBody({ sourceRevision: 'bad', extra: 1 }))).toBe(INVALID);
    expect(codeOf(validBody({ sourceRevision: 'bad', destination: '/' }))).toBe(INVALID);
  });

  it('exclude는 64개와 1024자까지 받고 그 이상·빈 문자열·비문자열·비배열은 거부한다', () => {
    expect(codeOf(validBody({ exclude: Array.from({ length: 64 }, (_, i) => `d${i}`) }))).toBeUndefined();
    expect(codeOf(validBody({ exclude: Array.from({ length: 65 }, (_, i) => `d${i}`) }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: ['a'.repeat(1024)] }))).toBeUndefined();
    expect(codeOf(validBody({ exclude: ['a'.repeat(1025)] }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: [''] }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: [1] }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: 'a' }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: null }))).toBe(INVALID);
  });

  it('glob 문법 오류는 요청 오류다', () => {
    expect(codeOf(validBody({ exclude: ['a**b'] }))).toBe(INVALID);
    expect(codeOf(validBody({ exclude: ['***'] }))).toBe(INVALID);
  });

  it('mimeTypes는 256개까지 받고 키 형식과 strict MIME을 검사한다', () => {
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`.e${i}`, 'text/plain']));
    expect(codeOf(validBody({ mimeTypes: many(256) }))).toBeUndefined();
    expect(codeOf(validBody({ mimeTypes: many(257) }))).toBe(INVALID);
    expect(codeOf(validBody({ mimeTypes: { [`.${'a'.repeat(32)}`]: 'text/plain' } }))).toBeUndefined();
    for (const key of [`.${'a'.repeat(33)}`, 'html', '.HTML', '.', '.a.b', '. a']) {
      expect(codeOf(validBody({ mimeTypes: { [key]: 'text/plain' } }))).toBe(INVALID);
    }
    for (const value of ['text/html; charset=utf-8', 'html', '', 1, null]) {
      expect(codeOf(validBody({ mimeTypes: { '.html': value } }))).toBe(INVALID);
    }
    for (const mimeTypes of [null, [], 'text/plain', 1]) {
      expect(codeOf(validBody({ mimeTypes }))).toBe(INVALID);
    }
  });
});
