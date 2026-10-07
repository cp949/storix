/**
 * 현재 정책을 기준으로 OPEN 업로드 세션의 staging 진행 상태를 진단한다.
 * 진단은 예약이나 세션 상태를 변경하지 않는다.
 * 규칙은 docs/design/07-resumable-upload.md의 정책 적용 절을 따른다.
 */

/** GET 응답에 공개하는 staging 진단 상태다. */
export type UploadSessionStagingStatus =
  'PARTS_STORED' | 'PARTS_IN_PROGRESS' | 'FILE_TOO_LARGE' | 'WITHIN_LIMIT';

/** 현재 staging 한도와 세션 진행 상태를 나타낸다. */
export interface UploadSessionStagingAssessment {
  /** 현재 적용하는 staging 바이트 한도다. */
  readonly maxStagedBytes: string;

  /** 한도와 조각 상태를 함께 판정한 진단값이다. */
  readonly status: UploadSessionStagingStatus;
}

/** 세션 조각을 공개 진단 상태로 판정하는 입력이다. */
export interface AssessUploadSessionStagingInput {
  /** 세션 생성 시 고정한 전체 파일 크기다. */
  readonly sizeBytes: bigint;

  /** 세션 생성 시 고정한 조각 개수다. */
  readonly partCount: number;

  /** 내부 저장소가 읽은 조각 상태다. */
  readonly parts: readonly {
    /** 세션 내 조각 index다. */
    readonly partIndex: number;

    /** 예약·저장·정리·삭제 상태다. */
    readonly state: 'RESERVED' | 'STORED' | 'CLEANUP' | 'DELETED';

    /** RESERVED lease 만료 시각이다. */
    readonly leaseExpiresAt: Date | null;
  }[];

  /** 현재 적용하는 staging 바이트 한도다. */
  readonly maxStagedBytes: bigint;

  /** 응답 조립 중 한 번 잡은 서버 시각이다. */
  readonly now: Date;
}

/** 세션 조각을 공개 진단 상태로 판정한다. */
export function assessUploadSessionStaging(
  input: AssessUploadSessionStagingInput,
): UploadSessionStagingAssessment {
  const stored = new Set<number>();
  const reserved = new Set<number>();
  for (const part of input.parts) {
    if (!Number.isSafeInteger(part.partIndex) || part.partIndex < 0 || part.partIndex >= input.partCount)
      continue;
    if (part.state === 'STORED') stored.add(part.partIndex);
    if (part.state === 'RESERVED' && part.leaseExpiresAt && part.leaseExpiresAt > input.now)
      reserved.add(part.partIndex);
  }
  // 조각 수는 int32 최대까지 가능하다. 실제 행의 유효 index만 세고 미저장 범위를 열거하지 않는다.
  let reservedMissing = 0;
  for (const index of reserved) {
    if (!stored.has(index)) reservedMissing++;
  }
  let status: UploadSessionStagingStatus;
  if (stored.size === input.partCount) status = 'PARTS_STORED';
  else if (stored.size + reservedMissing === input.partCount) status = 'PARTS_IN_PROGRESS';
  else if (input.sizeBytes > input.maxStagedBytes) status = 'FILE_TOO_LARGE';
  else status = 'WITHIN_LIMIT';
  return { maxStagedBytes: input.maxStagedBytes.toString(), status };
}
