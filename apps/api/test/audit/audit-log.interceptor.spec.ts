import { EventEmitter } from 'node:events';
import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { jest } from '@jest/globals';
import { of } from 'rxjs';
import { IS_PUBLIC_KEY } from '../../src/auth/public.decorator.js';
import { AuditLogInterceptor, resolveCallerId } from '../../src/audit/audit-log.interceptor.js';
import { sanitizeAuditString } from '../../src/audit/audit-string.js';
import { AUDITED_KEY } from '../../src/audit/audited.decorator.js';
import type { AuditLogEntry, AuditLogRepository } from '../../src/persistence/audit-log.repository.js';

function createContext(
  params: Record<string, string>,
  options: {
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    auditSnapshotId?: string;
  } = {},
) {
  const request = {
    requestId: 'req-1',
    params,
    query: options.query ?? {},
    body: options.body,
    auditSnapshotId: options.auditSnapshotId,
    headers: options.headers ?? {},
  };
  const response = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getClass: () => ({ name: 'FsController' }),
    getHandler: () => ({ name: 'mkdir' }),
  } as unknown as ExecutionContext;

  return { context, response };
}

describe('resolveCallerId', () => {
  it('헤더가 없으면 null을 반환한다', () => {
    expect(resolveCallerId(undefined)).toBeNull();
  });

  it('출력 가능한 ASCII 값이면 그대로 반환한다', () => {
    expect(resolveCallerId('billing-service')).toBe('billing-service');
  });

  it('제어 문자가 섞이면 null을 반환한다', () => {
    expect(resolveCallerId('bad\nvalue')).toBeNull();
  });

  it('200자를 넘으면 null을 반환한다', () => {
    expect(resolveCallerId('a'.repeat(201))).toBeNull();
  });

  it('배열로 전달되면 첫 번째 값만 본다', () => {
    expect(resolveCallerId(['first', 'second'])).toBe('first');
  });
});

// PostgreSQL jsonb는 lone surrogate를 거부하므로(`Unicode low surrogate must follow a high surrogate`)
// 정리 결과에는 짝이 맞지 않는 surrogate가 없어야 한다. GitHub 이슈 #14.
describe('sanitizeAuditString', () => {
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it('제어 문자를 제거한다', () => {
    expect(sanitizeAuditString('a\u0000b\nc')).toBe('abc');
  });

  it('온전한 surrogate pair는 그대로 둔다', () => {
    expect(sanitizeAuditString('a😀b')).toBe('a😀b');
  });

  it('입력의 lone high surrogate를 U+FFFD로 바꾼다', () => {
    expect(sanitizeAuditString('x\ud83dy')).toBe('x�y');
  });

  it('입력의 lone low surrogate를 U+FFFD로 바꾼다', () => {
    expect(sanitizeAuditString('x\ude00y')).toBe('x�y');
  });

  it('high surrogate가 연속되면 pair를 이루지 못한 앞쪽만 바꾼다', () => {
    expect(sanitizeAuditString('\ud83d😀')).toBe('�😀');
  });

  it('문자열 끝의 lone high surrogate도 바꾼다', () => {
    expect(sanitizeAuditString('x\ud83d')).toBe('x�');
  });

  it('4096 코드 유닛에서 자를 때 pair 중간이면 그 글자를 통째로 버린다', () => {
    const result = sanitizeAuditString('x'.repeat(4095) + '😀');

    expect(result).toBe('x'.repeat(4095));
    expect(result).not.toMatch(LONE_SURROGATE);
  });

  it('4096 코드 유닛에서 pair가 온전히 끝나면 유지한다', () => {
    const result = sanitizeAuditString('x'.repeat(4094) + '😀');

    expect(result).toBe('x'.repeat(4094) + '😀');
    expect(result).toHaveLength(4096);
  });

  it('제어 문자를 제거한 뒤의 길이를 기준으로 자른다', () => {
    const result = sanitizeAuditString('\u0000'.repeat(10) + 'x'.repeat(4096));

    expect(result).toBe('x'.repeat(4096));
  });
});

describe('AuditLogInterceptor', () => {
  let reflector: { getAllAndOverride: jest.Mock<(key: string, targets: unknown[]) => boolean | undefined> };
  let auditLogRepository: { record: jest.Mock<(entry: AuditLogEntry) => Promise<void>> };
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest
        .fn<(key: string, targets: unknown[]) => boolean | undefined>()
        .mockReturnValue(false),
    };
    auditLogRepository = {
      record: jest.fn<(entry: AuditLogEntry) => Promise<void>>().mockResolvedValue(undefined),
    };
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function createInterceptor(): AuditLogInterceptor {
    return new AuditLogInterceptor(
      reflector as unknown as Reflector,
      auditLogRepository as unknown as AuditLogRepository,
    );
  }

  it('@Public() 라우트는 기록하지 않는다', (done) => {
    reflector.getAllAndOverride.mockImplementation((key) => key === IS_PUBLIC_KEY);
    const { context, response } = createContext({});
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record).not.toHaveBeenCalled();
        done();
      });
  });

  it('@Public()이어도 @Audited() 라우트는 기록한다', (done) => {
    reflector.getAllAndOverride.mockImplementation((key) => key === IS_PUBLIC_KEY || key === AUDITED_KEY);
    const { context, response } = createContext({ namespaceId: '11111111-1111-1111-1111-111111111111' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record).toHaveBeenCalledWith(
          expect.objectContaining({ namespaceId: '11111111-1111-1111-1111-111111111111', status: 200 }),
        );
        done();
      });
  });

  it('응답이 끝나면 requestId/namespaceId/operation/path/status를 기록한다', (done) => {
    const { context, response } = createContext(
      { namespaceId: '11111111-1111-1111-1111-111111111111' },
      { query: { path: '/a.txt' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record).toHaveBeenCalledWith({
          requestId: 'req-1',
          namespaceId: '11111111-1111-1111-1111-111111111111',
          operation: 'FsController.mkdir',
          path: '/a.txt',
          detail: null,
          caller: null,
          snapshotId: null,
          trashId: null,
          status: 200,
        });
        done();
      });
  });

  it('namespace 라우트처럼 params.id만 있으면 이를 namespaceId로 기록한다', (done) => {
    const { context, response } = createContext({ id: '22222222-2222-2222-2222-222222222222' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({
          namespaceId: '22222222-2222-2222-2222-222222222222',
        });
        done();
      });
  });

  it('params.id가 UUID 형식이 아니면 namespaceId를 null로 기록한다', (done) => {
    const { context, response } = createContext({ id: 'not-a-uuid' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ namespaceId: null });
        done();
      });
  });

  it('X-Caller-Id 헤더 값을 caller로 기록한다', (done) => {
    const { context, response } = createContext(
      { namespaceId: 'ns-1' },
      { headers: { 'x-caller-id': 'billing-service' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ caller: 'billing-service' });
        done();
      });
  });

  it('mv/cp처럼 body에 source/destination이 있으면 detail에 담는다', (done) => {
    const { context, response } = createContext(
      { namespaceId: 'ns-1' },
      { body: { source: '/a.txt', destination: '/b.txt' } },
    );
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({
          detail: { source: '/a.txt', destination: '/b.txt' },
        });
        done();
      });
  });

  it('namespace 생성처럼 body에 name이 있으면 detail에 담는다', (done) => {
    const { context, response } = createContext({}, { body: { name: 'acme', encryptionPolicy: 'NONE' } });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ detail: { name: 'acme' } });
        done();
      });
  });

  it('기록 실패는 요청을 막지 않고 에러 로그만 남긴다(best-effort)', (done) => {
    auditLogRepository.record.mockRejectedValue(new Error('db down'));
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const handler: CallHandler = { handle: () => of({ ok: true }) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.emit('close');
        queueMicrotask(() => {
          expect(errorSpy).toHaveBeenCalled();
          done();
        });
      });
  });

  it('구독 이후 상태 코드가 바뀌어도(@HttpCode 등) 최종 상태를 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    const handler: CallHandler = { handle: () => of(undefined) };

    createInterceptor()
      .intercept(context, handler)
      .subscribe(() => {
        response.statusCode = 204;
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ status: 204 });
        done();
      });
  });

  it('응답 전에 클라이언트가 연결을 끊으면 기본 statusCode 200 대신 499를 기록한다', (done) => {
    const { context, response } = createContext({ namespaceId: 'ns-1' });
    response.writableFinished = false;

    createInterceptor()
      .intercept(context, { handle: () => of({ ok: true }) })
      .subscribe(() => {
        response.emit('close');
        expect(auditLogRepository.record.mock.calls[0][0]).toMatchObject({ status: 499 });
        done();
      });
  });

  it('snapshotId 파라미터와 생성용 명시 문맥만 기록하고 목록에는 기록하지 않는다', (done) => {
    const { context, response } = createContext({
      namespaceId: '11111111-1111-1111-1111-111111111111',
      snapshotId: '0195f6a0-7c1b-7d3e-8a4f-1234567890ab',
    });
    createInterceptor()
      .intercept(context, { handle: () => of({}) })
      .subscribe(() => {
        response.emit('close');
        const { context: createContextValue, response: createResponse } = createContext(
          {},
          { auditSnapshotId: '0195f6a0-7c1b-7d3e-8a4f-1234567890ac' },
        );
        createInterceptor()
          .intercept(createContextValue, { handle: () => of({}) })
          .subscribe(() => {
            createResponse.emit('close');
            const { context: listContext, response: listResponse } = createContext({
              namespaceId: '11111111-1111-1111-1111-111111111111',
            });
            createInterceptor()
              .intercept(listContext, { handle: () => of({}) })
              .subscribe(() => {
                listResponse.emit('close');
                expect(auditLogRepository.record.mock.calls.map(([entry]) => entry.snapshotId)).toEqual([
                  '0195f6a0-7c1b-7d3e-8a4f-1234567890ab',
                  '0195f6a0-7c1b-7d3e-8a4f-1234567890ac',
                  null,
                ]);
                done();
              });
          });
      });
  });

  describe('raw 파서 라우트의 Buffer body', () => {
    // mutations·snapshot·trash 변경 라우트는 raw() 파서를 거쳐 body가 Buffer다.
    function recordedEntry(body: unknown): Promise<AuditLogEntry> {
      return new Promise((resolve) => {
        const { context, response } = createContext({ namespaceId: 'ns-1' }, { body });
        createInterceptor()
          .intercept(context, { handle: () => of({ ok: true }) })
          .subscribe(() => {
            response.emit('close');
            resolve(auditLogRepository.record.mock.calls[0][0]);
          });
      });
    }

    const jsonBuffer = (value: unknown) => Buffer.from(JSON.stringify(value));

    it('mutations delete의 path와 kind를 기록한다', async () => {
      const entry = await recordedEntry(
        jsonBuffer({ kind: 'delete', path: '/secret/a.txt', ifRevision: 'r1' }),
      );
      expect(entry).toMatchObject({ path: '/secret/a.txt', detail: { kind: 'delete' } });
    });

    it('mutations move의 source·destination과 kind를 detail에 담는다', async () => {
      const entry = await recordedEntry(
        jsonBuffer({ kind: 'move', source: '/a.txt', destination: '/b.txt' }),
      );
      expect(entry).toMatchObject({
        path: null,
        detail: { kind: 'move', source: '/a.txt', destination: '/b.txt' },
      });
    });

    it('trash restore의 targetPath를 detail에 담는다', async () => {
      const entry = await recordedEntry(jsonBuffer({ targetPath: '/restored/a.txt' }));
      expect(entry).toMatchObject({ path: null, detail: { targetPath: '/restored/a.txt' } });
    });

    it.each([
      ['잘못된 JSON', Buffer.from('{"path":')],
      ['빈 본문', Buffer.alloc(0)],
      ['배열', jsonBuffer([{ path: '/a' }])],
      ['원시값', jsonBuffer('/a')],
    ])('%s이면 path·detail을 null로 기록한다', async (_label, body) => {
      const entry = await recordedEntry(body);
      expect(entry).toMatchObject({ path: null, detail: null });
    });

    it('문자열이 아닌 kind·targetPath는 기록하지 않는다', async () => {
      const entry = await recordedEntry(jsonBuffer({ kind: 1, targetPath: ['/a'], path: '/b' }));
      expect(entry).toMatchObject({ path: '/b', detail: null });
    });
  });
});
