import { decodeCursor, encodeCursor } from './keyset-cursor.js';

describe('keyset-cursor', () => {
  it('name과 id를 opaque cursor 문자열로 인코딩한다', () => {
    const cursor = encodeCursor({ name: 'a', id: '11111111-1111-1111-1111-111111111111' });

    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain('a');
  });

  it('인코딩한 cursor를 디코딩하면 원래 name/id를 복원한다', () => {
    const original = { name: 'report.pdf', id: '11111111-1111-1111-1111-111111111111' };

    const decoded = decodeCursor(encodeCursor(original));

    expect(decoded).toEqual(original);
  });

  it('base64 형식이 아닌 cursor는 null을 반환한다', () => {
    expect(decodeCursor('!!!not-base64!!!')).toBeNull();
  });

  it('name/id 형태가 아닌 JSON을 담은 cursor는 null을 반환한다', () => {
    const malformed = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');

    expect(decodeCursor(malformed)).toBeNull();
  });
});
