// 직접 만든 fixture가 아니라 Python 표준 라이브러리(tarfile·zipfile)가 만든 archive를 reader와 planner에 통과시킨다.
// 파일 내용 SHA-256이 원본과 같고 이름이 규칙을 통과하는지 확인해 실제 도구 산출물과의 호환을 고정한다.
// python3가 없으면 실패한다. archive 테스트도 같은 전제를 쓴다. 규칙은 docs/design/17-file-extract.md "실행".
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { ExtractEntryPlanner } from '../../src/vfs/extract-entry-plan.js';
import type { ExtractFormat } from '../../src/vfs/extract-format.js';
import { readTarEntries, type ExtractSourceEntry } from '../../src/vfs/tar-reader.js';
import { readZipEntries } from '../../src/vfs/zip-reader.js';
import { bufferRanges } from './zip-fixture.test-support.js';

/** 기준 트리와 archive를 만드는 Python 스크립트다. 출력 디렉터리는 첫 인자다. */
const PYTHON = String.raw`
import io, os, sys, tarfile, zipfile, hashlib, json
out = sys.argv[1]
files = {
    'a.txt': b'hello',
    '한글/파일.txt': '안녕'.encode(),
    'spaces and symbols/(x) [y].txt': b'sym',
    'd' * 40 + '/' + 'e' * 40 + '/' + 'f' * 40 + '/long.txt': b'long',
    'zero.bin': b'',
    'big.bin': bytes(2 * 1024 * 1024),
    'mixed.bin': bytes((i * 31 + (i >> 8)) % 251 for i in range(300000)),
}
dirs = ['empty', 'deep/er']
json.dump({k: hashlib.sha256(v).hexdigest() for k, v in files.items()}, open(os.path.join(out, 'expected.json'), 'w'))

def add_tar(tar):
    for d in dirs:
        info = tarfile.TarInfo(d); info.type = tarfile.DIRTYPE; info.mode = 0o755
        tar.addfile(info)
    for name, data in files.items():
        info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
        tar.addfile(info, io.BytesIO(data))

for label, fmt in (('gnu', tarfile.GNU_FORMAT), ('pax', tarfile.PAX_FORMAT)):
    with tarfile.open(os.path.join(out, label + '.tar'), 'w', format=fmt) as tar: add_tar(tar)
    with tarfile.open(os.path.join(out, label + '.tar.gz'), 'w:gz', format=fmt) as tar: add_tar(tar)

class Stream:
    # seek할 수 없는 출력은 zipfile이 data descriptor(bit 3)를 쓰게 만든다.
    def __init__(self, f): self.f = f
    def write(self, b): return self.f.write(b)
    def flush(self): self.f.flush()

for label, method in (('deflate', zipfile.ZIP_DEFLATED), ('stored', zipfile.ZIP_STORED)):
    with zipfile.ZipFile(os.path.join(out, label + '.zip'), 'w', method) as z:
        for d in dirs: z.writestr(d + '/', b'')
        for name, data in files.items(): z.writestr(name, data)
    with open(os.path.join(out, label + '-stream.zip'), 'wb') as f:
        with zipfile.ZipFile(Stream(f), 'w', method) as z:
            for d in dirs: z.writestr(d + '/', b'')
            for name, data in files.items(): z.writestr(name, data)
`;

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** archive 파일을 읽어 선택된 FILE의 이름→SHA-256과 DIRECTORY 이름을 돌려준다. */
async function extractAll(directory: string, file: string, format: ExtractFormat) {
  const planner = new ExtractEntryPlanner({
    format,
    destinationSegments: ['site'],
    exclude: [],
    mimeTypes: {},
  });
  const signal = new AbortController().signal;
  let entries: AsyncGenerator<ExtractSourceEntry>;
  if (format === 'zip') {
    entries = readZipEntries({ ...bufferRanges(await readFile(join(directory, file)), 4096), signal });
  } else {
    const raw = createReadStream(join(directory, file));
    entries = readTarEntries(format === 'tar.gz' ? raw.pipe(createGunzip()) : raw, {
      maxHeaderBytes: 65536,
      signal,
    });
  }
  const files: Record<string, string> = {};
  const directories: string[] = [];
  for await (const entry of entries) {
    const planned = planner.plan(entry.name, entry.type);
    if (!planned) continue;
    if (planned.type === 'DIRECTORY') directories.push(planned.name);
    else files[planned.name] = sha(await toBuffer(await entry.open()));
  }
  return { files, directories: directories.sort() };
}

describe('실제 도구가 만든 archive', () => {
  let directory: string;
  let expected: Record<string, string>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'storix-extract-tools-'));
    execFileSync('python3', ['-I', '-c', PYTHON, directory]);
    expected = JSON.parse(await readFile(join(directory, 'expected.json'), 'utf8')) as Record<string, string>;
  }, 60000);

  afterAll(async () => rm(directory, { recursive: true, force: true }));

  it.each([
    ['gnu.tar', 'tar'],
    ['pax.tar', 'tar'],
    ['gnu.tar.gz', 'tar.gz'],
    ['pax.tar.gz', 'tar.gz'],
    ['deflate.zip', 'zip'],
    ['stored.zip', 'zip'],
    ['deflate-stream.zip', 'zip'],
    ['stored-stream.zip', 'zip'],
  ] as const)(
    '%s의 FILE 내용과 빈 DIRECTORY를 그대로 읽는다',
    async (file, format) => {
      const result = await extractAll(directory, file, format);
      expect(result.files).toEqual(expected);
      expect(result.directories).toEqual(expect.arrayContaining(['empty']));
    },
    60000,
  );

  it('스트리밍 ZIP은 bit 3 data descriptor를 쓴 파일이다', async () => {
    const bytes = await readFile(join(directory, 'deflate-stream.zip'));
    expect(bytes.readUInt16LE(6) & 0x08).toBe(0x08);
  });
});
