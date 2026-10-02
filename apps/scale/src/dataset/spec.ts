/**
 * 데이터셋 명세와 기대 행 수.
 * 같은 `seed`·`refTime`·`namespaces`·비율이면 `sql.ts`가 같은 행 집합을 만든다.
 * 수치는 workload 조건이며 SLA가 아니다.
 */

/** 규모 축. 1만·10만·100만 외 값은 시험·smoke용으로만 쓴다. */
export const STANDARD_SCALES = [10_000, 100_000, 1_000_000] as const;

/** 데이터셋 명세. */
export interface DatasetSpec {
  /** 결정적 ID·이름을 만드는 seed 문자열 */
  readonly seed: string;

  /** 기준 시각(ISO 8601 UTC). 모든 시각은 이 값에서 뺀 오프셋이다. 적재 시점의 현재 시각을 쓴다. */
  readonly refTime: string;

  /** ACTIVE namespace 수(1부터 N까지 번호) */
  readonly namespaces: number;

  /** i % activeEvery == 0 인 namespace가 활동 namespace(파일·blob·change feed·관리 receipt 보유) */
  readonly activeEvery: number;

  /** 활동 namespace의 FILE node·blob 수 */
  readonly filesPerActive: number;

  /** 활동 namespace의 change event 수(1..N) */
  readonly eventsPerActive: number;

  /** i % expiredEvery == 0 인 활동 namespace는 선두 `expiredEventsPerDue`개 이벤트가 보존 기간을 넘긴다 */
  readonly expiredEvery: number;

  /** 만료 이벤트를 가진 namespace의 만료 이벤트 수 */
  readonly expiredEventsPerDue: number;

  /**
   * 0이 아니면 i % blockedEvery == 0 인 활동 namespace는 선두 이벤트가 유효하고(1일 전) 그 뒤 `expiredEventsPerDue`개가
   * 만료(90일 전, 만료 namespace의 선두보다 오래됨)돼 있다. 보존 정리가 건너뛰어야 하는 비단조 구성이다. 정상 운영에서는 거의 생기지 않는 불리한 입력이다.
   */
  readonly blockedEvery: number;

  /** 활동 namespace마다 만드는 관리(quota) receipt 수 */
  readonly managementReceiptsPerActive: number;

  /** i % orphanEvery == 0 인 namespace는 grace를 넘긴 orphan blob 행을 `orphanBlobsPerDue`개 가진다 */
  readonly orphanEvery: number;
  readonly orphanBlobsPerDue: number;

  /** DELETED(정리 완료) namespace 수. ACTIVE namespace와 별도로 추가한다. */
  readonly deletedNamespaces: number;

  /** FILE 크기(바이트). blob.size·vfs_node.size·namespace.live_file_byte_count가 이 값에서 나온다. */
  readonly fileSizeBytes: number;

  /** 생성 응답 본문에 들어가는 서버 전역 기본값. `verify-fidelity`가 API 표본과 대조한다. */
  readonly defaults: {
    readonly maxFileSizeBytes: string;
    readonly quotaLimitBytes: string;
    readonly maxRetainedTrashNodes: number;
  };
}

/** 규모 하나에 대한 기본 명세를 만든다. 비율은 규모와 무관하게 같다. */
export function defaultSpec(namespaces: number, refTime: string, seed = 'storix-scale-v1'): DatasetSpec {
  return {
    seed,
    refTime,
    namespaces,
    activeEvery: 10,
    filesPerActive: 5,
    eventsPerActive: 10,
    expiredEvery: 1000,
    expiredEventsPerDue: 3,
    blockedEvery: 0,
    managementReceiptsPerActive: 3,
    orphanEvery: 500,
    orphanBlobsPerDue: 2,
    deletedNamespaces: Math.floor(namespaces / 10),
    fileSizeBytes: 1024,
    defaults: {
      maxFileSizeBytes: '5368709120',
      quotaLimitBytes: '53687091200',
      maxRetainedTrashNodes: 100000,
    },
  };
}

/** `--set 키=값` 목록을 명세에 덮어쓴다. 숫자 필드만 허용한다. */
export function applyOverrides(spec: DatasetSpec, pairs: readonly string[]): DatasetSpec {
  const next: Record<string, unknown> = { ...spec };
  for (const pair of pairs) {
    const [key, raw] = pair.split('=');
    const current = next[key];
    if (typeof current !== 'number' || raw === undefined || !/^[0-9]+$/.test(raw))
      throw new Error(`--set은 숫자 필드만 바꾼다: ${pair}`);
    next[key] = Number(raw);
  }
  return next as unknown as DatasetSpec;
}

/** 적재 후 각 테이블이 가져야 하는 행 수. */
export interface ExpectedCounts {
  readonly namespace: number;
  readonly activeNamespaces: number;
  readonly deletedNamespaces: number;
  readonly vfsNode: number;
  readonly blob: number;
  readonly orphanBlobs: number;
  readonly idempotencyKey: number;
  readonly changeFeedState: number;
  readonly changeEvent: number;
  readonly expiredChangeEvents: number;
  readonly dueNamespaces: number;
  readonly blockedNamespaces: number;
  readonly namespaceDeletion: number;
}

function multiples(max: number, every: number): number {
  return Math.floor(max / every);
}

/** 명세에서 기대 행 수를 계산한다. 적재 결과 검증의 기준이다. */
export function expectedCounts(spec: DatasetSpec): ExpectedCounts {
  const active = multiples(spec.namespaces, spec.activeEvery);
  const due = multiples(spec.namespaces, lcm(spec.expiredEvery, spec.activeEvery));
  // 만료(expired)와 막힘(blocked) 조건이 겹치는 namespace는 만료로 취급한다.
  const blockedBase = spec.blockedEvery === 0 ? 0 : lcm(spec.blockedEvery, spec.activeEvery);
  const blocked =
    spec.blockedEvery === 0
      ? 0
      : multiples(spec.namespaces, blockedBase) -
        multiples(spec.namespaces, lcm(blockedBase, spec.expiredEvery));
  const orphanNamespaces = multiples(spec.namespaces, spec.orphanEvery);
  const orphanBlobs = orphanNamespaces * spec.orphanBlobsPerDue;
  const fileBlobs = active * spec.filesPerActive;
  return {
    namespace: spec.namespaces + spec.deletedNamespaces,
    activeNamespaces: spec.namespaces,
    deletedNamespaces: spec.deletedNamespaces,
    // root(ACTIVE 전체) + 활동 namespace의 docs 디렉터리와 파일
    vfsNode: spec.namespaces + active * (1 + spec.filesPerActive),
    blob: fileBlobs + orphanBlobs,
    orphanBlobs,
    idempotencyKey: spec.namespaces + spec.deletedNamespaces + active * spec.managementReceiptsPerActive,
    changeFeedState: active,
    changeEvent: active * spec.eventsPerActive,
    expiredChangeEvents: (due + blocked) * spec.expiredEventsPerDue,
    dueNamespaces: due,
    blockedNamespaces: blocked,
    namespaceDeletion: spec.deletedNamespaces,
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** 명세가 서로 모순되지 않는지 확인한다. 문제가 있으면 메시지 목록을 돌려준다. */
export function validateSpec(spec: DatasetSpec): string[] {
  const errors: string[] = [];
  const positive: Array<[string, number]> = [
    ['namespaces', spec.namespaces],
    ['activeEvery', spec.activeEvery],
    ['filesPerActive', spec.filesPerActive],
    ['eventsPerActive', spec.eventsPerActive],
    ['expiredEvery', spec.expiredEvery],
    ['expiredEventsPerDue', spec.expiredEventsPerDue],
    ['orphanEvery', spec.orphanEvery],
    ['orphanBlobsPerDue', spec.orphanBlobsPerDue],
  ];
  for (const [name, value] of positive) {
    if (!Number.isSafeInteger(value) || value < 1) errors.push(`${name}은 1 이상의 정수여야 한다`);
  }
  if (!Number.isSafeInteger(spec.blockedEvery) || spec.blockedEvery < 0)
    errors.push('blockedEvery는 0 이상의 정수여야 한다');
  if (spec.deletedNamespaces < 0 || !Number.isSafeInteger(spec.deletedNamespaces))
    errors.push('deletedNamespaces는 0 이상의 정수여야 한다');
  if (spec.managementReceiptsPerActive < 0) errors.push('managementReceiptsPerActive는 0 이상이어야 한다');
  if (spec.expiredEventsPerDue > spec.eventsPerActive)
    errors.push('expiredEventsPerDue는 eventsPerActive를 넘을 수 없다');
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(spec.seed)) errors.push('seed는 영숫자·_.:- 64자 이하여야 한다');
  if (Number.isNaN(Date.parse(spec.refTime))) errors.push('refTime이 ISO 8601이 아니다');
  if (!Number.isSafeInteger(spec.fileSizeBytes) || spec.fileSizeBytes < 0)
    errors.push('fileSizeBytes는 0 이상의 정수여야 한다');
  return errors;
}
