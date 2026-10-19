// source 앞 byte의 magic으로 extract 형식 후보를 판별하는 규칙을 단위 테스트한다.
// 순수 함수 단위 테스트이며 확장자와 MIME은 쓰지 않는다. 규칙은 docs/design/17-file-extract.md "실행"을 따른다.
import { detectExtractFormat } from '../../src/vfs/extract-format.js';
import { buildTar, buildTarGz } from './tar-fixture.test-support.js';

describe('detectExtractFormat', () => {
  it('ZIP local header magic과 빈 ZIP magic을 zip으로 판별한다', () => {
    expect(detectExtractFormat(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 1)]))).toBe('zip');
    expect(detectExtractFormat(Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]))).toBe('zip');
    expect(detectExtractFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(detectExtractFormat(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe('zip');
  });

  it('PK 뒤 다른 magic은 zip이 아니다', () => {
    expect(detectExtractFormat(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBeNull();
    expect(detectExtractFormat(Buffer.from([0x50, 0x4b]))).toBeNull();
  });

  it('gzip magic은 내부 확인 전의 tar.gz 후보로 판별한다', () => {
    expect(detectExtractFormat(buildTarGz([{ name: 'a' }]).subarray(0, 512))).toBe('tar.gz');
    expect(detectExtractFormat(Buffer.from([0x1f, 0x8b]))).toBe('tar.gz');
  });

  it('offset 257의 ustar magic이 있으면 tar다', () => {
    expect(detectExtractFormat(buildTar([{ name: 'a', body: Buffer.from('x') }]).subarray(0, 512))).toBe(
      'tar',
    );
  });

  it('첫 512 byte가 전부 zero인 빈 tar 후보를 tar로 판별한다', () => {
    expect(detectExtractFormat(Buffer.alloc(1024).subarray(0, 512))).toBe('tar');
    expect(detectExtractFormat(Buffer.alloc(511))).toBeNull();
    const almost = Buffer.alloc(512);
    almost[511] = 1;
    expect(detectExtractFormat(almost)).toBeNull();
  });

  it('V7 tar, bzip2, 7z, xz, 짧은 입력, 빈 입력은 판별하지 않는다', () => {
    expect(detectExtractFormat(buildTar([{ name: 'a', ustar: false }]).subarray(0, 512))).toBeNull();
    expect(detectExtractFormat(Buffer.from('BZh91AY&SY'.padEnd(600, 'x')))).toBeNull();
    expect(
      detectExtractFormat(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, ...new Array(600).fill(1)])),
    ).toBeNull();
    expect(detectExtractFormat(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))).toBeNull();
    expect(detectExtractFormat(Buffer.from([1, 2, 3]))).toBeNull();
    expect(detectExtractFormat(Buffer.alloc(0))).toBeNull();
  });

  it('ustar magic이 있어도 head가 263 byte보다 짧으면 판별하지 않는다', () => {
    const head = buildTar([{ name: 'a' }]).subarray(0, 262);
    expect(detectExtractFormat(head)).toBeNull();
  });
});
