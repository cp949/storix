// extract entry 이름 정규화·검증, 경로 길이, exclude 순서, 중복·조상 충돌, 순번, MIME 결정을 단위 테스트한다.
// 순수 클래스 단위 테스트이며 DB와 저장소를 쓰지 않는다. 규칙은 docs/design/17-file-extract.md "공개 계약"을 따른다.
import { ExtractEntryPlanner } from '../../src/vfs/extract-entry-plan.js';
import type { ExtractFormat } from '../../src/vfs/extract-format.js';
import { VfsExtractInvalidEntryError } from '../../src/vfs/vfs.errors.js';

function planner(
  format: ExtractFormat = 'zip',
  options: { exclude?: string[]; mimeTypes?: Record<string, string>; destination?: string[] } = {},
) {
  return new ExtractEntryPlanner({
    format,
    destinationSegments: options.destination ?? ['site'],
    exclude: options.exclude ?? [],
    mimeTypes: options.mimeTypes ?? {},
  });
}

/** plan이 던진 오류를 돌려준다. 던지지 않으면 null이다. */
function failure(run: () => unknown): VfsExtractInvalidEntryError | null {
  try {
    run();
  } catch (error) {
    return error as VfsExtractInvalidEntryError;
  }
  return null;
}

/** 길이가 n byte이고 segment가 99자이며 빈 segment가 없는 상대 경로를 만든다. */
function nameOfBytes(bytes: number): string {
  return `${'a'.repeat(99)}/`.repeat(Math.ceil(bytes / 100)).slice(0, bytes);
}

describe('ExtractEntryPlanner 이름 정규화', () => {
  it('tar 계열은 DIRECTORY ./만 건너뛰고 선행 ./를 벗긴다', () => {
    for (const format of ['tar', 'tar.gz'] as const) {
      const p = planner(format);
      expect(p.plan('./', 'DIRECTORY')).toBeNull();
      expect(p.plan('./a.txt', 'FILE')).toMatchObject({ name: 'a.txt', segments: ['a.txt'], type: 'FILE' });
      expect(p.plan('./dir/', 'DIRECTORY')).toMatchObject({
        name: 'dir',
        segments: ['dir'],
        type: 'DIRECTORY',
      });
      expect(p.count).toBe(2);
    }
  });

  it('DIRECTORY 표시의 끝 /는 한 개만 벗기고 FILE 이름은 그대로 둔다', () => {
    const p = planner();
    expect(p.plan('a/b/', 'DIRECTORY')).toMatchObject({ name: 'a/b', segments: ['a', 'b'] });
    expect(p.plan('a/b/c.txt', 'FILE')).toMatchObject({ name: 'a/b/c.txt', segments: ['a', 'b', 'c.txt'] });
  });

  it('ZIP과 그 밖의 이름은 ./ 예외 없이 거부한다', () => {
    const cases: [string, 'FILE' | 'DIRECTORY'][] = [
      ['./a', 'FILE'],
      ['./', 'DIRECTORY'],
      ['.', 'FILE'],
      ['.', 'DIRECTORY'],
      ['', 'FILE'],
      ['', 'DIRECTORY'],
      ['/', 'DIRECTORY'],
      ['///', 'DIRECTORY'],
      ['a//', 'DIRECTORY'],
      ['a/', 'FILE'],
      ['../x', 'FILE'],
      ['a/../b', 'FILE'],
      ['a/./b', 'FILE'],
      ['/abs', 'FILE'],
      ['C:/x', 'FILE'],
      ['c:x', 'FILE'],
      ['a\\b', 'FILE'],
      ['a\u0001b', 'FILE'],
      ['a\u007fb', 'FILE'],
      ['a\u202eb', 'FILE'],
      ['a\ud800b', 'FILE'],
      ['e\u0301.txt', 'FILE'],
    ];
    for (const [name, type] of cases) {
      const error = failure(() => planner('zip').plan(name, type));
      expect(error).toBeInstanceOf(VfsExtractInvalidEntryError);
      expect(error).toMatchObject({ code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 0, entryName: name });
    }
  });

  it('tar에서도 ./ 외의 빈 이름·.·/·./.는 거부한다', () => {
    const cases: [string, 'FILE' | 'DIRECTORY'][] = [
      ['.', 'FILE'],
      ['.', 'DIRECTORY'],
      ['/', 'DIRECTORY'],
      ['././a', 'FILE'],
      ['././', 'DIRECTORY'],
      ['', 'DIRECTORY'],
    ];
    for (const [name, type] of cases) {
      expect(failure(() => planner('tar').plan(name, type))).toMatchObject({
        code: 'VFS_EXTRACT_INVALID_ENTRY',
      });
    }
  });

  it('NFD 이름을 NFC로 바꾸지 않고 거부한다', () => {
    const nfd = '\u1112\u1161\u11ab.txt';
    expect(nfd.normalize('NFC')).not.toBe(nfd);
    expect(failure(() => planner().plan(nfd, 'FILE'))).toMatchObject({ entryName: nfd });
    expect(planner().plan(nfd.normalize('NFC'), 'FILE')).toMatchObject({ name: nfd.normalize('NFC') });
  });

  it('segment 255 byte와 destination을 합친 절대 경로 4096 byte가 경계다', () => {
    expect(planner().plan(`${'a'.repeat(255)}/b`, 'FILE')).not.toBeNull();
    expect(failure(() => planner().plan(`${'a'.repeat(256)}/b`, 'FILE'))).not.toBeNull();
    // '/site/' 6 byte + 이름 4090 byte = 4096 byte.
    expect(planner().plan(nameOfBytes(4090), 'FILE')).not.toBeNull();
    expect(failure(() => planner().plan(nameOfBytes(4091), 'FILE'))).toMatchObject({
      code: 'VFS_EXTRACT_INVALID_ENTRY',
    });
    // 이름 자체 상한 4095 byte. destination이 짧아도 넘으면 거부한다.
    expect(
      failure(() => planner('zip', { destination: ['d'] }).plan(nameOfBytes(4096), 'FILE')),
    ).not.toBeNull();
  });

  it('한글 이름은 UTF-8 byte 기준으로 길이를 센다', () => {
    // '한'은 3 byte라 85자가 segment 한도 255 byte다.
    expect(planner().plan(`${'한'.repeat(85)}/${'한'.repeat(85)}`, 'FILE')).not.toBeNull();
    expect(failure(() => planner().plan(`${'한'.repeat(86)}/b`, 'FILE'))).not.toBeNull();
  });
});

describe('ExtractEntryPlanner exclude와 순번', () => {
  it('이름 검증이 exclude보다 먼저라 위험한 이름을 제외 패턴으로 숨길 수 없다', () => {
    expect(failure(() => planner('zip', { exclude: ['**'] }).plan('../x', 'FILE'))).toMatchObject({
      code: 'VFS_EXTRACT_INVALID_ENTRY',
    });
  });

  it('제외된 entry는 세지 않고 순번은 선택한 entry 사이에서 0부터 이어진다', () => {
    const p = planner('zip', { exclude: ['skip', '**/.DS_Store'] });
    expect(p.plan('skip', 'FILE')).toBeNull();
    expect(p.plan('a/.DS_Store', 'FILE')).toBeNull();
    expect(p.plan('a', 'FILE')).toMatchObject({ entryIndex: 0 });
    expect(p.plan('skip/inner', 'FILE')).toBeNull();
    expect(p.plan('b', 'FILE')).toMatchObject({ entryIndex: 1 });
    expect(p.count).toBe(2);
  });

  it('제외 뒤 정상 entry 다음의 오류는 선택한 순번으로 보고한다', () => {
    const p = planner('zip', { exclude: ['skip'] });
    p.plan('skip', 'FILE');
    p.plan('a', 'FILE');
    expect(failure(() => p.plan('../x', 'FILE'))).toMatchObject({ entryIndex: 1, entryName: '../x' });
  });

  it('exclude는 정규화한 상대 이름에 적용하고 디렉터리 entry가 없어도 조상 패턴이 맞는다', () => {
    const p = planner('tar', { exclude: ['__MACOSX/**', 'node_modules'] });
    expect(p.plan('./__MACOSX/._a', 'FILE')).toBeNull();
    expect(p.plan('./node_modules/', 'DIRECTORY')).toBeNull();
    expect(p.plan('node_modules/pkg/index.js', 'FILE')).toBeNull();
    expect(p.plan('pkg/node_modules', 'FILE')).not.toBeNull();
  });

  it('제외한 entry끼리는 중복·충돌을 판정하지 않는다', () => {
    const p = planner('zip', { exclude: ['dup', 'a'] });
    expect(p.plan('dup', 'FILE')).toBeNull();
    expect(p.plan('dup', 'FILE')).toBeNull();
    expect(p.plan('a', 'FILE')).toBeNull();
    expect(p.plan('a/b', 'FILE')).toBeNull();
  });
});

describe('ExtractEntryPlanner 중복과 조상 충돌', () => {
  it('FILE 뒤 같은 경로의 DIRECTORY 조상 표시와 명시적 DIRECTORY는 허용한다', () => {
    const p = planner();
    expect(p.plan('dir/file', 'FILE')).not.toBeNull();
    expect(p.plan('dir/', 'DIRECTORY')).toMatchObject({ name: 'dir', type: 'DIRECTORY' });
  });

  it('명시적 DIRECTORY 두 개와 같은 경로의 FILE 두 개는 중복 오류다', () => {
    const dirs = planner();
    dirs.plan('dir/', 'DIRECTORY');
    expect(failure(() => dirs.plan('dir/', 'DIRECTORY'))).toMatchObject({ entryIndex: 1, entryName: 'dir/' });
    const files = planner();
    files.plan('a', 'FILE');
    expect(failure(() => files.plan('a', 'FILE'))).toMatchObject({ entryIndex: 1 });
  });

  it('같은 경로의 FILE과 DIRECTORY는 순서와 무관하게 거부한다', () => {
    const fileFirst = planner();
    fileFirst.plan('a', 'FILE');
    expect(failure(() => fileFirst.plan('a/', 'DIRECTORY'))).not.toBeNull();
    const dirFirst = planner();
    dirFirst.plan('a/', 'DIRECTORY');
    expect(failure(() => dirFirst.plan('a', 'FILE'))).not.toBeNull();
  });

  it('FILE a와 a/b는 두 순서 모두 거부한다', () => {
    const fileFirst = planner();
    fileFirst.plan('a', 'FILE');
    expect(failure(() => fileFirst.plan('a/b', 'FILE'))).toMatchObject({ entryIndex: 1, entryName: 'a/b' });
    const childFirst = planner();
    childFirst.plan('a/b', 'FILE');
    expect(failure(() => childFirst.plan('a', 'FILE'))).toMatchObject({ entryIndex: 1, entryName: 'a' });
    const deep = planner();
    deep.plan('x/y/z', 'FILE');
    expect(failure(() => deep.plan('x/y', 'FILE'))).not.toBeNull();
    expect(failure(() => deep.plan('x', 'FILE'))).not.toBeNull();
  });

  it('깊은 조상 FILE 아래의 entry도 거부한다', () => {
    const p = planner();
    p.plan('a/b', 'FILE');
    expect(failure(() => p.plan('a/b/c/d', 'FILE'))).not.toBeNull();
    expect(failure(() => p.plan('a/b/c/', 'DIRECTORY'))).not.toBeNull();
  });

  it('형제 경로와 접두어만 같은 이름은 충돌이 아니다', () => {
    const p = planner();
    p.plan('a', 'FILE');
    expect(p.plan('ab', 'FILE')).not.toBeNull();
    expect(p.plan('a.txt', 'FILE')).not.toBeNull();
    expect(p.plan('b/a', 'FILE')).not.toBeNull();
  });

  it('깊은 경로를 많이 넣어도 충돌 판정 상태가 경로 길이 제곱으로 늘지 않는다', () => {
    const p = planner();
    const started = Date.now();
    for (let i = 0; i < 300; i += 1) p.plan(`d${i}/${'x/'.repeat(1000)}f`, 'FILE');
    expect(p.count).toBe(300);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('ExtractEntryPlanner MIME', () => {
  it('확장자를 소문자로 비교해 mimeTypes map을 적용한다', () => {
    const p = planner('zip', { mimeTypes: { '.html': 'text/html', '.js': 'text/javascript' } });
    expect(p.plan('index.html', 'FILE')?.mimeType).toBe('text/html');
    expect(p.plan('INDEX.HTML', 'FILE')?.mimeType).toBe('text/html');
    expect(p.plan('a/app.min.js', 'FILE')?.mimeType).toBe('text/javascript');
  });

  it('.env·확장자 없음·map에 없는 확장자·map 없음은 application/octet-stream이다', () => {
    const p = planner('zip', { mimeTypes: { '.env': 'text/plain', '.html': 'text/html' } });
    expect(p.plan('.env', 'FILE')?.mimeType).toBe('application/octet-stream');
    expect(p.plan('Makefile', 'FILE')?.mimeType).toBe('application/octet-stream');
    expect(p.plan('image.png', 'FILE')?.mimeType).toBe('application/octet-stream');
    expect(p.plan('trailing.', 'FILE')?.mimeType).toBe('application/octet-stream');
    expect(planner().plan('index.html', 'FILE')?.mimeType).toBe('application/octet-stream');
  });

  it('DIRECTORY는 mimeTypes map을 쓰지 않는다', () => {
    const p = planner('zip', { mimeTypes: { '.d': 'text/plain' } });
    expect(p.plan('x.d/', 'DIRECTORY')?.mimeType).toBe('application/octet-stream');
  });
});
