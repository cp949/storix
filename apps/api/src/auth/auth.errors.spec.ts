import { InvalidApiKeyError } from './auth.errors.js';

describe('InvalidApiKeyError', () => {
  it('code는 UNAUTHORIZED, status는 401이다', () => {
    const error = new InvalidApiKeyError();

    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.status).toBe(401);
    expect(error).toBeInstanceOf(Error);
  });
});
