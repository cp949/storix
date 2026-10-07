/**
 * 프로파일별 DB·서버 준비와 계약 순서를 주입한 대역으로 검증한다.
 * 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineContract, type Contract, type ProfileName } from '../../src/define-contract.ts';
import type { BlobStorageHandle } from '../../src/runner/blob-storage.ts';
import {
  runProfileLifecycle,
  type ProfileLifecycleDependencies,
  type ProfileLifecycleInput,
} from '../../src/runner/profile-lifecycle.ts';
import type { ContractResult } from '../../src/runner/run.ts';

/** ES2023 lib 범위에서 테스트의 시작·재개 시점을 제어한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  it('업로드 정책이 없는 프로파일은 정책 재시작 요청을 명시적으로 거부한다', async () => {
    const current = fixture('default');
    current.dependencies.runContract = async (contract, context) => {
      await assert.rejects(
        () =>
          context.server.restartWithUploadSessionLimits({
            namespaceId: 'prepared',
            maxStagedBytes: '8',
          }),
        /현재 프로파일에는 업로드 세션 정책이 없다/,
      );
      return result(contract);
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.contracts[0]?.passed, true);
    assert.equal(current.events.includes('restart'), false);
  });

  it('계약별 업로드 정책을 재시작으로 적용하고 계약 종료 전에 기준 정책으로 복원한다', async () => {
    const current = fixture('resumable-upload');
    const writes: { path: string; value: Record<string, unknown> }[] = [];
    current.dependencies.writeCapabilitiesConfig = async (path, contents) => {
      writes.push({ path, value: JSON.parse(contents) as Record<string, unknown> });
    };
    current.dependencies.provisionCapabilityNamespaces = async (input) => {
      await input.prepareRestart?.([{ id: 'prepared', name: 'prepared' }]);
      await input.restart();
      return [{ id: 'prepared', name: 'prepared' }];
    };
    current.dependencies.runContract = async (contract, context) => {
      current.events.push(`contract:${contract.id}`);
      if (contract.id === 'first') {
        await assert.rejects(
          () =>
            context.server.restartWithUploadSessionLimits({
              namespaceId: 'unknown',
              maxStagedBytes: '8',
            }),
          /준비하지 않은 namespace ID/,
        );
        await assert.rejects(
          () =>
            context.server.restartWithUploadSessionLimits({
              namespaceId: 'prepared',
              maxStagedBytes: '8',
              partSizeBytes: 9,
            }),
          /staging 한도 이하/,
        );
        await context.server.restartWithUploadSessionLimits({
          namespaceId: 'prepared',
          maxStagedBytes: '8',
          partSizeBytes: 2,
        });
      }
      return result(contract);
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.contracts.length, 2);
    const policyWrites = writes.filter((entry) =>
      entry.path.endsWith('resumable-upload.upload-sessions.json'),
    );
    assert.equal(policyWrites.length, 4);
    const changed = policyWrites[2].value.namespaces as Record<
      string,
      { maxStagedBytes: string; partSizeBytes: number }
    >;
    assert.deepEqual(changed.prepared, {
      maxStagedBytes: '8',
      maxActiveSessions: 100,
      partSizeBytes: 2,
    });
    assert.equal((policyWrites[2].value.global as { maxStagedBytes: string }).maxStagedBytes, '1048576');
    assert.deepEqual(policyWrites[3].value, policyWrites[1].value);
    assert.deepEqual(
      current.events.filter((event) => event === 'restart'),
      ['restart', 'restart', 'restart'],
    );
    assert.ok(
      current.events.indexOf('restart', current.events.indexOf('contract:first')) <
        current.events.indexOf('contract:second'),
    );
  });

  it('정책을 바꾼 계약이 실패해도 다음 계약 전에 baseline을 복원한다', async () => {
    const current = fixture('resumable-upload');
    const writes: Record<string, unknown>[] = [];
    current.dependencies.writeCapabilitiesConfig = async (path, contents) => {
      if (path.endsWith('resumable-upload.upload-sessions.json'))
        writes.push(JSON.parse(contents) as Record<string, unknown>);
    };
    current.dependencies.provisionCapabilityNamespaces = async (input) => {
      await input.prepareRestart?.([{ id: 'prepared', name: 'prepared' }]);
      await input.restart();
      return [{ id: 'prepared', name: 'prepared' }];
    };
    current.dependencies.runContract = async (contract, context) => {
      await context.server.restartWithUploadSessionLimits({ namespaceId: 'prepared', maxStagedBytes: '8' });
      if (contract.id === 'first') throw new Error('계약 실행 실패');
      return result(contract);
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.ok(outcome.error instanceof Error);
    assert.equal(writes.length, 4);
    assert.deepEqual(writes[3], writes[1]);
    assert.equal(current.events.filter((event) => event === 'server-stop').length, 1);
  });

  it('baseline 복원 실패 뒤에는 다음 계약을 실행하지 않고 lifecycle 오류로 반환한다', async () => {
    const current = fixture('resumable-upload');
    let policyWrites = 0;
    current.dependencies.writeCapabilitiesConfig = async (path) => {
      if (!path.endsWith('resumable-upload.upload-sessions.json')) return;
      policyWrites += 1;
      if (policyWrites === 4) throw new Error('baseline 복원 실패');
    };
    current.dependencies.provisionCapabilityNamespaces = async (input) => {
      await input.prepareRestart?.([{ id: 'prepared', name: 'prepared' }]);
      await input.restart();
      return [{ id: 'prepared', name: 'prepared' }];
    };
    current.dependencies.runContract = async (contract, context) => {
      current.events.push(`contract:${contract.id}`);
      await context.server.restartWithUploadSessionLimits({ namespaceId: 'prepared', maxStagedBytes: '8' });
      return result(contract);
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal((outcome.error as Error).message, 'baseline 복원 실패');
    assert.deepEqual(
      current.events.filter((event) => event.startsWith('contract:')),
      ['contract:first'],
    );
    assert.equal(current.events.at(-1), 'server-stop');
  });

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

  it('계약 실행 운영 오류를 결과로 반환하고 서버를 종료한다', async () => {
    const current = fixture();
    const error = new Error('계약 실행 운영 오류');
    current.dependencies.runContract = async () => {
      throw error;
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.error, error);
    assert.deepEqual(outcome.contracts, []);
    assert.equal(outcome.serverLogFile, current.server.logFile);
    assert.deepEqual(current.events, ['database:sqlite:default', 'server-start', 'server-stop']);
  });

  it('저장소 복구 오류 전에 완료한 계약 결과와 서버 로그를 오류와 함께 반환한다', async () => {
    const current = fixture();
    const error = new Error('저장소 복구 오류');
    current.input.blob.ensureRunning = async () => {
      current.events.push('ensure');
      throw error;
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.error, error);
    assert.deepEqual(
      outcome.contracts.map((entry) => entry.id),
      ['first'],
    );
    assert.equal(outcome.serverLogFile, current.server.logFile);
    assert.deepEqual(outcome.cleanupErrors, []);
    assert.deepEqual(current.events, [
      'database:sqlite:default',
      'server-start',
      'contract:first',
      'ensure',
      'server-stop',
    ]);
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

  it('undefined 실행 오류도 실행 실패로 반환한다', async () => {
    const current = fixture();
    current.dependencies.runContract = async () => {
      throw undefined;
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.ok('error' in outcome);
    assert.equal(outcome.error, undefined);
    assert.equal(current.events.at(-1), 'server-stop');
  });

  it('서버 기동 전 오류는 결과 없이 거부한다', async () => {
    const current = fixture();
    const error = new Error('서버 기동 오류');
    current.dependencies.startServer = async () => {
      current.events.push('server-start');
      throw error;
    };
    await assert.rejects(
      runProfileLifecycle(current.input, current.dependencies),
      (actual) => actual === error,
    );
    assert.deepEqual(current.events, ['database:sqlite:default', 'server-start']);
  });

  it('provision 오류가 발생해도 서버를 종료한다', async () => {
    const current = fixture('change-feed');
    const error = new Error('provision 오류');
    current.dependencies.provisionCapabilityNamespaces = async () => {
      throw error;
    };
    const outcome = await runProfileLifecycle(current.input, current.dependencies);
    assert.equal(outcome.error, error);
    assert.deepEqual(outcome.contracts, []);
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
      const outcome = await runProfileLifecycle(current.input, current.dependencies);
      assert.equal(outcome.error, executionError);
      assert.deepEqual(outcome.cleanupErrors, [cleanupError]);
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
      // 서버 기동 전 취소는 거부한다.
      // 서버 기동 뒤 취소는 서버 로그 경로와 함께 반환한다.
      if (phase === 'port' || phase === 'config') {
        await assert.rejects(runProfileLifecycle(current.input, current.dependencies), {
          name: 'AbortError',
        });
      } else {
        const outcome = await runProfileLifecycle(current.input, current.dependencies);
        assert.equal((outcome.error as Error).name, 'AbortError');
        assert.equal(outcome.serverLogFile, current.server.logFile);
      }
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
    const started = deferred();
    const release = deferred();
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

// resumable-upload는 capability 설정과 별개로 유한한 세션 정책 파일이 있어야 서버가 기동·재시작된다.
describe('resumable-upload 프로파일의 세션 정책 설정', () => {
  it('처음에는 namespace 없는 정책으로 기동하고, 재시작 전에 준비한 namespace를 담아 다시 쓴다', async () => {
    const current = fixture('resumable-upload');
    const written = new Map<string, unknown[]>();
    current.dependencies.writeCapabilitiesConfig = async (configPath, contents) => {
      current.events.push(`write:${configPath}`);
      written.set(configPath, [...(written.get(configPath) ?? []), JSON.parse(contents)]);
    };
    current.dependencies.startServer = async (options) => {
      current.events.push('server-start');
      assert.equal(
        options.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH,
        '/test-work/resumable-upload.capabilities.json',
      );
      assert.equal(
        options.env.STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH,
        '/test-work/resumable-upload.upload-sessions.json',
      );
      return current.server;
    };
    current.dependencies.provisionCapabilityNamespaces = async (input) => {
      current.events.push('provision');
      assert.deepEqual(input.capabilities, ['resumable-upload']);
      const namespaces = [{ id: 'prepared', name: 'prepared' }];
      await input.prepareRestart?.(namespaces);
      await input.restart();
      return namespaces;
    };
    current.dependencies.runContract = async (contract) => result(contract);
    await runProfileLifecycle(current.input, current.dependencies);

    const sessions = written.get('/test-work/resumable-upload.upload-sessions.json') as Array<{
      namespaces: Record<string, unknown>;
    }>;
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[0].namespaces, {});
    assert.deepEqual(Object.keys(sessions[1].namespaces), ['prepared']);
    // 기동 전에 정책 파일이 있고, 재시작 전에 namespace가 담긴 정책 파일이 다시 쓰여야 한다.
    const sessionWrites = current.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'write:/test-work/resumable-upload.upload-sessions.json')
      .map(({ index }) => index);
    assert.ok(sessionWrites[0] < current.events.indexOf('server-start'));
    assert.ok(sessionWrites[1] > current.events.indexOf('provision'));
    assert.ok(sessionWrites[1] < current.events.indexOf('restart'));
  });

  it('다른 capability 프로파일은 세션 정책 설정을 쓰지 않는다', async () => {
    const current = fixture('change-feed');
    const paths: string[] = [];
    const write = current.dependencies.writeCapabilitiesConfig;
    current.dependencies.writeCapabilitiesConfig = async (configPath, contents) => {
      paths.push(configPath);
      await write(configPath, contents);
    };
    const start = current.dependencies.startServer;
    current.dependencies.startServer = async (options) => {
      assert.equal('STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH' in options.env, false);
      return start(options);
    };
    await runProfileLifecycle(current.input, current.dependencies);
    assert.deepEqual(paths, ['/test-work/change-feed.capabilities.json']);
  });
});
