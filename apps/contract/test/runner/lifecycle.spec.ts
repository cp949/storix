/**
 * 실행 lifecycle의 자원 소유권과 실패 처리를 외부 프로세스 없는 대역으로 검증한다.
 * 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineContract } from '../../src/define-contract.ts';
import { ExecutionCleanupError } from '../../src/runner/cleanup.ts';
import { runContractLifecycle, type ContractLifecycleDependencies } from '../../src/runner/lifecycle.ts';
import { runProfileLifecycle } from '../../src/runner/profile-lifecycle.ts';

/** ES2023 lib 범위에서 테스트의 시작·재개 시점을 제어한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 공유 자원과 프로파일의 취득·정리 순서를 관찰한다. */
function fixture() {
  const events: string[] = [];
  const controller = new AbortController();
  const first = defineContract({ id: 'first', title: '첫 계약', rq: ['RQ-005'], async run() {} });
  const second = defineContract({
    id: 'second',
    title: '둘째 계약',
    rq: ['RQ-005'],
    profile: 'small-limits',
    async run() {},
  });
  const input = {
    groups: new Map([
      ['default', [first]],
      ['small-limits', [second]],
    ] as const),
    db: 'postgres' as const,
    signal: controller.signal,
  };
  const blob = {
    env: {},
    async stop() {
      events.push('blob-stop');
    },
    async interrupt() {},
    async resume() {},
    async ensureRunning() {},
    async deleteAllObjects() {},
  };
  const postgres = {
    container: 'pg',
    port: 5432,
    async stop() {
      events.push('postgres-stop');
    },
  };
  const dependencies: ContractLifecycleDependencies = {
    async createWorkDir() {
      events.push('workdir');
      return '/test-work';
    },
    async removeWorkDir(dir) {
      assert.equal(dir, '/test-work');
      events.push('workdir-remove');
    },
    createRunId() {
      return 'run';
    },
    async removeStaleContainers() {
      events.push('stale');
    },
    async startBlobStorage(runId) {
      assert.equal(runId, 'run');
      events.push('blob');
      return blob;
    },
    async startPostgres(runId) {
      assert.equal(runId, 'run');
      events.push('postgres');
      return postgres;
    },
    async stopServers() {
      events.push('servers-stop');
    },
    async runProfileLifecycle(current) {
      assert.equal(current.blob, blob);
      assert.equal(current.postgres, current.db === 'postgres' ? postgres : undefined);
      assert.equal(current.signal, controller.signal);
      assert.equal(current.workDir, '/test-work');
      events.push(`profile:${current.profile}`);
      return {
        contracts: current.contracts.map((contract) => ({
          id: contract.id,
          rq: contract.rq,
          passed: true,
          durationMs: 1,
        })),
        serverLogFile: `/test-work/${current.profile}.log`,
        cleanupErrors: [],
      };
    },
    cleanupTimeoutMs: 30_000,
    activeProfileGraceMs: 10_000,
  };
  return { input, dependencies, events, controller, blob, postgres };
}

// 정리 누락·정리 오류로 인한 원래 오류 덮어쓰기·실패 뒤 조기 종료를 고정한다.
describe('실행 lifecycle', () => {
  it('성공 디렉터리 삭제 도중 도착한 취소는 완료 경계를 지난 성공을 바꾸지 않는다', async () => {
    const current = fixture();
    const input = {
      ...current.input,
      onFinalizing: () => current.events.push('finalizing'),
    };
    current.dependencies.removeWorkDir = async () => {
      current.events.push('workdir-remove');
      current.controller.abort();
      await Promise.resolve();
    };
    const result = await runContractLifecycle(input, current.dependencies);
    assert.equal(result.exitCode, 0);
    assert.equal(result.workDir, undefined);
    assert.deepEqual(result.cleanupErrors, []);
    assert.deepEqual(current.events.slice(-6), [
      'servers-stop',
      'postgres-stop',
      'blob-stop',
      'stale',
      'finalizing',
      'workdir-remove',
    ]);
  });

  it('공유 자원을 한 번 준비하고 서버부터 역순 정리한 뒤 성공 디렉터리를 삭제한다', async () => {
    const current = fixture();
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 0);
    assert.equal(result.workDir, undefined);
    assert.deepEqual(result.summary, { passed: 2, failed: 0, exitCode: 0 });
    assert.deepEqual(result.cleanupErrors, []);
    assert.deepEqual(current.events, [
      'workdir',
      'stale',
      'blob',
      'postgres',
      'profile:default',
      'profile:small-limits',
      'servers-stop',
      'postgres-stop',
      'blob-stop',
      'stale',
      'workdir-remove',
    ]);
  });

  it('SQLite 실행은 Postgres를 준비하지 않는다', async () => {
    const current = fixture();
    const result = await runContractLifecycle({ ...current.input, db: 'sqlite' }, current.dependencies);
    assert.equal(result.exitCode, 0);
    assert.equal(current.events.includes('postgres'), false);
    assert.equal(current.events.includes('postgres-stop'), false);
  });

  it('계약 실패 뒤 모든 프로파일을 실행하고 작업 디렉터리와 실패 로그를 보존한다', async () => {
    const current = fixture();
    const runProfile = current.dependencies.runProfileLifecycle;
    current.dependencies.runProfileLifecycle = async (input) => {
      const result = await runProfile(input);
      return {
        ...result,
        contracts: result.contracts.map((entry) => ({ ...entry, passed: input.profile !== 'default' })),
      };
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(result.summary, { passed: 1, failed: 1, exitCode: 1 });
    assert.deepEqual(result.serverLogFiles, ['/test-work/default.log']);
    assert.ok(current.events.includes('profile:small-limits'));
    assert.equal(current.events.includes('workdir-remove'), false);
  });

  it('중간 정리가 실패해도 나머지 정리를 수행하고 작업 디렉터리를 보존한다', async () => {
    const current = fixture();
    const error = new Error('Postgres 정리 오류');
    current.postgres.stop = async () => {
      current.events.push('postgres-stop');
      throw error;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.cleanupErrors, [error]);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(current.events.slice(-4), ['servers-stop', 'postgres-stop', 'blob-stop', 'stale']);
  });

  it('실행 오류의 원래 값을 정리 오류보다 우선 보존한다', async () => {
    const current = fixture();
    const executionError = { reason: '원래 실행 오류' };
    const cleanupError = new Error('blob 정리 오류');
    current.dependencies.runProfileLifecycle = async () => {
      throw executionError;
    };
    current.blob.stop = async () => {
      current.events.push('blob-stop');
      throw cleanupError;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, executionError);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.equal(result.workDir, '/test-work');
    assert.ok(current.events.includes('stale'));
  });

  it('blob 준비 실패 뒤에도 잔여 컨테이너를 정리한다', async () => {
    const current = fixture();
    const error = new Error('blob 준비 오류');
    current.dependencies.startBlobStorage = async () => {
      throw error;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.error, error);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(current.events, ['workdir', 'stale', 'stale']);
  });

  it('정리 시간이 제한을 넘으면 오류를 기록하고 다음 정리를 수행한다', async () => {
    const current = fixture();
    current.dependencies.cleanupTimeoutMs = 5;
    current.postgres.stop = () => new Promise(() => {});
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.cleanupErrors.length, 1);
    assert.match(result.cleanupErrors[0]!.message, /Postgres.*5ms/);
    assert.ok(current.events.includes('blob-stop'));
    assert.equal(current.events.at(-1), 'stale');
  });

  it('SIGINT를 받으면 후속 프로파일을 실행하지 않고 정리 오류와 디렉터리를 보존한다', async () => {
    const current = fixture();
    const runProfile = current.dependencies.runProfileLifecycle;
    current.dependencies.runProfileLifecycle = async (input) => {
      current.controller.abort();
      return runProfile(input);
    };
    const cleanupError = new Error('서버 정리 오류');
    current.dependencies.stopServers = async () => {
      current.events.push('servers-stop');
      throw cleanupError;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 130);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.equal(current.events.includes('profile:small-limits'), false);
    assert.equal(current.events.at(-1), 'stale');
  });

  it('작업 디렉터리 생성 실패도 원래 오류로 반환한다', async () => {
    const current = fixture();
    const error = new Error('디렉터리 생성 오류');
    current.dependencies.createWorkDir = async () => {
      throw error;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, error);
    assert.equal(result.workDir, undefined);
    assert.deepEqual(result.cleanupErrors, []);
    assert.deepEqual(current.events, []);
  });

  it('blob 준비의 실행·정리 이중 오류를 분리해 반환한다', async () => {
    const current = fixture();
    const executionError = { source: 'blob' };
    const cleanupError = new Error('blob 기동 실패 정리 오류');
    current.dependencies.startBlobStorage = async () => {
      throw new ExecutionCleanupError(executionError, [cleanupError]);
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.error, executionError);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.workDir, '/test-work');
  });

  it('프로파일 실행 오류 전에 완료한 계약 결과와 서버 로그를 보존한다', async () => {
    const current = fixture();
    const executionError = new Error('저장소 복구 오류');
    const cleanupError = new Error('프로파일 서버 정리 오류');
    const profiles: string[] = [];
    current.blob.ensureRunning = async () => {
      throw executionError;
    };
    current.dependencies.runProfileLifecycle = (input) => {
      profiles.push(input.profile);
      return runProfileLifecycle(input, {
        prepareDatabase: () => ({ env: {} }),
        findFreePort: async () => 1234,
        startServer: async () => ({
          baseUrl: 'http://127.0.0.1:1',
          logFile: `/test-work/${input.profile}.log`,
          async stop() {
            throw cleanupError;
          },
          async restart() {},
        }),
        runContract: async (contract) => ({ id: contract.id, rq: contract.rq, passed: true, durationMs: 1 }),
      });
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, executionError);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.deepEqual(
      result.contracts.map((entry) => entry.id),
      ['first'],
    );
    assert.deepEqual(result.summary, { passed: 1, failed: 0, exitCode: 0 });
    assert.deepEqual(result.serverLogFiles, ['/test-work/default.log']);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(profiles, ['default']);
    assert.deepEqual(current.events.slice(-4), ['servers-stop', 'postgres-stop', 'blob-stop', 'stale']);
  });

  it('프로파일의 정리 오류만 있어도 종료 코드는 실패다', async () => {
    const current = fixture();
    const cleanupError = new Error('프로파일 서버 정리 오류');
    const runProfile = current.dependencies.runProfileLifecycle;
    current.dependencies.runProfileLifecycle = async (input) => {
      const outcome = await runProfile(input);
      return { ...outcome, cleanupErrors: input.profile === 'default' ? [cleanupError] : [] };
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.error, undefined);
    assert.equal(result.summary.passed, 2);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.workDir, '/test-work');
  });

  it('undefined로 던진 실행 오류도 성공으로 오인하지 않는다', async () => {
    const current = fixture();
    current.dependencies.runProfileLifecycle = async () => {
      throw undefined;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.ok('error' in result);
    assert.equal(result.error, undefined);
    assert.equal(result.workDir, '/test-work');
  });

  it('서버 기동 뒤 취소된 프로파일의 결과와 서버 로그를 보존하고 취소로 끝낸다', async () => {
    const current = fixture();
    const profiles: string[] = [];
    current.blob.ensureRunning = async () => {
      current.controller.abort();
      current.input.signal.throwIfAborted();
    };
    current.dependencies.runProfileLifecycle = (input) => {
      profiles.push(input.profile);
      return runProfileLifecycle(input, {
        prepareDatabase: () => ({ env: {} }),
        findFreePort: async () => 1234,
        startServer: async () => ({
          baseUrl: 'http://127.0.0.1:1',
          logFile: `/test-work/${input.profile}.log`,
          async stop() {},
          async restart() {},
        }),
        runContract: async (contract) => ({ id: contract.id, rq: contract.rq, passed: true, durationMs: 1 }),
      });
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 130);
    assert.equal((result.error as Error).name, 'AbortError');
    assert.deepEqual(
      result.contracts.map((entry) => entry.id),
      ['first'],
    );
    assert.deepEqual(result.serverLogFiles, ['/test-work/default.log']);
    assert.equal(result.workDir, '/test-work');
    assert.deepEqual(profiles, ['default']);
  });

  it('프로파일이 undefined 실행 오류를 반환해도 성공으로 오인하지 않는다', async () => {
    const current = fixture();
    const runProfile = current.dependencies.runProfileLifecycle;
    current.dependencies.runProfileLifecycle = async (input) => ({
      ...(await runProfile(input)),
      error: undefined,
    });
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.ok('error' in result);
    assert.equal(result.error, undefined);
    assert.equal(result.contracts.length, 1);
    assert.deepEqual(result.serverLogFiles, ['/test-work/default.log']);
    assert.equal(result.workDir, '/test-work');
    assert.equal(current.events.includes('profile:small-limits'), false);
  });

  it('성공 뒤 디렉터리 삭제가 실패하면 정리 오류와 경로를 반환한다', async () => {
    const current = fixture();
    const cleanupError = new Error('디렉터리 삭제 오류');
    current.dependencies.removeWorkDir = async () => {
      throw cleanupError;
    };
    const result = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
    assert.equal(result.workDir, '/test-work');
  });
});

// 취소 후 미완료 profile은 유예만 기다리고 서버 정리부터 실행한다.
describe('활성 프로파일 취소 유예', () => {
  it('기본 유예는 취소 후 10초까지 기다린 다음 정리를 시작한다', async (test) => {
    const current = fixture();
    test.mock.timers.enable({ apis: ['setTimeout'] });
    const started = deferred();
    current.dependencies.runProfileLifecycle = async () => {
      started.resolve();
      return new Promise(() => {});
    };
    const { activeProfileGraceMs: _grace, ...dependencies } = current.dependencies;
    const running = runContractLifecycle(current.input, dependencies);
    await started.promise;
    current.controller.abort();
    // 기본 시간 제한이 바뀌면 실제 cleanup 시작 경계가 달라진다.
    test.mock.timers.tick(9_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(current.events.includes('servers-stop'), false);
    test.mock.timers.tick(1);
    const outcome = await running;
    assert.equal(outcome.exitCode, 130);
    assert.deepEqual(current.events.slice(-4), ['servers-stop', 'postgres-stop', 'blob-stop', 'stale']);
  });

  it('유예 안에 끝난 profile의 결과를 보존하고 즉시 정리한다', async () => {
    const current = fixture();
    current.dependencies.activeProfileGraceMs = 100;
    const runProfile = current.dependencies.runProfileLifecycle;
    current.dependencies.runProfileLifecycle = async (input) => {
      current.controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runProfile(input);
    };
    const outcome = await runContractLifecycle(current.input, current.dependencies);
    assert.equal(outcome.exitCode, 130);
    assert.equal(outcome.contracts.length, 1);
    assert.equal(outcome.workDir, '/test-work');
    assert.equal(current.events.includes('profile:small-limits'), false);
  });

  it('미완료 profile을 기다리지 않고 유예 뒤 서버 정리를 마친 다음 공유 자원을 정리한다', async () => {
    const current = fixture();
    current.dependencies.activeProfileGraceMs = 20;
    const started = deferred();
    const release = deferred();
    const stopped = deferred();
    current.dependencies.runProfileLifecycle = async () => {
      started.resolve();
      await release.promise;
      throw new Error('유예 뒤 늦은 오류');
    };
    current.dependencies.stopServers = async () => {
      current.events.push('servers-stop');
      await stopped.promise;
      current.events.push('servers-stopped');
    };
    const running = runContractLifecycle(current.input, current.dependencies);
    await started.promise;
    current.controller.abort();
    // 두 번째 abort는 유예를 갱신하거나 cleanup을 생략하지 않는다.
    current.controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      assert.equal(current.events.at(-1), 'servers-stop');
      assert.equal(current.events.includes('postgres-stop'), false);
      stopped.resolve();
      const outcome = await running;
      assert.equal(outcome.exitCode, 130);
      assert.equal(outcome.workDir, '/test-work');
      assert.equal(outcome.contracts.length, 0);
      assert.deepEqual(current.events.slice(-5), [
        'servers-stop',
        'servers-stopped',
        'postgres-stop',
        'blob-stop',
        'stale',
      ]);
      assert.equal(current.events.includes('profile:small-limits'), false);
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stopped.resolve();
      release.resolve();
      await running;
    }
  });

  it('유예 뒤 재개한 실제 profile은 context 제어와 다음 계약 및 저장소 복구를 막는다', async () => {
    const current = fixture();
    current.dependencies.activeProfileGraceMs = 5;
    const started = deferred();
    const release = deferred();
    let active: ReturnType<typeof runProfileLifecycle> | undefined;
    current.blob.ensureRunning = async () => {
      current.events.push('ensure');
    };
    current.dependencies.runProfileLifecycle = (input) => {
      active = runProfileLifecycle(input, {
        prepareDatabase: () => ({ env: {} }),
        findFreePort: async () => 1234,
        startServer: async () => ({
          baseUrl: 'http://127.0.0.1:1',
          logFile: '/test-work/default.log',
          async stop() {
            current.events.push('profile-stop');
          },
          async restart() {
            current.events.push('restart');
          },
        }),
        async runContract(contract, context) {
          current.events.push(`contract:${contract.id}`);
          started.resolve();
          await release.promise;
          for (const action of [
            () => context.createNamespace(),
            () => context.server.restart(),
            () => context.blobStorage.start(),
            () => context.blobStorage.stop(),
            () => context.blobStorage.deleteAllObjects(),
          ])
            await assert.rejects(action, { name: 'AbortError' });
          return { id: contract.id, rq: contract.rq, passed: true, durationMs: 1 };
        },
      });
      return active;
    };
    const running = runContractLifecycle(current.input, current.dependencies);
    await started.promise;
    current.controller.abort();
    try {
      const outcome = await running;
      assert.equal(outcome.exitCode, 130);
      assert.equal(outcome.contracts.length, 0);
      release.resolve();
      await active;
      assert.equal(current.events.includes('restart'), false);
      assert.equal(current.events.includes('ensure'), false);
      assert.equal(current.events.includes('profile:small-limits'), false);
      assert.deepEqual(current.events.slice(-5), [
        'servers-stop',
        'postgres-stop',
        'blob-stop',
        'stale',
        'profile-stop',
      ]);
    } finally {
      release.resolve();
      await running;
      await active;
    }
  });
});
