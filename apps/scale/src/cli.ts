/**
 * namespace 규모 측정 하네스 CLI. 일반 `pnpm test`·CI에는 넣지 않는 수동 실행 도구다.
 * 실행 안전: 전용 컨테이너(`storix-scale-*`)·database(`storix_scale_*`)만 대상으로 한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ensureObjects, removeAllObjects } from './dataset/objects.ts';
import { readDatasetSpec, seedTemplate } from './dataset/seed.ts';
import { applyOverrides, defaultSpec, validateSpec } from './dataset/spec.ts';
import { STORAGE_BUCKET_DIR, ensurePostgres, ensureStorage, removeContainers } from './infra/containers.ts';
import { templateDatabaseName } from './infra/guard.ts';
import { verifyFidelity } from './fidelity.ts';
import { measure, type MeasureOptions } from './measure/run.ts';
import { OBJECTS_MARKER, RESULTS_DIR, WORK_DIR } from './paths.ts';
import { renderReport, type ReportInput } from './report.ts';

const USAGE = `사용법: pnpm scale <명령> [옵션]
  env up                          전용 PostgreSQL·VersityGW 컨테이너 기동
  env down [--volumes]            컨테이너 제거(--volumes면 seed 데이터까지 삭제)
  seed --scale N [--seed S] [--id-style uuid|prefixed] [--set 키=값 ...]  규모 N 템플릿 database 적재
  seed-objects --scale N [--seed S]  blob 행에 대응하는 실제 storage object를 만든다(GC 측정 전에 필요)
  verify-fidelity                 API 생성 표본과 SQL 적재 표본의 행 모양을 대조
  measure --scale N --label L     측정 실행. 옵션:
      [--gc-env KEY=VALUE ...]  GC 프로세스에만 전달할 env(예: STORIX_GC_MAX_ROWS_PER_STAGE=10000000, NODE_OPTIONS=--max-old-space-size=128)
      [--objects]  GC 단계에서 storage object를 복원하고 함께 측정한다
      [--phases startup,requests,list,gc] [--capability-namespaces K]
      [--requests R] [--concurrency C] [--lifecycle K] [--gc-timeout-min M] [--gc-repeat R] [--list-timeout-sec S]
      (--gc-repeat R: 예산 소진 단계가 남으면 같은 DB에서 GC를 최대 R회(첫 실행 포함)까지 이어 실행해 재개 완료 여부를 잰다)
  report [--label L]              저장된 결과 JSON을 표로 출력`;

/** `--gc-env KEY=VALUE` 목록을 GC 프로세스 env로 바꾼다. `STORIX_`·`NODE_OPTIONS`만 허용한다. */
export function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    const key = pair.slice(0, index);
    if (index < 1 || !/^(STORIX_[A-Z0-9_]+|NODE_OPTIONS)$/.test(key))
      throw new Error(`--gc-env는 STORIX_* 또는 NODE_OPTIONS만 받는다: ${pair}`);
    env[key] = pair.slice(index + 1);
  }
  return env;
}

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
      'id-style': { type: 'string', default: 'uuid' },
      set: { type: 'string', multiple: true },
      label: { type: 'string', default: 'baseline' },
      volumes: { type: 'boolean', default: false },
      phases: { type: 'string', default: '' },
      'capability-namespaces': { type: 'string' },
      requests: { type: 'string' },
      concurrency: { type: 'string' },
      lifecycle: { type: 'string' },
      'gc-timeout-min': { type: 'string' },
      'gc-repeat': { type: 'string' },
      'list-timeout-sec': { type: 'string' },
      objects: { type: 'boolean', default: false },
      'gc-env': { type: 'string', multiple: true },
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
    if (values['id-style'] !== 'uuid' && values['id-style'] !== 'prefixed')
      throw new Error('--id-style은 uuid 또는 prefixed여야 한다');
    const spec = applyOverrides(
      {
        ...defaultSpec(Number(values.scale), new Date().toISOString(), values.seed),
        namespaceIdStyle: values['id-style'],
      },
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
  if (command === 'seed-objects') {
    ensureStorage();
    const database = templateDatabaseName(Number(values.scale), values.seed);
    const spec = readDatasetSpec(database);
    if (spec === null) throw new Error(`template ${database}가 없다. 먼저 seed를 실행한다.`);
    removeAllObjects(STORAGE_BUCKET_DIR);
    const result = await ensureObjects(spec, STORAGE_BUCKET_DIR, (message) => console.log(message));
    mkdirSync(WORK_DIR, { recursive: true });
    writeFileSync(OBJECTS_MARKER, JSON.stringify({ template: database, refTime: spec.refTime }));
    console.log(`object ${result.total}개 준비(새로 만든 ${result.created}개): ${STORAGE_BUCKET_DIR}`);
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
      gcRepeat: intOption(values['gc-repeat'], 1),
      listTimeoutMs: intOption(values['list-timeout-sec'], 600) * 1000,
      objects: values.objects,
      gcEnv: parseEnvPairs(values['gc-env'] ?? []),
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
