import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it('올바른 UUID 형식이면 true를 반환한다', () => {
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it('UUID 형식이 아니면 false를 반환한다', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
