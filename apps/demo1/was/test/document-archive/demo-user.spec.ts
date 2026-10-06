import { parseDemoUser } from '../../src/document-archive/demo-user.js';
import { DemoUserRequiredError } from '../../src/document-archive/document-archive.errors.js';

describe('parseDemoUser', () => {
  it('alice/bob은 그대로 반환한다', () => {
    expect(parseDemoUser('alice')).toBe('alice');
    expect(parseDemoUser('bob')).toBe('bob');
  });

  it('없거나 알 수 없는 값이면 DemoUserRequiredError를 던진다', () => {
    expect(() => parseDemoUser(undefined)).toThrow(DemoUserRequiredError);
    expect(() => parseDemoUser('charlie')).toThrow(DemoUserRequiredError);
  });
});
