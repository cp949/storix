/**
 * namespace 규모 측정 하네스 CLI. 일반 `pnpm test`·CI에는 넣지 않는 수동 실행 도구다.
 * 실행 안전: 전용 컨테이너(`storix-scale-*`)·database(`storix_scale_*`)만 대상으로 한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { seedTemplate } from './dataset/seed.ts';
import { applyOverrides, defaultSpec, validateSpec } from './dataset/spec.ts';
import { ensurePostgres, ensureStorage, removeContainers } from './infra/containers.ts';
import { verifyFidelity } from './fidelity.ts';
import { measure, type MeasureOptions } from './measure/run.ts';
import { RESULTS_DIR } from './paths.ts';
import { renderReport, type ReportInput } from './report.ts';

const USAGE = `사용법: pnpm scale <명령> [옵션]
  env up                          전용 PostgreSQL·VersityGW 컨테이너 기동
  env down [--volumes]            컨테이너 제거(--volumes면 seed 데이터까지 삭제)
  seed --scale N [--seed S] [--set 키=값 ...]  규모 N 템플릿 database 적재(변형은 seed 이름을 달리한다)
  verify-fidelity                 API 생성 표본과 SQL 적재 표본의 행 모양을 대조
  measure --scale N --label L     측정 실행. 옵션:
      [--phases startup,requests,list,gc] [--capability-namespaces K]
      [--requests R] [--concurrency C] [--lifecycle K] [--gc-timeout-min M] [--list-timeout-sec S]
  report [--label L]              저장된 결과 JSON을 표로 출력`;

function intOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`정수가 아니다: ${value}`);
  return parsed;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scale: { type: 'string' },
      seed: { type: 'string', default: 'storix-scale-v1' },
      set: { type: 'string', multiple: true },
      label: { type: 'string', default: 'baseline' },
      volumes: { type: 'boolean', default: false },
      phases: { type: 'string', default: '' },
      'capability-namespaces': { type: 'string' },
      requests: { type: 'string' },
      concurrency: { type: 'string' },
      lifecycle: { type: 'string' },
      'gc-timeout-min': { type: 'string' },
      'list-timeout-sec': { type: 'string' },
    },
  });
  const [command, sub] = positionals;
  if (command === 'env' && sub === 'up') {
    ensurePostgres();
    ensureStorage();
    console.log('전용 컨테이너 기동 완료');
    return 0;
  }
  if (command === 'env' && sub === 'down') {
    removeContainers(values.volumes);
    console.log('컨테이너 제거 완료');
    return 0;
  }
  if (command === 'seed') {
    ensurePostgres();
    const spec = applyOverrides(
      defaultSpec(Number(values.scale), new Date().toISOString(), values.seed),
      values.set ?? [],
    );
    const errors = validateSpec(spec);
    if (errors.length > 0) {
      console.error(errors.join('\n'));
      return 1;
    }
    const database = await seedTemplate(spec, (message) => console.log(message));
    console.log(`템플릿 database: ${database}`);
    return 0;
  }
  if (command === 'verify-fidelity') {
    const problems = await verifyFidelity((message) => console.log(message));
    if (problems.length > 0) {
      console.error(`불일치 ${problems.length}건:\n${problems.join('\n')}`);
      return 1;
    }
    console.log('API 생성 표본과 SQL 적재 표본이 일치한다');
    return 0;
  }
  if (command === 'measure') {
    const options: MeasureOptions = {
      scale: Number(values.scale),
      seed: values.seed,
      label: values.label,
      capabilityNamespaces: intOption(values['capability-namespaces'], Math.floor(Number(values.scale) / 10)),
      workload: {
        namespaces: 200,
        requestsPerKind: intOption(values.requests, 500),
        concurrency: intOption(values.concurrency, 8),
        lifecycleRequests: intOption(values.lifecycle, 200),
        timeoutMs: 60_000,
      },
      gcTimeoutMs: intOption(values['gc-timeout-min'], 120) * 60_000,
      listTimeoutMs: intOption(values['list-timeout-sec'], 600) * 1000,
      phases: values.phases === '' ? [] : values.phases.split(','),
    };
    await measure(options);
    return 0;
  }
  if (command === 'report') {
    const files = readdirSync(RESULTS_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const inputs: ReportInput[] = files
      .map((name) => JSON.parse(readFileSync(path.join(RESULTS_DIR, name), 'utf-8')) as ReportInput)
      .filter((result) => result.label === values.label || !process.argv.includes('--label'));
    console.log(renderReport(inputs));
    return 0;
  }
  console.error(USAGE);
  return 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (process.env.STORIX_SCALE_DEBUG ? error.stack : error.message) : error,
  );
  return 1;
});
