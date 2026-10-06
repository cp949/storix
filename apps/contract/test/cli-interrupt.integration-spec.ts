/**
 * 실제 Docker·빌드된 API·SQLite/Postgres에서 CLI의 SIGINT 정리와 로그 보존을 검증한다.
 * 규칙은 docs/design/12-contract-checks.md "중단과 정리".
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_MAIN } from '../src/runner/paths.ts';
import { waitUntil } from '../src/runner/wait.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DEFINE_CONTRACT = new URL('../src/define-contract.ts', import.meta.url).href;

/** 중단한 실행의 컨테이너가 정리됐는지 확인한다. */
function containers(): string {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'name=storix-contract-'], {
    encoding: 'utf-8',
  }).trim();
}

/** 다른 실행의 보존 로그를 지우지 않도록 기존 작업 디렉터리를 구분한다. */
function workDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => /^storix-contract-[A-Za-z0-9]{6}$/.test(name)));
}

/**
 * `ps` 출력 상한. 기본값 1MiB는 프로세스가 많거나 인자가 긴 호스트에서 `ENOBUFS`로 넘친다.
 * 조회가 던지면 정리가 CLI를 죽이기 전에 끝나 테스트 프로세스가 종료되지 않았다(issue #11).
 */
const PS_MAX_BUFFER = 64 * 1024 * 1024;

/** API PID를 CLI의 직접 자식으로 한정한다. 다른 실행의 서버는 포함하지 않는다. */
function serverPids(cliPid: number): number[] {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf-8', maxBuffer: PS_MAX_BUFFER })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match && Number(match[2]) === cliPid && match[3]!.includes(API_MAIN) ? [Number(match[1])] : [];
    });
}

/**
 * 아직 종료하지 않은 CLI. 테스트나 정리가 중간에 던져도 파일 끝에서 남은 CLI를 죽여야 한다.
 * CLI가 살아 있으면 stdout 파이프가 열려 `node:test` 프로세스가 끝나지 않는다.
 */
const liveClis = new Set<ChildProcess>();

after(() => {
  for (const cli of liveClis) cli.kill('SIGKILL');
});

/** stdout·stderr와 종료 신호를 함께 수집한다. close 이후에는 출력이 모두 도착했다. */
function startCli(args: string[]) {
  const cli = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  liveClis.add(cli);
  let output = '';
  let closed = false;
  cli.stdout.setEncoding('utf-8').on('data', (chunk: string) => (output += chunk));
  cli.stderr.setEncoding('utf-8').on('data', (chunk: string) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    cli.once('close', (code, signal) => {
      closed = true;
      liveClis.delete(cli);
      resolve({ code, signal });
    });
  });
  return {
    cli,
    output: () => output,
    async exit(timeoutMs = 45_000) {
      await waitUntil(async () => closed, {
        timeoutMs,
        intervalMs: 20,
        description: `CLI 정리와 종료\n${output}`,
      });
      return exited;
    },
  };
}

/** CLI가 출력한 보존 경로가 이번 실행의 실제 작업 디렉터리와 같아야 한다. */
function assertRetainedWorkDir(before: ReadonlySet<string>, output: string): void {
  const added = [...workDirs()].filter((name) => !before.has(name));
  assert.equal(added.length, 1, output);
  const retained = path.join(tmpdir(), added[0]!);
  assert.ok(existsSync(retained));
  assert.equal(/작업 디렉터리를 보존했다: (.+)/.exec(output)?.[1], retained, output);
}

/** 실패해도 이번 테스트가 띄운 CLI·API·컨테이너와 검사한 임시 파일을 정리한다. */
async function cleanup(run: ReturnType<typeof startCli>, before: ReadonlySet<string>, pids: number[]) {
  const ownedPids = new Set(pids);
  // 서버 PID 조회가 실패해도 CLI는 반드시 죽여야 한다. 조회 실패는 경고만 남긴다.
  try {
    for (const pid of serverPids(run.cli.pid!)) ownedPids.add(pid);
  } catch (error) {
    console.warn(`서버 PID 조회에 실패해 이미 알려진 PID만 정리한다: ${(error as Error).message}`);
  }
  run.cli.kill('SIGKILL');
  await run.exit();
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const leftover = containers().split('\n').filter(Boolean);
  if (leftover.length > 0) execFileSync('docker', ['rm', '-f', '-v', ...leftover]);
  for (const name of workDirs()) {
    if (!before.has(name)) await rm(path.join(tmpdir(), name), { recursive: true, force: true });
  }
}

// 컨테이너 취득 시점과 실제 HTTP 요청 수신 시점을 관찰한 뒤 OS 신호를 보낸다.
describe('CLI 중단(SIGINT)', () => {
  it('취소되지 않는 interval 계약도 유예 뒤 CLI를 130으로 종료한다', { timeout: 90_000 }, async () => {
    const before = workDirs();
    const contractsDir = await mkdtemp(path.join(tmpdir(), 'storix-unabortable-contracts-'));
    await writeFile(
      path.join(contractsDir, 'active.ts'),
      `
import { defineContract } from ${JSON.stringify(DEFINE_CONTRACT)};
export default defineContract({
  id: 'lifecycle-unabortable', title: '취소를 따르지 않는 활성 계약을 검증한다', rq: ['RQ-001'],
  async run(ctx) {
    setInterval(() => {}, 1_000);
    console.log('LIFECYCLE_UNABORTABLE ' + ctx.baseUrl);
    await new Promise(() => {});
  },
});
`,
    );
    const run = startCli(['--db', 'sqlite', '--contracts-dir', contractsDir]);
    let pids: number[] = [];
    try {
      await waitUntil(async () => run.output().includes('LIFECYCLE_UNABORTABLE '), {
        timeoutMs: 30_000,
        intervalMs: 20,
        description: '취소되지 않는 계약의 interval 시작',
      });
      const baseUrl = /LIFECYCLE_UNABORTABLE (http:\/\/127\.0\.0\.1:\d+)/.exec(run.output())?.[1];
      assert.ok(baseUrl, run.output());
      pids = serverPids(run.cli.pid!);
      assert.equal(pids.length, 1, run.output());
      assert.equal((await fetch(`${baseUrl}/health/ready`)).status, 200);
      assert.ok(run.cli.kill('SIGINT'));
      // 기본 10초 유예와 자원 정리가 끝나도 interval이 살아 있으면 이 상한을 넘는다.
      assert.deepEqual(await run.exit(15_000), { code: 130, signal: null }, run.output());
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await assert.rejects(fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) }));
      assert.equal(containers(), '');
      assertRetainedWorkDir(before, run.output());
    } finally {
      await cleanup(run, before, pids);
      await rm(contractsDir, { recursive: true, force: true });
    }
  });

  it(
    'VersityGW가 준비되기를 기다리는 중에 중단하면 자원을 정리하고 작업 디렉터리를 보존한다',
    { timeout: 90_000 },
    async () => {
      const before = workDirs();
      const run = startCli([]);
      let pids: number[] = [];
      try {
        await waitUntil(async () => containers().length > 0, {
          timeoutMs: 30_000,
          intervalMs: 20,
          description: 'VersityGW 컨테이너 생성',
        });
        pids = serverPids(run.cli.pid!);
        assert.deepEqual(pids, []);
        assert.doesNotMatch(run.output(), /프로필 /);
        assert.ok(run.cli.kill('SIGINT'));
        assert.deepEqual(await run.exit(), { code: 130, signal: null }, run.output());
        assert.equal(containers(), '');
        assertRetainedWorkDir(before, run.output());
        assert.doesNotMatch(run.output(), /프로필 /);
      } finally {
        await cleanup(run, before, pids);
      }
    },
  );

  for (const db of ['sqlite', 'postgres'] as const) {
    it(`${db} 활성 계약의 HTTP 요청을 중단하고 서버·컨테이너를 정리한다`, { timeout: 180_000 }, async () => {
      const before = workDirs();
      const contractsDir = await mkdtemp(path.join(tmpdir(), 'storix-interrupt-contracts-'));
      let requestStarted = false;
      // 응답하지 않는 loopback HTTP 서버로 신호가 실제 fetch에 전달됐는지 확인한다.
      const pending = createServer(() => {
        requestStarted = true;
      });
      await new Promise<void>((resolve) => pending.listen(0, '127.0.0.1', resolve));
      const address = pending.address();
      assert.ok(address !== null && typeof address !== 'string');
      const pendingUrl = `http://127.0.0.1:${address.port}/pending`;
      await writeFile(
        path.join(contractsDir, '01-active.ts'),
        `import assert from 'node:assert/strict';
import { defineContract } from ${JSON.stringify(DEFINE_CONTRACT)};
export default defineContract({
  id: 'lifecycle-active', title: '실제 HTTP 요청에 취소를 전달한다', rq: ['RQ-001'],
  async run(ctx) {
    assert.equal((await ctx.client.request('GET', '/health/ready')).status, 200);
    console.log('LIFECYCLE_ACTIVE ' + ctx.baseUrl);
    await assert.rejects(fetch(${JSON.stringify(pendingUrl)}, { signal: ctx.signal }), { name: 'AbortError' });
    console.log('LIFECYCLE_ABORTED');
  },
});
`,
      );
      for (const [name, profile] of [
        ['02-next', 'default'],
        ['03-profile', 'change-feed'],
      ] as const) {
        await writeFile(
          path.join(contractsDir, `${name}.ts`),
          `import { defineContract } from ${JSON.stringify(DEFINE_CONTRACT)};
export default defineContract({
  id: 'lifecycle-${name}', title: '취소 후 후속 실행을 감지한다', rq: ['RQ-001'], profile: '${profile}',
  async run() { console.log('LIFECYCLE_UNEXPECTED_NEXT'); throw new Error('취소 후 실행'); },
});
`,
        );
      }
      const run = startCli(['--db', db, '--contracts-dir', contractsDir]);
      let pids: number[] = [];
      try {
        await waitUntil(async () => requestStarted && run.output().includes('LIFECYCLE_ACTIVE '), {
          timeoutMs: 120_000,
          intervalMs: 20,
          description: '활성 계약 HTTP 요청 수신',
        });
        const baseUrl = /LIFECYCLE_ACTIVE (http:\/\/127\.0\.0\.1:\d+)/.exec(run.output())?.[1];
        assert.ok(baseUrl, run.output());
        pids = serverPids(run.cli.pid!);
        assert.equal(pids.length, 1, run.output());
        process.kill(pids[0]!, 0);
        const names = execFileSync(
          'docker',
          ['ps', '--format', '{{.Names}}', '--filter', 'name=storix-contract-'],
          {
            encoding: 'utf-8',
          },
        );
        assert.match(names, /storix-contract-vgw-/);
        if (db === 'postgres') assert.match(names, /storix-contract-pg-/);
        assert.ok(run.cli.kill('SIGINT'));
        assert.deepEqual(await run.exit(), { code: 130, signal: null }, run.output());
        assert.match(run.output(), /LIFECYCLE_ABORTED/);
        assert.doesNotMatch(run.output(), /LIFECYCLE_UNEXPECTED_NEXT|프로필 change-feed/);
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        await assert.rejects(fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) }));
        assert.equal(containers(), '');
        assertRetainedWorkDir(before, run.output());
      } finally {
        pending.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          pending.close((error) => (error ? reject(error) : resolve())),
        );
        await cleanup(run, before, pids);
        await rm(contractsDir, { recursive: true, force: true });
      }
    });
  }
});
