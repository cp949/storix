import {
  RestoreIncompleteBackupError,
  RestoreTargetNotEmptyError,
  RestoreUnsupportedBackupError,
} from '../../src/jobs/restore.errors.js';

describe('RestoreTargetNotEmptyError', () => {
  it('code는 RESTORE_TARGET_NOT_EMPTY, status는 409이다', () => {
    const error = new RestoreTargetNotEmptyError();

    expect(error.code).toBe('RESTORE_TARGET_NOT_EMPTY');
    expect(error.status).toBe(409);
  });
});

describe('RestoreUnsupportedBackupError', () => {
  it('code는 RESTORE_UNSUPPORTED_BACKUP, status는 422이며 디렉터리 이름을 메시지에 담는다', () => {
    const error = new RestoreUnsupportedBackupError(['a', 'b']);

    expect(error.code).toBe('RESTORE_UNSUPPORTED_BACKUP');
    expect(error.status).toBe(422);
    expect(error.message).toContain('a, b');
  });
});

describe('RestoreIncompleteBackupError', () => {
  it('code는 RESTORE_INCOMPLETE_BACKUP, status는 422이며 경로를 메시지에 담는다', () => {
    const error = new RestoreIncompleteBackupError('/backups/2026-10-05T00-00-00-000Z.partial');

    expect(error.code).toBe('RESTORE_INCOMPLETE_BACKUP');
    expect(error.status).toBe(422);
    expect(error.message).toContain('/backups/2026-10-05T00-00-00-000Z.partial');
  });
});
