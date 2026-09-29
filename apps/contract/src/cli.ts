// 계약 검증 CLI 진입점.
// 사용법: pnpm contract [id...] [--db sqlite] [--shuffle] [--coverage] [--contracts-dir <경로>]
// 실행 흐름은 docs/design/12-contract-checks.md "실행 흐름".
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { removeStaleContainers, startBlobStorage } from './runner/blob-storage.ts';
import { createContractContext } from './runner/context.ts';
import { prepareSqliteDatabase } from './runner/database.ts';
import { CONTRACTS_DIR } from './runner/paths.ts';
import { PROFILE_ENV } from './runner/profiles.ts';
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
import { buildServerEnv } from './runner/server-env.ts';
import { findFreePort, startServer, stopAllServers } from './runner/server.ts';

/** 종료 시 거꾸로 실행할 정리 작업. SIGINT도 같은 목록을 실행한다. */
const cleanups: Array<() => Promise<void>> = [];

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
  if (values.db !== 'sqlite') {
    console.error(`지원하지 않는 --db 값: ${values.db}. 현재는 sqlite만 지원한다.`);
    return 1;
  }

  const selected = selectContracts(contracts, positionals);
  const groups = groupByProfile(values.shuffle ? shuffle(selected) : selected);
  const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-'));
  const results: ContractResult[] = [];
  const failedLogs = new Set<string>();

  // VersityGW 준비를 기다리는 중에 중단돼도 컨테이너가 남지 않도록 기동 전에 등록한다.
  // 동시 실행을 하지 않는다는 전제에서 `storix-contract-` 컨테이너를 접두어로 모두 제거한다.
  cleanups.push(async () => removeStaleContainers());
  const blob = await startBlobStorage(randomBytes(4).toString('hex'));
  cleanups.push(() => blob.stop());
  // 서버 기동을 기다리는 중에 중단돼도 서버 프로세스가 남지 않도록 핸들과 별도로 등록한다.
  cleanups.push(async () => void (await stopAllServers()));

  for (const [profile, group] of groups) {
    console.log(`\n프로필 ${profile}: 계약 ${group.length}개`);
    const database = prepareSqliteDatabase(workDir, profile);
    const apiKey = randomBytes(16).toString('hex');
    const port = await findFreePort();
    const server = await startServer({
      port,
      workDir,
      label: profile,
      env: buildServerEnv({
        port,
        apiKey,
        adminKey: randomBytes(16).toString('hex'),
        profileEnv: PROFILE_ENV[profile],
        databaseEnv: database.env,
        storageEnv: blob.env,
      }),
    });

    for (const contract of group) {
      const result = await runContract(
        contract,
        createContractContext({ baseUrl: server.baseUrl, apiKey, contractId: contract.id }),
      );
      results.push(result);
      printResult(result);
      if (!result.passed) failedLogs.add(server.logFile);
    }
    await server.stop();
  }

  const summary = summarize(results);
  console.log(`\n통과 ${summary.passed}, 실패 ${summary.failed}`);
  if (summary.exitCode === 0) {
    await rm(workDir, { recursive: true, force: true });
  } else {
    console.log(`작업 디렉터리를 보존했다: ${workDir}`);
    for (const log of failedLogs) console.log(`서버 로그: ${log}`);
  }
  return summary.exitCode;
}

process.on('SIGINT', () => {
  void runCleanups().finally(() => process.exit(130));
});

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await runCleanups();
}
