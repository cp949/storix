// ZIP FILE 이름의 경로·Unicode·길이와 항목 사이의 충돌을 검증한다.
// 이름을 정규화하거나 재배열하지 않는다. 원본 FILE 종류·개수 검증은 capture 계층이 맡는다.
import { VfsArchiveInvalidRequestError } from './vfs.errors.js';

// Unicode property로 Bidi_Control 집합을 검사한다. path-resolver.ts와 같은 표기다.
const BIDI = /\p{Bidi_Control}/u;

/** ZIP FILE 상대 경로를 검사하고 입력 문자열을 그대로 반환한다. */
export function validateArchiveEntryName(name: string): string {
  const invalid =
    name.length === 0 ||
    name.normalize('NFC') !== name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[a-z]:/i.test(name) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name) ||
    /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/u.test(name) ||
    BIDI.test(name) ||
    Buffer.byteLength(name, 'utf8') > 4095 ||
    name
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255);
  if (invalid) throw new VfsArchiveInvalidRequestError();
  return name;
}

/** 중복 이름과 FILE 경로 조상 충돌을 검사한다. */
export function validateArchiveEntryNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    validateArchiveEntryName(name);
    if (seen.has(name)) throw new VfsArchiveInvalidRequestError();
    seen.add(name);
  }
  // 전체 이름을 먼저 고정해 입력 순서와 무관하게 FILE 조상을 찾는다.
  // 이전 이름 전체를 다시 순회하지 않는다.
  for (const name of names) {
    for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
      if (seen.has(name.slice(0, slash))) throw new VfsArchiveInvalidRequestError();
    }
  }
}
