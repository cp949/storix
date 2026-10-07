/**
 * 순수 값으로 업로드 세션 정책 적용 조건을 판정한다.
 * 설정 파싱은 upload-session-config가, 오류·DTO 변환은 caller가 맡는다.
 * 규칙은 docs/design/07-resumable-upload.md의 생성·재생 규칙과 정책 변경·staging 진단 절을 따른다.
 */
import type { UploadSessionLimits, UploadSessionPolicy } from './upload-session-config.js';

/** 전역과 namespace에 각각 적용하는 staging·활성 세션 한도다. */
export interface UploadPolicyCaps {
  /** 모든 namespace가 공유하는 한도다. */
  readonly global: UploadSessionLimits;

  /** 현재 namespace의 한도다. */
  readonly namespace: UploadSessionLimits;
}

/** 설정과 namespace ID를 해석한 업로드 정책이다. */
export interface ResolvedUploadSessionPolicy {
  /** 전역·namespace 한도를 각각 보존한다. */
  readonly caps: UploadPolicyCaps;

  /** 파일 staging 판정과 예약에 적용하는 두 한도 중 작은 값이다. */
  readonly effectiveMaxStagedBytes: bigint;

  /** 새 세션에 고정할 조각 크기다. */
  readonly partSizeBytes: number;

  /** 성공한 PUT 뒤 적용할 비활동 만료 기간이다. */
  readonly inactivitySeconds: number;

  /** 새 세션에 고정할 최대 수명이다. */
  readonly maxLifetimeSeconds: number;
}

/** 새 세션의 파일 크기 적합성 판정이다. */
export type NewUploadFileAssessment =
  /** 파일 크기가 파일 상한과 staging 상한을 모두 만족한다. */
  | { readonly kind: 'allowed' }
  /** 일반 파일 크기 상한을 넘는다. */
  | { readonly kind: 'file-too-large'; readonly maxFileSizeBytes: number }
  /** 현재 staging 상한을 넘는다. */
  | { readonly kind: 'staging-file-too-large'; readonly sizeBytes: bigint; readonly maxStagedBytes: bigint };

/** 새 세션의 고정값 계산 결과다. */
export type NewUploadSessionPlan =
  /** 조각 수와 만료 시각을 계산했다. */
  | {
      readonly kind: 'planned';
      readonly partSizeBytes: number;
      readonly partCount: number;
      readonly expiresAt: Date;
      readonly maxExpiresAt: Date;
    }
  /** 조각 수가 DB integer 범위를 넘는다. */
  | { readonly kind: 'part-count-overflow' };

/** staging 진단에 필요한 세션 snapshot이다. */
export interface UploadSessionPolicySnapshot {
  /** 세션의 현재 상태다. */
  readonly state: string;

  /** 생성 시 고정한 전체 파일 크기다. */
  readonly sizeBytes: bigint;

  /** 생성 시 고정한 조각 수다. */
  readonly partCount: number;

  /** 비활동 만료 시각이다. */
  readonly expiresAt: Date;

  /** 생성 시 고정한 최대 만료 시각이다. */
  readonly maxExpiresAt: Date;
}

/** staging 진단에 필요한 조각 snapshot이다. */
export interface UploadPartPolicySnapshot {
  /** 세션 안에서 0부터 시작하는 조각 index다. */
  readonly partIndex: number;

  /** 조각의 저장소 상태다. */
  readonly state: 'RESERVED' | 'STORED' | 'CLEANUP' | 'DELETED';

  /** RESERVED 조각의 lease 만료 시각이다. */
  readonly leaseExpiresAt: Date | null;
}

/** GET staging 진단에 공개하는 상태다. */
export type UploadSessionStagingStatus =
  'PARTS_STORED' | 'PARTS_IN_PROGRESS' | 'FILE_TOO_LARGE' | 'WITHIN_LIMIT';

/** GET에서 파생하는 만료·staging 진단이다. */
export interface UploadSessionStagingDiagnosis {
  /** OPEN 세션의 만료 시각 중 하나라도 현재 시각 이하인지 나타낸다. */
  readonly expired: boolean;

  /** 진단 gate를 통과한 현재 staging 한도와 상태다. */
  readonly staging: {
    /** 현재 적용하는 한도다. */
    readonly maxStagedBytes: bigint;

    /** 조각 상태와 파일 크기로 판정한 결과다. */
    readonly status: UploadSessionStagingStatus;
  } | null;
}

/** 새 조각 예약의 정책 판정이다. */
export type UploadPartAdmission =
  /** 파일 크기와 전역·namespace 사용량 한도를 모두 만족한다. */
  | { readonly kind: 'allowed' }
  /** 전체 파일 크기가 staging 한도를 넘는다. */
  | { readonly kind: 'file-too-large'; readonly sizeBytes: bigint; readonly maxStagedBytes: bigint }
  /** 전역 또는 namespace 사용량 한도를 넘는다. */
  | { readonly kind: 'limit' };

const MAX_PART_COUNT = 2147483647;

/** 전역과 namespace의 staging 상한 중 작은 값을 고른다. */
function effectiveMaxStagedBytes(globalMax: bigint, namespaceMax: bigint): bigint {
  return globalMax < namespaceMax ? globalMax : namespaceMax;
}

/** 전역·namespace 업로드 설정을 현재 namespace에 맞게 해석한다. */
export function resolveUploadSessionPolicy(
  policy: UploadSessionPolicy,
  namespaceId: string,
): ResolvedUploadSessionPolicy {
  const global = policy.global;
  const namespace = policy.namespaces[namespaceId] ?? global;
  const namespaceLimits = {
    maxStagedBytes: namespace.maxStagedBytes,
    maxActiveSessions: namespace.maxActiveSessions,
  };
  return {
    caps: {
      global: { maxStagedBytes: global.maxStagedBytes, maxActiveSessions: global.maxActiveSessions },
      namespace: namespaceLimits,
    },
    effectiveMaxStagedBytes: effectiveMaxStagedBytes(global.maxStagedBytes, namespaceLimits.maxStagedBytes),
    partSizeBytes: policy.namespaces[namespaceId]?.partSizeBytes ?? global.partSizeBytes,
    inactivitySeconds: global.inactivitySeconds,
    maxLifetimeSeconds: global.maxLifetimeSeconds,
  };
}

/** 일반 파일 상한과 현재 staging 상한을 정해진 순서로 검사한다. */
export function assessNewUploadFile(input: {
  /** 요청에서 검증한 전체 파일 크기다. */
  readonly sizeBytes: bigint;
  /** 일반 파일 크기 상한이다. */
  readonly maxFileSizeBytes: number;
  /** 현재 namespace에 해석한 정책이다. */
  readonly policy: ResolvedUploadSessionPolicy;
}): NewUploadFileAssessment {
  if (input.sizeBytes > BigInt(input.maxFileSizeBytes)) {
    return { kind: 'file-too-large', maxFileSizeBytes: input.maxFileSizeBytes };
  }
  if (input.sizeBytes > input.policy.effectiveMaxStagedBytes) {
    return {
      kind: 'staging-file-too-large',
      sizeBytes: input.sizeBytes,
      maxStagedBytes: input.policy.effectiveMaxStagedBytes,
    };
  }
  return { kind: 'allowed' };
}

/** 경로 검증 뒤 새 세션의 조각 수와 만료 시각을 계산한다. */
export function planNewUploadSession(input: {
  /** 요청에서 검증한 전체 파일 크기다. */
  readonly sizeBytes: bigint;
  /** 현재 namespace에 해석한 정책이다. */
  readonly policy: ResolvedUploadSessionPolicy;
  /** 호출자가 한 번 캡처한 서버 시각이다. */
  readonly now: Date;
}): NewUploadSessionPlan {
  const partSize = BigInt(input.policy.partSizeBytes);
  const partCount = (input.sizeBytes + partSize - 1n) / partSize;
  if (partCount > BigInt(MAX_PART_COUNT)) return { kind: 'part-count-overflow' };
  return {
    kind: 'planned',
    partSizeBytes: input.policy.partSizeBytes,
    partCount: Number(partCount),
    expiresAt: new Date(input.now.getTime() + input.policy.inactivitySeconds * 1000),
    maxExpiresAt: new Date(input.now.getTime() + input.policy.maxLifetimeSeconds * 1000),
  };
}

/** OPEN 세션의 만료와 staging 진행 상태를 snapshot만으로 진단한다. */
export function diagnoseUploadSessionStaging(input: {
  /** 한 DB snapshot에서 읽은 세션 정보다. */
  readonly session: UploadSessionPolicySnapshot;
  /** 같은 snapshot에 속한 세션 조각이다. */
  readonly parts: readonly UploadPartPolicySnapshot[];
  /** 현재 정책이며, 설정 제거 시 null이다. */
  readonly policy: ResolvedUploadSessionPolicy | null;
  /** 응답을 조립할 때 한 번 캡처한 서버 시각이다. */
  readonly now: Date;
}): UploadSessionStagingDiagnosis {
  const expired =
    input.session.state === 'OPEN' &&
    (input.session.expiresAt <= input.now || input.session.maxExpiresAt <= input.now);
  if (input.session.state !== 'OPEN' || expired || input.policy === null) {
    return { expired, staging: null };
  }

  const stored = new Set<number>();
  const reserved = new Set<number>();
  for (const part of input.parts) {
    if (
      !Number.isSafeInteger(part.partIndex) ||
      part.partIndex < 0 ||
      part.partIndex >= input.session.partCount
    ) {
      continue;
    }
    if (part.state === 'STORED') stored.add(part.partIndex);
    if (part.state === 'RESERVED' && part.leaseExpiresAt !== null && part.leaseExpiresAt > input.now) {
      reserved.add(part.partIndex);
    }
  }

  let reservedMissing = 0;
  for (const index of reserved) {
    if (!stored.has(index)) reservedMissing++;
  }
  let status: UploadSessionStagingStatus;
  if (stored.size === input.session.partCount) status = 'PARTS_STORED';
  else if (stored.size + reservedMissing === input.session.partCount) status = 'PARTS_IN_PROGRESS';
  else if (input.session.sizeBytes > input.policy.effectiveMaxStagedBytes) status = 'FILE_TOO_LARGE';
  else status = 'WITHIN_LIMIT';

  return {
    expired,
    staging: { maxStagedBytes: input.policy.effectiveMaxStagedBytes, status },
  };
}

/** 잠금 안에서 전달된 전역·namespace usage snapshot으로 새 예약을 판정한다. */
export function assessUploadPartAdmission(input: {
  /** 세션 생성 시 고정한 전체 파일 크기다. */
  readonly sizeBytes: bigint;
  /** 이번 조각 예약으로 증가할 바이트다. */
  readonly amountBytes: bigint;
  /** 각각 독립 검사할 전역·namespace 한도다. */
  readonly caps: UploadPolicyCaps;
  /** 잠금 뒤 읽은 전역·namespace 사용량이다. */
  readonly usage: {
    /** 모든 namespace의 staging 사용량이다. */
    readonly globalStagedBytes: bigint;
    /** 현재 namespace의 staging 사용량이다. */
    readonly namespaceStagedBytes: bigint;
  };
}): UploadPartAdmission {
  const maxStagedBytes = effectiveMaxStagedBytes(
    input.caps.global.maxStagedBytes,
    input.caps.namespace.maxStagedBytes,
  );
  if (input.sizeBytes > maxStagedBytes) {
    return { kind: 'file-too-large', sizeBytes: input.sizeBytes, maxStagedBytes };
  }
  if (input.usage.globalStagedBytes + input.amountBytes > input.caps.global.maxStagedBytes) {
    return { kind: 'limit' };
  }
  if (input.usage.namespaceStagedBytes + input.amountBytes > input.caps.namespace.maxStagedBytes) {
    return { kind: 'limit' };
  }
  return { kind: 'allowed' };
}
