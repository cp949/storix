import { NamespaceInvalidNameError } from '../namespace.errors.js';
import { parseCreateNamespaceRequest } from './create-namespace.dto.js';

describe('parseCreateNamespaceRequest', () => {
  it('유효한 name을 그대로 반환한다', () => {
    const result = parseCreateNamespaceRequest({ name: 'acme-01' });

    expect(result).toEqual({ name: 'acme-01' });
  });

  it('name이 없으면 NamespaceInvalidNameError를 던진다', () => {
    expect(() => parseCreateNamespaceRequest({})).toThrow(NamespaceInvalidNameError);
  });

  it('name에 대문자가 있으면 거부한다', () => {
    expect(() => parseCreateNamespaceRequest({ name: 'ACME' })).toThrow(NamespaceInvalidNameError);
  });

  it('name에 허용되지 않는 문자가 있으면 거부한다', () => {
    expect(() => parseCreateNamespaceRequest({ name: 'a/b' })).toThrow(NamespaceInvalidNameError);
  });

  it('name이 128자를 넘으면 거부한다', () => {
    expect(() => parseCreateNamespaceRequest({ name: 'a'.repeat(129) })).toThrow(NamespaceInvalidNameError);
  });

  it('name이 빈 문자열이면 거부한다', () => {
    expect(() => parseCreateNamespaceRequest({ name: '' })).toThrow(NamespaceInvalidNameError);
  });

  it('body가 객체가 아니면 거부한다', () => {
    expect(() => parseCreateNamespaceRequest(null)).toThrow(NamespaceInvalidNameError);
    expect(() => parseCreateNamespaceRequest('acme')).toThrow(NamespaceInvalidNameError);
  });

  it('encryptionPolicy 필드가 함께 와도 무시하고 name만 사용한다', () => {
    const result = parseCreateNamespaceRequest({ name: 'acme', encryptionPolicy: 'ENCRYPTED' });

    expect(result).toEqual({ name: 'acme' });
  });
});
