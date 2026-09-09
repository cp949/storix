import { RestoreTargetNotEmptyError } from './restore.errors.js';

describe('RestoreTargetNotEmptyError', () => {
  it('code는 RESTORE_TARGET_NOT_EMPTY, status는 409이다', () => {
    const error = new RestoreTargetNotEmptyError();

    expect(error.code).toBe('RESTORE_TARGET_NOT_EMPTY');
    expect(error.status).toBe(409);
  });
});
