import {
  decodeNamespaceListCursor,
  encodeNamespaceListCursor,
} from '../../src/namespace/namespace-list-cursor.js';
import { VfsInvalidCursorError } from '../../src/vfs/vfs.errors.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';

describe('namespace 목록 cursor', () => {
  it('(name, id)를 인코딩하고 같은 값으로 디코딩한다', () => {
    const raw = encodeNamespaceListCursor({ name: 'member-1', id: ID });
    expect(raw).toMatch(/^nl1\.[A-Za-z0-9_-]+$/);
    expect(decodeNamespaceListCursor(raw)).toEqual({ name: 'member-1', id: ID });
  });

  it.each([
    ['접두어 없음', 'abc'],
    ['접두어만', 'nl1.'],
    ['base64url이 아님', 'nl1.@@@'],
    ['JSON이 아님', `nl1.${Buffer.from('not json').toString('base64url')}`],
    ['배열', `nl1.${Buffer.from('[]').toString('base64url')}`],
    ['필드 누락', `nl1.${Buffer.from(JSON.stringify({ name: 'a' })).toString('base64url')}`],
    ['추가 필드', `nl1.${Buffer.from(JSON.stringify({ name: 'a', id: ID, x: 1 })).toString('base64url')}`],
    ['id가 UUID가 아님', `nl1.${Buffer.from(JSON.stringify({ name: 'a', id: 'x' })).toString('base64url')}`],
    ['name 타입', `nl1.${Buffer.from(JSON.stringify({ name: 1, id: ID })).toString('base64url')}`],
    [
      'name 길이 초과',
      `nl1.${Buffer.from(JSON.stringify({ name: 'a'.repeat(129), id: ID })).toString('base64url')}`,
    ],
    [
      '비정규 표기(키 순서)',
      `nl1.${Buffer.from(JSON.stringify({ id: ID, name: 'a' })).toString('base64url')}`,
    ],
  ])('잘못된 cursor를 거부한다: %s', (_label, raw) => {
    expect(() => decodeNamespaceListCursor(raw)).toThrow(VfsInvalidCursorError);
  });

  it('인코딩 입력이 잘못되면 거부한다', () => {
    expect(() => encodeNamespaceListCursor({ name: '', id: ID })).toThrow(VfsInvalidCursorError);
    expect(() => encodeNamespaceListCursor({ name: 'a', id: 'x' })).toThrow(VfsInvalidCursorError);
  });

  it('입력 길이를 제한한다', () => {
    expect(() => decodeNamespaceListCursor(`nl1.${'A'.repeat(1024)}`)).toThrow(VfsInvalidCursorError);
  });
});
