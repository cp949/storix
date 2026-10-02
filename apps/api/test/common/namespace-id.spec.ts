import { generateNamespaceId, isNamespaceId } from '../../src/common/namespace-id.js';

describe('isNamespaceId', () => {
  it('기존 하이픈 UUID와 소문자 prefix ID를 허용한다', () => {
    expect(isNamespaceId('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isNamespaceId('tenant_0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isNamespaceId('a'.repeat(32))).toBe(true);
    expect(isNamespaceId(`abcdefghijkl_${'a'.repeat(32)}`)).toBe(true);
  });

  it('대문자, 잘못된 prefix, 길이 초과 ID를 거부한다', () => {
    expect(isNamespaceId('Tenant_0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isNamespaceId('abcdefghijklmn_0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isNamespaceId(`abcdefghijkl_${'a'.repeat(33)}`)).toBe(false);
    expect(isNamespaceId('11111111-1111-1111-1111-11111111111A')).toBe(false);
  });

  it('prefix 미지정 ID는 하이픈 없는 UUID v4다', () => {
    const id = generateNamespaceId();

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id[12]).toBe('4');
    expect('89ab').toContain(id[16]);
  });

  it('prefix를 ID에 underscore로 결합한다', () => {
    const id = generateNamespaceId('tenant-2');

    expect(id).toMatch(/^tenant-2_[0-9a-f]{32}$/);
    expect(id).toHaveLength(41);
  });

  it('최대 길이 prefix는 최대 길이 Namespace ID를 만든다', () => {
    expect(generateNamespaceId('abcdefghijkl')).toHaveLength(45);
  });
});
