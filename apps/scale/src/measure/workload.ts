import { randomUUID } from 'node:crypto';
import { activeNamespaceId, pickActiveNumbers } from '../dataset/ids.ts';
import type { DatasetSpec } from '../dataset/spec.ts';
import { type LatencySummary, type Sample, summarize } from './stats.ts';

/** 요청 workload 설정. 수치는 조건이며 SLA가 아니다. */
export interface WorkloadOptions {
  /** 대상으로 삼는 활동 namespace 수 */
  readonly namespaces: number;

  /** 요청 종류마다의 반복 횟수 */
  readonly requestsPerKind: number;

  /** 동시 요청 수 */
  readonly concurrency: number;

  /** namespace 생성·삭제 접수 반복 횟수 */
  readonly lifecycleRequests: number;

  /** 요청 하나의 timeout(ms) */
  readonly timeoutMs: number;
}

/** 종류별 요청 요약. */
export type WorkloadResult = Record<string, LatencySummary & { readonly throughputPerSec?: number }>;

/** 하네스가 쓰는 API 접속 정보. */
export interface ApiTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly adminKey: string;
}

/** 작업을 `concurrency`개씩 병렬로 실행한다. 작업 순서는 보존하지 않는다. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function timed(
  samples: Sample[],
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<Response>,
  accept: (status: number) => boolean,
): Promise<void> {
  const started = performance.now();
  try {
    const response = await request(AbortSignal.timeout(timeoutMs));
    await response.arrayBuffer();
    samples.push({
      ms: performance.now() - started,
      ok: accept(response.status),
    });
  } catch {
    samples.push({ ms: performance.now() - started, ok: false });
  }
}

/** 대표 VFS 요청과 namespace 생성·삭제 접수를 측정한다. 실패 요청도 표본에 남긴다. */
export async function runWorkload(
  target: ApiTarget,
  spec: DatasetSpec,
  options: WorkloadOptions,
  runTag: string,
  onSettingsComplete?: () => Promise<void>,
): Promise<WorkloadResult> {
  const ids = pickActiveNumbers(spec, options.namespaces).map((i) => activeNamespaceId(spec, i));
  if (ids.length === 0) throw new Error('활동 namespace가 없다');
  const auth = { Authorization: `Bearer ${target.apiKey}` };
  const adminAuth = { Authorization: `Bearer ${target.adminKey}` };
  const n = options.requestsPerKind;
  const indexes = Array.from({ length: n }, (_, k) => k);
  const idOf = (k: number): string => ids[k % ids.length];
  const result: WorkloadResult = {};

  const kind = async (name: string, work: (k: number, samples: Sample[]) => Promise<void>): Promise<void> => {
    const samples: Sample[] = [];
    const started = performance.now();
    await runPool(indexes, options.concurrency, (k) => work(k, samples));
    result[name] = {
      ...summarize(samples),
      throughputPerSec: (samples.length / (performance.now() - started)) * 1000,
    };
  };

  await kind('getNamespace', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/namespaces/${idOf(k)}`, {
          headers: auth,
          signal,
        }),
      (s) => s === 200,
    ),
  );
  await kind('updateNamespaceSettings', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/admin/namespaces/${idOf(k)}/settings`, {
          method: 'PATCH',
          headers: {
            ...adminAuth,
            'Content-Type': 'application/json',
            'Idempotency-Key': `scale-settings-${runTag}-${k}`,
          },
          body: JSON.stringify({ trashEnabled: k % 2 === 0 }),
          signal,
        }),
      (s) => s === 200,
    ),
  );
  await onSettingsComplete?.();
  await kind('stat', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/namespaces/${idOf(k)}/fs/stat?path=${encodeURIComponent('/docs')}`, {
          headers: auth,
          signal,
        }),
      (s) => s === 200,
    ),
  );
  await kind('ls', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/namespaces/${idOf(k)}/fs/ls?path=${encodeURIComponent('/docs')}`, {
          headers: auth,
          signal,
        }),
      (s) => s === 200,
    ),
  );
  await kind('mkdir', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/namespaces/${idOf(k)}/fs/mkdir`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: `/bench-${runTag}/d-${k}`,
            parents: true,
          }),
          signal,
        }),
      (s) => s === 201 || s === 200,
    ),
  );
  const body = Buffer.alloc(1024, 7);
  await kind('upload1KiB', (k, samples) =>
    timed(
      samples,
      options.timeoutMs,
      (signal) =>
        fetch(
          `${target.baseUrl}/api/v2/namespaces/${idOf(k)}/fs/content?path=${encodeURIComponent(`/bench-${runTag}/f-${k}.bin`)}&parents=true`,
          {
            method: 'POST',
            headers: {
              ...auth,
              'Content-Type': 'application/octet-stream',
              'Idempotency-Key': randomUUID(),
              'X-Mutation-Scope': 'storix-scale',
            },
            body,
            signal,
          },
        ),
      (s) => s === 201 || s === 200,
    ),
  );

  // namespace 생성 → 삭제 접수. 이름·key는 실행마다 고유하다.
  const created: string[] = [];
  const lifecycle = Array.from({ length: options.lifecycleRequests }, (_, k) => k);
  const createSamples: Sample[] = [];
  const createStarted = performance.now();
  await runPool(lifecycle, options.concurrency, async (k) => {
    const started = performance.now();
    try {
      const response = await fetch(`${target.baseUrl}/api/v2/namespaces`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          'Idempotency-Key': `scale-bench-${runTag}-${k}`,
        },
        body: JSON.stringify({ name: `bench-${runTag}-${k}` }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const json = (await response.json()) as { id?: string };
      const ok = response.status === 201 && typeof json.id === 'string';
      if (ok) created.push(json.id!);
      createSamples.push({ ms: performance.now() - started, ok });
    } catch {
      createSamples.push({ ms: performance.now() - started, ok: false });
    }
  });
  result.createNamespace = {
    ...summarize(createSamples),
    throughputPerSec: (createSamples.length / (performance.now() - createStarted)) * 1000,
  };

  const deleteSamples: Sample[] = [];
  const deleteStarted = performance.now();
  await runPool(created, options.concurrency, (id) =>
    timed(
      deleteSamples,
      options.timeoutMs,
      (signal) =>
        fetch(`${target.baseUrl}/api/v2/admin/namespaces/${id}/delete`, {
          method: 'POST',
          headers: {
            ...adminAuth,
            'Idempotency-Key': `scale-bench-del-${runTag}-${id}`,
          },
          signal,
        }),
      (s) => s === 202 || s === 200,
    ),
  );
  result.acceptNamespaceDeletion = {
    ...summarize(deleteSamples),
    throughputPerSec: (deleteSamples.length / (performance.now() - deleteStarted)) * 1000,
  };
  return result;
}

/** `GET /api/v2/namespaces` 한 번의 응답 시간과 크기. 응답 본문은 모으지 않고 바이트 수만 센다. */
export interface ListMeasurement {
  readonly ok: boolean;
  readonly status: number | null;
  readonly ms: number;
  readonly bytes: number;
  readonly error: string | null;
}

/** namespace 목록 요청 하나를 잰다. 실패·timeout도 결과로 돌려준다. */
export async function measureNamespaceList(
  target: ApiTarget,
  timeoutMs: number,
  query = '',
): Promise<ListMeasurement> {
  const started = performance.now();
  let bytes = 0;
  try {
    const response = await fetch(`${target.baseUrl}/api/v2/namespaces${query}`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    return {
      ok: response.status === 200,
      status: response.status,
      ms: performance.now() - started,
      bytes,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: performance.now() - started,
      bytes,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** page 모드(`limit`·`cursor`) 목록 측정. 첫 page 비용과 전체 순회 비용을 따로 기록한다. */
export interface PageWalkMeasurement {
  readonly limit: number;
  readonly firstPageMs: number | null;
  readonly firstPageBytes: number;
  readonly pages: number;
  readonly items: number;
  readonly totalMs: number;
  readonly totalBytes: number;
  readonly failures: number;
  readonly error: string | null;
}

/** 목록을 page 모드로 끝까지 순회한다. 응답을 파싱하되 항목은 세기만 하고 모으지 않는다. */
export async function measureNamespacePageWalk(
  target: ApiTarget,
  limit: number,
  timeoutMs: number,
): Promise<PageWalkMeasurement> {
  const started = performance.now();
  let cursor: string | null = null;
  let firstPageMs: number | null = null;
  let firstPageBytes = 0;
  let pages = 0;
  let items = 0;
  let totalBytes = 0;
  let failures = 0;
  let error: string | null = null;
  try {
    do {
      const pageStarted = performance.now();
      const query: string = `?limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await fetch(`${target.baseUrl}/api/v2/namespaces${query}`, {
        headers: { Authorization: `Bearer ${target.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200) {
        failures++;
        error = `status ${response.status}`;
        break;
      }
      const body = JSON.parse(bytes.toString('utf-8')) as { items: unknown[]; nextCursor: string | null };
      if (pages === 0) {
        firstPageMs = performance.now() - pageStarted;
        firstPageBytes = bytes.byteLength;
      }
      pages++;
      items += body.items.length;
      totalBytes += bytes.byteLength;
      cursor = body.nextCursor;
    } while (cursor !== null);
  } catch (caught) {
    failures++;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    limit,
    firstPageMs,
    firstPageBytes,
    pages,
    items,
    totalMs: performance.now() - started,
    totalBytes,
    failures,
    error,
  };
}
