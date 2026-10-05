import { jest } from '@jest/globals';
import {
  dropParserErrorCode,
  isMutationJsonRoute,
  isRawUploadRoute,
  isSnapshotJsonMutationRoute,
} from '../../src/common/body-parser.js';

describe('isRawUploadRoute', () => {
  it('conditional raw content route bypasses JSON parsing', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content/conditional' })).toBe(
      true,
    );
  });
  it('POST .../fs/content 요청이면 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content' })).toBe(true);
  });

  it('GET .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'GET', path: '/api/v2/namespaces/abc/fs/content' })).toBe(false);
  });

  it('PUT .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v2/namespaces/abc/fs/content' })).toBe(false);
  });

  it('POST이지만 다른 경로면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mkdir' })).toBe(false);
  });

  it('trailing slash가 있어도 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content/' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(FS) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/FS/content' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(CONTENT) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/CONTENT' })).toBe(true);
  });
});

describe('isMutationJsonRoute', () => {
  it('matches only the new JSON mutation endpoint', () => {
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mutations' })).toBe(true);
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mkdir' })).toBe(false);
    expect(isMutationJsonRoute({ method: 'GET', path: '/api/v2/namespaces/abc/fs/mutations' })).toBe(false);
  });
});

describe('snapshot JSON mutation routes', () => {
  const base = '/api/v2/namespaces/abc/fs/snapshots';
  const id = '550e8400-e29b-41d4-a716-446655440000';
  it.each(['', `/${id}/restore`, `/${id}/delete`])('raw JSON을 보존한다: %s', (suffix) => {
    expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(true);
    expect(isSnapshotJsonMutationRoute({ method: 'post', path: (base + suffix).toUpperCase() + '/' })).toBe(
      true,
    );
  });
  it.each(['/invalid-id/restore', '/invalid-id/delete'])('%s도 raw JSON으로 읽는다', (suffix) => {
    expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(true);
  });
  it.each(['GET', 'PUT', 'DELETE'])('다른 method는 매칭하지 않는다: %s', (method) => {
    expect(isSnapshotJsonMutationRoute({ method, path: base })).toBe(false);
  });
  it.each(['/content', '/entries', `/${id}`, `/${id}/delete/extra`, 'extra'])(
    '다른 경로는 매칭하지 않는다: %s',
    (suffix) => {
      expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(false);
    },
  );
});

describe('dropParserErrorCode', () => {
  const run = (error: unknown): unknown => {
    const next = jest.fn<(error?: unknown) => void>();
    dropParserErrorCode(error, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    return next.mock.calls[0][0];
  };

  it('status와 문자열 code가 있는 파서 오류는 code를 지우고 status·message·type을 유지한다', () => {
    const zlibError = Object.assign(new Error('incorrect header check'), {
      status: 400,
      code: 'Z_DATA_ERROR',
    });

    const passed = run(zlibError) as Error & { status: number; code?: string };

    expect(passed).toMatchObject({ message: 'incorrect header check', status: 400 });
    expect(passed.code).toBeUndefined();
  });

  it('code가 없는 파서 오류는 같은 객체를 그대로 넘긴다', () => {
    const syntaxError = Object.assign(new Error('Unexpected token'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    expect(run(syntaxError)).toBe(syntaxError);
  });

  it('status가 없는 오류는 code가 있어도 그대로 넘긴다', () => {
    const systemError = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    expect(run(systemError)).toBe(systemError);
  });
});
