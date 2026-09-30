/**
 * 계약 검증 CLI 진입점.
 * 인자는 `parseArgs` 정의가 원천이다. 실행 흐름은 docs/design/12-contract-checks.md "실행 흐름".
 */
import { parseArgs } from 'node:util';
import { runContractLifecycle } from './runner/lifecycle.ts';
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
import { runContract, type ContractResult } from './runner/run.ts';

/** 반복 SIGINT는 동일한 신호를 한 번만 취소한다. */
const abortController = new AbortController();

/** 자원 정리와 계약이 성공해 마지막 작업 디렉터리 삭제에 들어갔는가. */
let finalizing = false;

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
  const outcome = await runContractLifecycle(
    {
      groups,
      db: values.db,
      signal: abortController.signal,
      onFinalizing: () => {
        finalizing = true;
      },
    },
    {
      runProfileLifecycle(input) {
        console.log(`\n프로필 ${input.profile}: 계약 ${input.contracts.length}개`);
        return runProfileLifecycle(input, {
          async runContract(contract, context) {
            const result = await runContract(contract, context);
            printResult(result);
            return result;
          },
        });
      },
    },
  );
  console.log(`\n통과 ${outcome.summary.passed}, 실패 ${outcome.summary.failed}`);
  if ('error' in outcome) console.error('실행 실패:', outcome.error);
  for (const error of outcome.cleanupErrors) console.error('정리 실패:', error);
  if (outcome.workDir !== undefined) console.log(`작업 디렉터리를 보존했다: ${outcome.workDir}`);
  for (const log of outcome.serverLogFiles) console.log(`서버 로그: ${log}`);
  return outcome.exitCode;
}

process.on('SIGINT', () => {
  if (!finalizing && !abortController.signal.aborted) abortController.abort();
});

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = abortController.signal.aborted ? 130 : 1;
}

if (process.exitCode === 130) {
  // 정리 결과 출력이 전달된 뒤 취소를 따르지 않는 계약의 열린 핸들도 종료한다.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
    ),
  );
  process.exit(130);
}
