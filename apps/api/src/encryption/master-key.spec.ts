import { parseMasterKey } from './master-key.js';

describe('parseMasterKey', () => {
  it('설정되지 않으면 null을 반환한다', () => {
    expect(parseMasterKey(undefined)).toBeNull();
  });

  it('빈 문자열이면 null을 반환한다', () => {
    expect(parseMasterKey('')).toBeNull();
  });

  it('hex 64자를 32바이트 Buffer로 변환한다', () => {
    const hex = 'a'.repeat(64);

    const key = parseMasterKey(hex);

    expect(key).toEqual(Buffer.from(hex, 'hex'));
    expect(key?.length).toBe(32);
  });

  it('길이가 64자가 아니면 에러를 던진다', () => {
    expect(() => parseMasterKey('a'.repeat(63))).toThrow('ENCRYPTION_MASTER_KEY');
  });

  it('hex가 아닌 문자가 섞이면 에러를 던진다', () => {
    expect(() => parseMasterKey('z'.repeat(64))).toThrow('ENCRYPTION_MASTER_KEY');
  });
});
