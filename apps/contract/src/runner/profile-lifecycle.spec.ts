/**
 * 프로파일별 DB·서버 준비와 계약 순서를 주입한 대역으로 검증한다.
 * 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineContract, type Contract, type ProfileName } from '../define-contract.ts';
import type { BlobStorageHandle } from './blob-storage.ts';
import {
  runProfileLifecycle,
  type ProfileLifecycleDependencies,
  type ProfileLifecycleInput,
} from './profile-lifecycle.ts';
import type { ContractResult } from './run.ts';

/** 자원 제어 호출 순서를 기록하는 프로파일 입력과 대역을 만든다. */
function fixture(profile: ProfileName = 'default') {
  const events: string[] = [];
  const controller = new AbortController();
  const contracts = ['first', 'second'].map((id) =>
    defineContract({ id, title: id, rq: ['RQ-005'], profile, async run() {} }),
  );
  const blob: BlobStorageHandle = {
    env: {},
    async stop() {
      events.push('blob-stop');
    },
    async interrupt() {},
    async resume() {},
    async ensureRunning() {
      events.push('ensure');
    },
    async deleteAllObjects() {},
  };
  const input: ProfileLifecycleInput = {
    profile,
    contracts,
    workDir: '/test-work',
    runId: 'run',
    db: 'sqlite',
    blob,
    signal: controller.signal,
  };
  const server = {
    baseUrl: 'http://127.0.0.1:1234',
    logFile: `/test-work/${profile}.server.log`,
    async stop() {
      events.push('server-stop');
    },
    async restart() {
      events.push('restart');
    },
  };
  const dependencies: ProfileLifecycleDependencies = {
    cleanupTimeoutMs: 30_000,
    prepareDatabase(current) {
      events.push(`database:${current.db}:${current.profile}`);
      return { env: { STORIX_DB_DRIVER: current.db } };
    },
    async findFreePort() {
      return 1234;
    },
    async writeCapabilitiesConfig(configPath, contents) {
      events.push('config');
      assert.equal(configPath, '/test-work/change-feed.capabilities.json');
      assert.deepEqual(JSON.parse(contents), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: {},
      });
    },
    async startServer(options) {
      events.push('server-start');
      assert.equal(options.env.STORIX_DB_DRIVER, input.db);
      assert.equal(options.label, profile);
      if (profile === 'change-feed') {
        assert.equal(
          options.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH,
          '/test-work/change-feed.capabilities.json',
        );
      }
      return server;
    },
    async provisionCapabilityNamespaces(current) {
      events.push('provision');
      assert.equal(current.count, 4);
      assert.deepEqual(current.capabilities, ['change-feed']);
      await current.restart();
      return [{ id: 'prepared', name: 'prepared' }];
    },
    async runContract(contract, context) {
      events.push(`contract:${contract.id}`);
      if (profile === 'change-feed' && contract.id === 'first') {
        assert.deepEqual(await context.createNamespace(), { id: 'prepared', name: 'prepared' });
      }
      return result(contract);
    },
  };
  return { input, dependencies, events, controller, server };
}

/** 계약 메타데이터를 보존한 실행 결과를 만든다. */
function result(contract: Contract, passed = true): ContractResult {
  return { id: contract.id, rq: contract.rq, passed, durationMs: 1 };
}

// 외부 프로세스 없이 lifecycle을 실행해 결과 실패와 운영 오류의 처리 차이를 고정한다.
describe('프로파일 실행 lifecycle', () => {
  it('계약 실패 결과 뒤에도 다음 계약을 실행하고 서버를 종료한다', async () => {
    const current = fixture();
    current.dependencies.runContract = async (contract) => {
      current.events.push(`contract:${contract.id}`);
      return result(contract, contract.id !== 'first');
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.deepEqual(
      outcome.contracts.map((entry) => entry.passed),
      [false, true],
    );
    assert.equal(outcome.serverLogFile, current.server.logFile);
    assert.deepEqual(current.events, [
      'database:sqlite:default',
      'server-start',
      'contract:first',
      'ensure',
      'contract:second',
      'ensure',
      'server-stop',
    ]);
  });

  it('계약 실행 운영 오류를 전달하고 서버를 종료한다', async () => {
    const current = fixture();
    const error = new Error('계약 실행 운영 오류');
    current.dependencies.runContract = async () => {
      throw error;
    };
    await assert.rejects(
      runProfileLifecycle(current.input, current.dependencies),
      (actual) => actual === error,
    );
    assert.deepEqual(current.events, ['database:sqlite:default', 'server-start', 'server-stop']);
  });

  it('capability 설정과 provision 및 restart 뒤 계약을 순차 실행한다', async () => {
    const current = fixture('change-feed');
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.contracts.length, 2);
    assert.deepEqual(current.events, [
      'database:sqlite:change-feed',
      'config',
      'server-start',
      'provision',
      'restart',
      'contract:first',
      'ensure',
      'contract:second',
      'ensure',
      'server-stop',
    ]);
  });

  it('provision 오류가 발생해도 서버를 종료한다', async () => {
    const current = fixture('change-feed');
    const error = new Error('provision 오류');
    current.dependencies.provisionCapabilityNamespaces = async () => {
      throw error;
    };
    await assert.rejects(
      runProfileLifecycle(current.input, current.dependencies),
      (actual) => actual === error,
    );
    assert.deepEqual(current.events, [
      'database:sqlite:change-feed',
      'config',
      'server-start',
      'server-stop',
    ]);
  });

  it('프로파일마다 DB와 서버를 새로 준비한다', async () => {
    const first = fixture();
    const second = fixture('small-limits');
    await runProfileLifecycle(first.input, first.dependencies);
    await runProfileLifecycle(
      {
        ...second.input,
        db: 'postgres',
        postgres: {
          container: 'pg',
          port: 5432,
          async stop() {},
        },
      },
      {
        ...second.dependencies,
        async startServer(options) {
          second.events.push('server-start');
          assert.equal(options.env.STORIX_DB_DRIVER, 'postgres');
          return second.server;
        },
      },
    );
    assert.equal(first.events[0], 'database:sqlite:default');
    assert.equal(second.events[0], 'database:postgres:small-limits');
    assert.equal(first.events.filter((event) => event === 'server-start').length, 1);
    assert.equal(second.events.filter((event) => event === 'server-start').length, 1);
  });

  it('계약 실행 중 취소되면 저장소 복구와 다음 계약을 시작하지 않는다', async () => {
    const current = fixture();
    current.dependencies.runContract = async (contract) => {
      current.events.push(`contract:${contract.id}`);
      current.controller.abort();
      return result(contract);
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.contracts.length, 1);
    assert.deepEqual(current.events, [
      'database:sqlite:default',
      'server-start',
      'contract:first',
      'server-stop',
    ]);
  });

  for (const phase of ['contract', 'provision'] as const) {
    it(`${phase} 실행 오류와 서버 정리 오류를 모두 보존한다`, async () => {
      const current = fixture(phase === 'provision' ? 'change-feed' : 'default');
      const executionError = { phase };
      const cleanupError = new Error('서버 정리 오류');
      if (phase === 'contract')
        current.dependencies.runContract = async () => {
          throw executionError;
        };
      else
        current.dependencies.provisionCapabilityNamespaces = async () => {
          throw executionError;
        };
      current.server.stop = async () => {
        current.events.push('server-stop');
        throw cleanupError;
      };
      await assert.rejects(runProfileLifecycle(current.input, current.dependencies), (actual) => {
        assert.equal((actual as { executionError: unknown }).executionError, executionError);
        assert.deepEqual((actual as { cleanupErrors: Error[] }).cleanupErrors, [cleanupError]);
        return true;
      });
      assert.equal(current.events.at(-1), 'server-stop');
    });
  }

  it('계약 성공 뒤 서버 정리 오류는 결과와 함께 반환한다', async () => {
    const current = fixture();
    const cleanupError = new Error('서버 정리 오류');
    current.server.stop = async () => {
      throw cleanupError;
    };
    const result = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(result.contracts.length, 2);
    assert.deepEqual(result.cleanupErrors, [cleanupError]);
  });
});

// 기동과 provision의 늦은 완료가 취소 뒤 새 부수 효과로 이어지지 않아야 한다.
describe('프로파일 취소 경계', () => {
  for (const phase of ['port', 'config', 'server', 'provision'] as const) {
    it(`${phase} 준비 뒤 취소를 검사한다`, async () => {
      const current = fixture('change-feed');
      if (phase === 'port')
        current.dependencies.findFreePort = async () => {
          current.controller.abort();
          return 1234;
        };
      if (phase === 'config')
        current.dependencies.writeCapabilitiesConfig = async () => {
          current.events.push('config');
          current.controller.abort();
        };
      if (phase === 'server')
        current.dependencies.startServer = async () => {
          current.events.push('server-start');
          current.controller.abort();
          return current.server;
        };
      if (phase === 'provision')
        current.dependencies.provisionCapabilityNamespaces = async (input) => {
          assert.equal(input.signal, current.controller.signal);
          current.events.push('provision');
          current.controller.abort();
          await input.restart();
          return [];
        };
      await assert.rejects(runProfileLifecycle(current.input, current.dependencies), { name: 'AbortError' });
      const expected = ['database:sqlite:change-feed'];
      if (phase !== 'port') expected.push('config');
      if (phase === 'server' || phase === 'provision') expected.push('server-start');
      if (phase === 'provision') expected.push('provision');
      if (phase === 'server' || phase === 'provision') expected.push('server-stop');
      assert.deepEqual(current.events, expected);
    });
  }

  it('취소 뒤 늦게 끝난 계약은 다음 계약과 저장소 복구를 실행하지 않는다', async () => {
    const current = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    current.dependencies.runContract = async (contract, context) => {
      current.events.push(`contract:${contract.id}`);
      started.resolve();
      await release.promise;
      assert.equal(context.signal, current.controller.signal);
      for (const action of [() => context.server.restart(), () => context.blobStorage.start()]) {
        await assert.rejects(action, { name: 'AbortError' });
      }
      return result(contract);
    };
    const running = runProfileLifecycle(current.input, current.dependencies);
    await started.promise;
    current.controller.abort();
    release.resolve();
    const outcome = await running;
    assert.equal(outcome.contracts.length, 1);
    assert.deepEqual(current.events, [
      'database:sqlite:default',
      'server-start',
      'contract:first',
      'server-stop',
    ]);
  });
});
