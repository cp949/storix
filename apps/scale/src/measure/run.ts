import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { activeNamespaceId, pickActiveNumbers } from '../dataset/ids.ts';
import { migrate, readCounts, readDatasetSpec } from '../dataset/seed.ts';
import { type DatasetSpec, expectedCounts } from '../dataset/spec.ts';
import { ANALYZE_SQL } from '../dataset/sql.ts';
import {
  databaseEnv,
  ensurePostgres,
  ensureStorage,
  POSTGRES_SETTINGS,
  storageEnv,
} from '../infra/containers.ts';
import { run as exec } from '../infra/exec.ts';
import { POSTGRES_CONTAINER, runDatabaseName, templateDatabaseName } from '../infra/guard.ts';
import { cloneDatabase, dropDatabase, execSql } from '../infra/psql.ts';
import { REPO_ROOT, RESULTS_DIR, WORK_DIR } from '../paths.ts';
import {
  type DbCounters,
  diffCounters,
  readDbCounters,
  readRelationSizes,
  type RelationSize,
} from './db-stats.ts';
import { runGc, type GcRun } from './gc.ts';
import { buildApiEnv, findFreePort, startApi } from './server.ts';
import {
  type ListMeasurement,
  measureNamespaceList,
  runWorkload,
  type WorkloadOptions,
  type WorkloadResult,
} from './workload.ts';

/** 측정 단계 하나의 결과. 실패해도 다음 단계는 계속한다. */
export interface PhaseResult<T> {
  readonly ok: boolean;
  readonly error: string | null;
  readonly data: T | null;
}

/** 측정 실행 옵션. */
export interface MeasureOptions {
  readonly scale: number;
  readonly seed: string;
  /** 기준선(`baseline`)·개선 후(`after`) 같은 사람이 읽는 이름 */
  readonly label: string;
  /** 같은 데이터셋에 capability 설정으로 나열할 namespace 수. 0이면 설정 없이 기동한다. */
  readonly capabilityNamespaces: number;
  readonly workload: WorkloadOptions;
  readonly gcTimeoutMs: number;
  readonly listTimeoutMs: number;
  /** 단계 이름 목록. 비면 전부 실행한다. */
  readonly phases: readonly string[];
}

/** 측정 한 번의 전체 결과. 원시 JSON으로 저장한다. */
export interface MeasureResult {
  readonly runId: string;
  readonly label: string;
  readonly startedAt: string;
  readonly environment: Record<string, unknown>;
  readonly spec: DatasetSpec;
  readonly datasetCounts: unknown;
  readonly relationSizes: RelationSize[];
  readonly phases: Record<string, PhaseResult<unknown>>;
}

const API_KEY = 'scale-api-key';
const ADMIN_KEY = 'scale-admin-key';
/** 요청 측정에서 데이터셋이 며칠 지나면 보존 기간 의미가 바뀐다. 이 기간을 넘으면 재적재를 요구한다. */
const MAX_DATASET_AGE_DAYS = 20;

/** 단계가 실패했어도 관측한 값(예: timeout까지의 시간·최대 RSS)을 결과에 남기려고 쓴다. */
class PhaseFailure extends Error {
  readonly data: unknown;

  constructor(message: string, data: unknown) {
    super(message);
    this.data = data;
  }
}

async function phase<T>(name: string, fn: () => Promise<T>): Promise<PhaseResult<T>> {
  const started = Date.now();
  try {
    const data = await fn();
    console.log(`  ✔ ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
    return { ok: true, error: null, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✘ ${name}: ${message.split('\n')[0]}`);
    return {
      ok: false,
      error: message,
      data: error instanceof PhaseFailure ? (error.data as T) : null,
    };
  }
}

function gitInfo(): { rev: string; dirty: boolean } {
  const rev = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
  const dirty =
    execFileSync('git', ['status', '--porcelain', '--', 'apps/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).trim() !== '';
  return { rev, dirty };
}

function environmentInfo(): Record<string, unknown> {
  return {
    node: process.version,
    postgres: exec('docker', ['exec', POSTGRES_CONTAINER, 'postgres', '--version']).trim(),
    postgresSettings: POSTGRES_SETTINGS,
    cpus: Number(exec('nproc', []).trim()),
    memTotalKb: Number(/MemTotal:\s+(\d+)/.exec(exec('cat', ['/proc/meminfo']))![1]),
    git: gitInfo(),
    // 저장소에 실제 object를 만들지 않는다. S6의 storage 목록·삭제 I/O는 이 측정으로 검증되지 않는다.
    storageObjects: '없음(DB 행만 적재)',
  };
}

function capabilityEnv(spec: DatasetSpec, count: number, dir: string): Record<string, string> {
  const numbers = pickActiveNumbers(spec, count);
  const ids = numbers.map((i) => activeNamespaceId(spec, i));
  const capabilities = {
    globalAllowedCapabilities: ['resumable-upload'],
    namespaceAllowedCapabilities: Object.fromEntries(ids.map((id) => [id, ['resumable-upload']])),
  };
  const policy = {
    global: { maxStagedBytes: '1073741824', maxActiveSessions: 100 },
    namespaces: Object.fromEntries(
      ids.map((id) => [id, { maxStagedBytes: '1073741824', maxActiveSessions: 10 }]),
    ),
  };
  const capabilityPath = path.join(dir, 'capabilities.json');
  const policyPath = path.join(dir, 'upload-sessions.json');
  writeFileSync(capabilityPath, JSON.stringify(capabilities));
  writeFileSync(policyPath, JSON.stringify(policy));
  return {
    STORIX_VFS_CAPABILITIES_CONFIG_PATH: capabilityPath,
    STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: policyPath,
  };
}

/** 데이터셋이 오래돼 보존 기간 의미가 달라졌는지 확인한다. */
export function assertDatasetFresh(spec: DatasetSpec, now = Date.now()): void {
  const ageDays = (now - Date.parse(spec.refTime)) / 86_400_000;
  if (ageDays > MAX_DATASET_AGE_DAYS)
    throw new Error(
      `데이터셋이 ${Math.floor(ageDays)}일 전에 적재돼 보존 기간 기준이 어긋난다. 다시 seed한다.`,
    );
}

/** 규모 하나를 측정한다. 단계마다 실패 여부를 기록하고 결과를 JSON으로 저장한다. */
export async function measure(options: MeasureOptions): Promise<MeasureResult> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  ensurePostgres();
  ensureStorage();
  const template = templateDatabaseName(options.scale, options.seed);
  const spec = readDatasetSpec(template);
  if (spec === null) throw new Error(`템플릿 database ${template}에 명세가 없다. 먼저 seed를 실행한다.`);
  assertDatasetFresh(spec);

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[-:]/g, '').slice(0, 15)}-${options.label}-${options.scale}`;
  const want = (name: string): boolean => options.phases.length === 0 || options.phases.includes(name);
  const phases: Record<string, PhaseResult<unknown>> = {};
  console.log(`측정 ${runId}`);

  const apiDb = runDatabaseName(runId, 'api');
  const gcDb = runDatabaseName(runId, 'gc');
  let relationSizes: RelationSize[] = [];
  let datasetCounts: unknown = null;
  const port = await findFreePort();
  const tag = randomBytes(3).toString('hex');
  const target = {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
    adminKey: ADMIN_KEY,
  };
  const apiEnv = (database: string, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv =>
    buildApiEnv({
      port,
      apiKey: API_KEY,
      adminKey: ADMIN_KEY,
      databaseEnv: databaseEnv(database),
      storageEnv: storageEnv(),
      extraEnv,
    });

  try {
    if (want('startup') || want('requests') || want('list') || want('startup-capability')) {
      console.log('API 단계: 템플릿 복원');
      const cloneStarted = Date.now();
      cloneDatabase(template, apiDb);
      await execSql(apiDb, ANALYZE_SQL);
      phases.restore = {
        ok: true,
        error: null,
        data: { ms: Date.now() - cloneStarted },
      };
      datasetCounts = {
        expected: expectedCounts(spec),
        actual: await readCounts(apiDb),
      };
      relationSizes = await readRelationSizes(apiDb);

      if (want('startup')) {
        phases.startup = await phase('startup', async () => {
          const before = await readDbCounters(apiDb);
          const api = await startApi({
            env: apiEnv(apiDb),
            port,
            label: `${runId}-startup`,
          });
          const readyRss = api.readyRssBytes;
          const peak = api.peakRssBytes();
          await api.stop();
          return {
            startupMs: api.startupMs,
            readyRssBytes: readyRss,
            peakRssBytes: peak,
            db: diffCounters(before, await readDbCounters(apiDb)),
          };
        });
      }
      if (want('startup-capability') && options.capabilityNamespaces > 0) {
        phases['startup-capability'] = await phase('startup-capability', async () => {
          const extra = capabilityEnv(spec, options.capabilityNamespaces, WORK_DIR);
          const before = await readDbCounters(apiDb);
          const api = await startApi({
            env: apiEnv(apiDb, extra),
            port,
            label: `${runId}-startup-cap`,
          });
          const peak = api.peakRssBytes();
          await api.stop();
          return {
            capabilityNamespaces: options.capabilityNamespaces,
            startupMs: api.startupMs,
            readyRssBytes: api.readyRssBytes,
            peakRssBytes: peak,
            db: diffCounters(before, await readDbCounters(apiDb)),
          };
        });
      }
      if (want('requests')) {
        phases.requests = await phase('requests', async () => {
          const before = await readDbCounters(apiDb);
          const api = await startApi({
            env: apiEnv(apiDb),
            port,
            label: `${runId}-requests`,
          });
          try {
            const results: WorkloadResult = await runWorkload(target, spec, options.workload, tag);
            const peakRssBytes = api.peakRssBytes();
            return {
              workload: options.workload,
              results,
              peakRssBytes,
              db: diffCounters(before, await readDbCounters(apiDb)),
            };
          } finally {
            await api.stop();
          }
        });
      }
      if (want('list')) {
        phases.list = await phase('list', async () => {
          const before = await readDbCounters(apiDb);
          const api = await startApi({
            env: apiEnv(apiDb),
            port,
            label: `${runId}-list`,
          });
          try {
            const first: ListMeasurement = await measureNamespaceList(target, options.listTimeoutMs);
            const peakRssBytes = api.peakRssBytes();
            return {
              request: 'GET /api/v2/namespaces (쿼리 없음)',
              first,
              peakRssBytes,
              db: diffCounters(before, await readDbCounters(apiDb)),
            };
          } finally {
            await api.stop();
          }
        });
      }
    }

    if (want('gc')) {
      console.log('GC 단계: 템플릿 복원');
      cloneDatabase(template, gcDb);
      migrate(gcDb);
      await execSql(gcDb, ANALYZE_SQL);
      phases.gc = await phase('gc', async () => {
        const before = await readDbCounters(gcDb);
        const run: GcRun = await runGc({
          env: { ...apiEnv(gcDb), STORIX_GC_MIN_INTERVAL: '1' },
          label: `${runId}`,
          timeoutMs: options.gcTimeoutMs,
        });
        const db: DbCounters = diffCounters(before, await readDbCounters(gcDb));
        const data = { ...run, db };
        if (run.timedOut || run.exitCode !== 0)
          throw new PhaseFailure(
            `GC 실패: exit ${run.exitCode}, timedOut ${run.timedOut}, wall ${Math.round(run.wallMs)}ms`,
            data,
          );
        return data;
      });
    }
  } finally {
    dropDatabase(apiDb);
    dropDatabase(gcDb);
  }

  const result: MeasureResult = {
    runId,
    label: options.label,
    startedAt,
    environment: environmentInfo(),
    spec,
    datasetCounts,
    relationSizes,
    phases,
  };
  const file = path.join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`결과 저장: ${file}`);
  return result;
}
