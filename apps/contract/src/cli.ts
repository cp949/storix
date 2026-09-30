/**
 * 계약 검증 CLI 진입점.
 * 인자는 `parseArgs` 정의가 원천이다. 실행 흐름은 docs/design/12-contract-checks.md "실행 흐름".
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { removeStaleContainers, startBlobStorage } from './runner/blob-storage.ts';
import { startPostgres } from './runner/postgres.ts';
import { runProfileLifecycle } from './runner/profile-lifecycle.ts';
import { CONTRACTS_DIR } from './runner/paths.ts';
import {
  discoverContracts,
  findUncoveredRqs,
  groupByProfile,
  selectContracts,
  shuffle,
  validateContracts,
} from './runner/registry.ts';
import { loadRequirementIds } from './runner/rq.ts';
import { runContract, summarize, type ContractResult } from './runner/run.ts';
import { refuseNewServers, stopAllServers } from './runner/server.ts';

/** 종료 시 거꾸로 실행할 정리 작업. SIGINT도 같은 목록을 실행한다. */
const cleanups: Array<() => Promise<void>> = [];

/** SIGINT를 받았는가. 정리 중 들어오는 반복 신호를 무시하고 중단 뒤의 진행·오류 출력을 막는 데 쓴다. */
let interrupted = false;

/** 프로파일이 중단 뒤 저장소 복구와 다음 계약 실행을 시작하지 않게 한다. */
const abortController = new AbortController();

/** 작업 디렉터리를 지우지 않고 남길지. 실패·오류 종료에서 서버 로그를 확인할 수 있게 한다. */
let keepWorkDir = false;

/** 오류 종료 때 보존한 작업 디렉터리를 알리려고 기록한다. */
let workDirForError: string | undefined;

async function runCleanups(): Promise<void> {
  for (let cleanup = cleanups.pop(); cleanup !== undefined; cleanup = cleanups.pop()) {
    try {
      await cleanup();
    } catch (error) {
      console.error('정리 실패:', error);
    }
  }
}

function printResult(result: ContractResult): void {
  const mark = result.passed ? '✔' : '✘';
  console.log(`${mark} ${result.id} (${result.rq.join(', ')}) ${result.durationMs}ms`);
  if (!result.passed) {
    for (const line of (result.error ?? '').split('\n')) {
      console.log(`    ${line}`);
    }
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: 'sqlite' },
      shuffle: { type: 'boolean', default: false },
      coverage: { type: 'boolean', default: false },
      'contracts-dir': { type: 'string' },
    },
  });

  const discovered = await discoverContracts(values['contracts-dir'] ?? CONTRACTS_DIR);
  const knownRqIds = await loadRequirementIds();
  const errors = validateContracts(discovered, new Set(knownRqIds));
  if (errors.length > 0) {
    for (const error of errors) console.error(`✘ ${error}`);
    return 1;
  }
  const contracts = discovered.map((item) => item.contract);

  if (values.coverage) {
    const uncovered = findUncoveredRqs(knownRqIds, contracts);
    console.log(`계약이 없는 RQ ${uncovered.length}개:`);
    for (const id of uncovered) console.log(`  ${id}`);
    return 0;
  }
  if (values.db !== 'sqlite' && values.db !== 'postgres') {
    console.error(`지원하지 않는 --db 값: ${values.db}. sqlite 또는 postgres만 지원한다.`);
    return 1;
  }

  const selected = selectContracts(contracts, positionals);
  const groups = groupByProfile(values.shuffle ? shuffle(selected) : selected);
  const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-'));
  workDirForError = workDir;
  // 서버가 로그를 쓰는 디렉터리이므로 서버 정리 뒤에 지우도록 서버 정리보다 먼저 등록한다.
  cleanups.push(async () => {
    if (!keepWorkDir) await rm(workDir, { recursive: true, force: true });
  });
  const results: ContractResult[] = [];
  const failedLogs = new Set<string>();

  // VersityGW 준비를 기다리는 중에 중단돼도 컨테이너가 남지 않도록 기동 전에 등록한다.
  // 동시 실행을 하지 않는다는 전제에서 `storix-contract-` 컨테이너를 접두어로 모두 제거한다.
  cleanups.push(async () => removeStaleContainers());
  const runId = randomBytes(4).toString('hex');
  const blob = await startBlobStorage(runId);
  cleanups.push(() => blob.stop());
  // blob 저장소가 잔여 컨테이너를 정리한 뒤에 띄운다. 프로필마다 database를 새로 만든다.
  const postgres = values.db === 'postgres' ? await startPostgres(runId) : undefined;
  if (postgres !== undefined) cleanups.push(() => postgres.stop());
  // 서버 기동을 기다리는 중에 중단돼도 서버 프로세스가 남지 않도록 핸들과 별도로 등록한다.
  cleanups.push(async () => {
    // 실행 중이던 계약이 정리 뒤에 `restart()`로 서버를 다시 띄우지 못하게 먼저 막는다.
    refuseNewServers();
    await stopAllServers();
  });

  for (const [profile, group] of groups) {
    if (interrupted) return 130;
    console.log(`\n프로필 ${profile}: 계약 ${group.length}개`);
    const outcome = await runProfileLifecycle(
      {
        profile,
        contracts: group,
        workDir,
        runId,
        db: values.db,
        postgres,
        blob,
        signal: abortController.signal,
      },
      {
        async runContract(contract, context) {
          const result = await runContract(contract, context);
          printResult(result);
          return result;
        },
      },
    );
    results.push(...outcome.contracts);
    if (outcome.contracts.some((result) => !result.passed)) failedLogs.add(outcome.serverLogFile);
  }

  const summary = summarize(results);
  console.log(`\n통과 ${summary.passed}, 실패 ${summary.failed}`);
  if (summary.exitCode !== 0) {
    keepWorkDir = true;
    console.log(`작업 디렉터리를 보존했다: ${workDir}`);
    for (const log of failedLogs) console.log(`서버 로그: ${log}`);
  }
  return summary.exitCode;
}

process.on('SIGINT', () => {
  if (interrupted) return;
  interrupted = true;
  abortController.abort();
  void runCleanups().finally(() => process.exit(130));
});

try {
  process.exitCode = await main();
} catch (error) {
  // 중단으로 서버를 정리하면서 생긴 오류는 사용자에게 의미가 없어 출력하지 않는다.
  if (!interrupted) {
    console.error(error instanceof Error ? error.message : error);
    if (workDirForError !== undefined) {
      keepWorkDir = true;
      console.error(`작업 디렉터리를 보존했다: ${workDirForError}`);
    }
  }
  process.exitCode = 1;
} finally {
  await runCleanups();
}
