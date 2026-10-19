/**
 * 계약 fixture 생성기가 만든 tar·ZIP을 Python 표준 라이브러리로 읽어 구조가 올바른지 확인한다.
 * 계약이 손상 사례를 의도대로 만들려면 정상 사례가 먼저 유효해야 한다.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { tarBytes, tarGzBytes } from '../../src/support/tar-bytes.ts';
import { zipBytes } from '../../src/support/zip-bytes.ts';

const TAR = `
import io, json, sys, tarfile
data = sys.stdin.buffer.read()
with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as tar:
    out = []
    for member in tar.getmembers():
        body = tar.extractfile(member).read().decode() if member.isfile() else None
        out.append([member.name, 'dir' if member.isdir() else 'symlink' if member.issym() else 'file', body, member.linkname])
print(json.dumps(out))
`;

const ZIP = `
import io, json, sys, zipfile
data = sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(data)) as z:
    out = []
    for info in z.infolist():
        try:
            body = z.read(info).decode() if not info.is_dir() else None
        except zipfile.BadZipFile as error:
            body = 'BAD:' + str(error)
        out.append([info.filename, info.compress_type, body, info.external_attr >> 16])
print(json.dumps(out))
`;

const python = (script: string, input: Buffer): unknown =>
  JSON.parse(execFileSync('python3', ['-I', '-c', script], { input }).toString('utf8'));

describe('계약 fixture 생성기', () => {
  it('tar는 FILE·DIRECTORY·symlink와 본문을 표준 라이브러리가 읽는 형태로 만든다', () => {
    const entries = [
      { name: './', type: 'dir' as const },
      { name: 'a.txt', body: 'hello' },
      { name: 'big.bin', body: 'x'.repeat(1000) },
      { name: 'link', type: 'symlink' as const, linkName: '/etc/passwd' },
    ];
    const expected = [
      ['.', 'dir', null, ''],
      ['a.txt', 'file', 'hello', ''],
      ['big.bin', 'file', 'x'.repeat(1000), ''],
      ['link', 'symlink', null, '/etc/passwd'],
    ];
    assert.deepEqual(python(TAR, tarBytes(entries)), expected);
    assert.deepEqual(python(TAR, tarGzBytes(entries)), expected);
  });

  it('ZIP은 STORED·DEFLATE·DIRECTORY와 본문을 읽을 수 있고 CRC 덮어쓰기는 손상으로 읽힌다', () => {
    const [stored, deflated, directory, bad] = python(
      ZIP,
      zipBytes([
        { name: 'a.txt', body: 'stored' },
        { name: 'b.txt', body: 'deflated '.repeat(20), deflate: true },
        { name: 'dir/' },
        { name: 'bad.txt', body: 'bad', crc: 1 },
      ]),
    ) as [string, number, string | null, number][];
    assert.deepEqual(stored, ['a.txt', 0, 'stored', 0]);
    assert.deepEqual(deflated, ['b.txt', 8, 'deflated '.repeat(20), 0]);
    assert.deepEqual(directory, ['dir/', 0, null, 0]);
    assert.equal(bad[0], 'bad.txt');
    assert.match(String(bad[2]), /^BAD:/);
  });

  it('ZIP의 unixMode는 symlink 속성으로 읽히고 localName은 central 이름과 다르게 쓴다', () => {
    const bytes = zipBytes([
      { name: 'ln', body: '/etc/passwd', unixMode: 0o120777 },
      { name: 'aa', body: 'x', localName: 'bb' },
    ]);
    const [link] = python(ZIP, bytes) as [string, number, string, number][];
    assert.equal(link[0], 'ln');
    assert.equal(link[3], 0o120777);
    assert.ok(bytes.includes(Buffer.from('bb')));
  });
});
