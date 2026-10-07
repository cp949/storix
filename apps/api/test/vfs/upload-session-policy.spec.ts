/**
 * DB 없이 업로드 정책 module의 한도·우선순위·시간·index 경계를 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md의 생성·재생 규칙과 정책 변경·staging 진단 절을 따른다.
 */
import { jest } from '@jest/globals';
import {
  assessNewUploadFile,
  assessUploadPartAdmission,
  diagnoseUploadSessionStaging,
  planNewUploadSession,
  resolveUploadSessionPolicy,
  type UploadPartPolicySnapshot,
  type UploadSessionPolicySnapshot,
} from '../../src/vfs/upload-session-policy.js';
import type { UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';

const policy: UploadSessionPolicy = {
  global: {
    maxStagedBytes: 8n,
    maxActiveSessions: 4,
    partSizeBytes: 4,
    inactivitySeconds: 60,
    maxLifetimeSeconds: 120,
  },
  namespaces: {
    '223e4567-e89b-42d3-a456-426614174000': {
      maxStagedBytes: 6n,
      maxActiveSessions: 2,
      partSizeBytes: 2,
    },
    '223e4567-e89b-42d3-a456-426614174001': {
      maxStagedBytes: 8n,
      maxActiveSessions: 3,
    },
  },
};
const namespaceId = '223e4567-e89b-42d3-a456-426614174000';
const now = new Date('2026-10-08T00:00:00.000Z');
const projection = resolveUploadSessionPolicy(policy, namespaceId);

/** 진단 테스트에 쓸 기본 세션 snapshot을 만든다. */
function session(overrides: Partial<UploadSessionPolicySnapshot> = {}): UploadSessionPolicySnapshot {
  return {
    state: 'OPEN',
    sizeBytes: 10n,
    partCount: 2,
    expiresAt: new Date(now.getTime() + 1000),
    maxExpiresAt: new Date(now.getTime() + 2000),
    ...overrides,
  };
}

/** 지정 index와 상태를 가진 조각 snapshot을 만든다. */
function part(
  partIndex: number,
  state: UploadPartPolicySnapshot['state'],
  leaseExpiresAt: Date | null = null,
): UploadPartPolicySnapshot {
  return { partIndex, state, leaseExpiresAt };
}

// 생성·조회·조각 예약의 우선순위와 경계값은 공개 동작 계약이다.
// 순수 함수 단위 검증으로 I/O와 무관하게 한계값 조합을 재현한다.
describe('업로드 세션 정책 module', () => {
  it('정확한 namespace key를 적용하고 없는 namespace는 전역값을 상속한다', () => {
    expect(resolveUploadSessionPolicy(policy, namespaceId)).toEqual({
      caps: {
        global: { maxStagedBytes: 8n, maxActiveSessions: 4 },
        namespace: { maxStagedBytes: 6n, maxActiveSessions: 2 },
      },
      effectiveMaxStagedBytes: 6n,
      partSizeBytes: 2,
      inactivitySeconds: 60,
      maxLifetimeSeconds: 120,
    });
    expect(resolveUploadSessionPolicy(policy, namespaceId.toUpperCase()).caps.namespace).toEqual({
      maxStagedBytes: 8n,
      maxActiveSessions: 4,
    });
    expect(resolveUploadSessionPolicy(policy, '223e4567-e89b-42d3-a456-426614174001').partSizeBytes).toBe(4);
  });

  it('파일 상한을 staging 상한보다 먼저 판정한다', () => {
    const globalBounded = resolveUploadSessionPolicy(policy, '223e4567-e89b-42d3-a456-426614174001');
    for (const sizeBytes of [0n, 7n, 8n]) {
      expect(assessNewUploadFile({ sizeBytes, maxFileSizeBytes: 10, policy: globalBounded })).toEqual({
        kind: 'allowed',
      });
    }
    expect(assessNewUploadFile({ sizeBytes: 9n, maxFileSizeBytes: 10, policy: globalBounded })).toEqual({
      kind: 'staging-file-too-large',
      sizeBytes: 9n,
      maxStagedBytes: 8n,
    });
    expect(assessNewUploadFile({ sizeBytes: 0n, maxFileSizeBytes: 10, policy: projection })).toEqual({
      kind: 'allowed',
    });
    expect(assessNewUploadFile({ sizeBytes: 6n, maxFileSizeBytes: 10, policy: projection })).toEqual({
      kind: 'allowed',
    });
    expect(assessNewUploadFile({ sizeBytes: 7n, maxFileSizeBytes: 10, policy: projection })).toEqual({
      kind: 'staging-file-too-large',
      sizeBytes: 7n,
      maxStagedBytes: 6n,
    });
    expect(assessNewUploadFile({ sizeBytes: 9n, maxFileSizeBytes: 8, policy: projection })).toEqual({
      kind: 'file-too-large',
      maxFileSizeBytes: 8,
    });
  });

  it('파일 크기 비교에서 2의 53승을 넘는 정수를 구분한다', () => {
    const largePolicy = { ...projection, effectiveMaxStagedBytes: 9007199254740992n };
    expect(
      assessNewUploadFile({
        sizeBytes: 9007199254740992n,
        maxFileSizeBytes: Number.MAX_SAFE_INTEGER,
        policy: largePolicy,
      }).kind,
    ).toBe('file-too-large');
    expect(
      assessUploadPartAdmission({
        sizeBytes: 9007199254740992n,
        amountBytes: 1n,
        caps: {
          global: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 1 },
          namespace: { maxStagedBytes: 9007199254740993n, maxActiveSessions: 1 },
        },
        usage: { globalStagedBytes: 9007199254740992n, namespaceStagedBytes: 9007199254740992n },
      }),
    ).toEqual({ kind: 'allowed' });
    expect(
      assessUploadPartAdmission({
        sizeBytes: 9007199254740993n,
        amountBytes: 1n,
        caps: {
          global: { maxStagedBytes: 9007199254740992n, maxActiveSessions: 1 },
          namespace: { maxStagedBytes: 9007199254740992n, maxActiveSessions: 1 },
        },
        usage: { globalStagedBytes: 9007199254740992n, namespaceStagedBytes: 9007199254740992n },
      }).kind,
    ).toBe('file-too-large');
    expect(
      diagnoseUploadSessionStaging({
        session: session({ sizeBytes: 9007199254740993n, partCount: 1 }),
        parts: [],
        policy: { ...projection, effectiveMaxStagedBytes: 9007199254740992n },
        now,
      }).staging?.status,
    ).toBe('FILE_TOO_LARGE');
  });

  it('조각 수와 만료 시각을 bigint 크기와 명시한 now로 계산한다', () => {
    expect(planNewUploadSession({ sizeBytes: 10n, policy: projection, now })).toEqual({
      kind: 'planned',
      partSizeBytes: 2,
      partCount: 5,
      expiresAt: new Date('2026-10-08T00:01:00.000Z'),
      maxExpiresAt: new Date('2026-10-08T00:02:00.000Z'),
    });
    expect(planNewUploadSession({ sizeBytes: 0n, policy: projection, now })).toMatchObject({
      kind: 'planned',
      partCount: 0,
    });
    expect(
      planNewUploadSession({
        sizeBytes: 2147483648n,
        policy: { ...projection, partSizeBytes: 1 },
        now,
      }),
    ).toEqual({ kind: 'part-count-overflow' });
  });

  it('만료는 OPEN 세션에서만 now 이상일 때 판정한다', () => {
    expect(
      diagnoseUploadSessionStaging({
        session: session({ expiresAt: now }),
        parts: [],
        policy: projection,
        now,
      }),
    ).toEqual({ expired: true, staging: null });
    expect(
      diagnoseUploadSessionStaging({
        session: session({ state: 'CANCELLED', expiresAt: now }),
        parts: [],
        policy: projection,
        now,
      }).expired,
    ).toBe(false);
    expect(
      diagnoseUploadSessionStaging({
        session: session({ maxExpiresAt: now }),
        parts: [],
        policy: projection,
        now,
      }).expired,
    ).toBe(true);
  });

  it('정책 부재·종결·만료 세션에는 staging 진단을 생략한다', () => {
    for (const value of [
      { snapshot: session(), policyValue: null },
      { snapshot: session({ state: 'CANCELLED' }), policyValue: projection },
      { snapshot: session({ expiresAt: now }), policyValue: projection },
    ]) {
      expect(
        diagnoseUploadSessionStaging({ session: value.snapshot, parts: [], policy: value.policyValue, now })
          .staging,
      ).toBeNull();
    }
  });

  it.each(['FINALIZING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const)(
    '%s 상태에서는 만료와 staging을 파생하지 않는다',
    (state) => {
      expect(
        diagnoseUploadSessionStaging({
          session: session({ state, expiresAt: now, maxExpiresAt: now }),
          parts: [],
          policy: projection,
          now,
        }),
      ).toEqual({ expired: false, staging: null });
    },
  );

  it('저장·예약 진단의 우선순위와 lease 경계를 적용한다', () => {
    expect(
      diagnoseUploadSessionStaging({
        session: session({ partCount: 0, sizeBytes: 0n }),
        parts: [],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('PARTS_STORED');
    expect(
      diagnoseUploadSessionStaging({
        session: session(),
        parts: [part(0, 'STORED'), part(1, 'STORED'), part(1, 'RESERVED', new Date(now.getTime() + 1))],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('PARTS_STORED');
    expect(
      diagnoseUploadSessionStaging({
        session: session(),
        parts: [part(0, 'STORED'), part(1, 'RESERVED', now)],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('FILE_TOO_LARGE');
    expect(
      diagnoseUploadSessionStaging({
        session: session(),
        parts: [part(0, 'STORED'), part(1, 'RESERVED', new Date(now.getTime() + 1))],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('PARTS_IN_PROGRESS');
    expect(
      diagnoseUploadSessionStaging({
        session: session({ sizeBytes: 6n }),
        parts: [part(0, 'STORED'), part(1, 'RESERVED', new Date(now.getTime() - 1))],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('WITHIN_LIMIT');
    expect(
      diagnoseUploadSessionStaging({
        session: session(),
        parts: [part(-1, 'STORED'), part(2, 'STORED'), part(1, 'CLEANUP'), part(1, 'DELETED')],
        policy: projection,
        now,
      }).staging?.status,
    ).toBe('FILE_TOO_LARGE');
  });

  it('최대 partCount에서도 실제 행만 순회한다', () => {
    const originalHas = Set.prototype.has;
    let lookups = 0;
    const has = jest.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value) {
      if (++lookups > 16) throw new Error('미저장 index 전체 탐색');
      return originalHas.call(this, value);
    });
    let result;
    try {
      result = diagnoseUploadSessionStaging({
        session: session({ sizeBytes: 2147483647n, partCount: 2147483647 }),
        parts: [part(0, 'STORED'), part(1, 'RESERVED', new Date(now.getTime() + 1))],
        policy: { ...projection, effectiveMaxStagedBytes: 2147483647n },
        now,
      });
    } finally {
      has.mockRestore();
    }
    expect(result?.staging?.status).toBe('WITHIN_LIMIT');
  });

  it('전역 사용량과 namespace 사용량을 각각 검사하고 파일 초과를 우선한다', () => {
    const common = {
      sizeBytes: 6n,
      amountBytes: 2n,
      caps: projection.caps,
    };
    expect(
      assessUploadPartAdmission({ ...common, usage: { globalStagedBytes: 6n, namespaceStagedBytes: 4n } }),
    ).toEqual({ kind: 'allowed' });
    expect(
      assessUploadPartAdmission({ ...common, usage: { globalStagedBytes: 7n, namespaceStagedBytes: 4n } }),
    ).toEqual({ kind: 'limit' });
    expect(
      assessUploadPartAdmission({ ...common, usage: { globalStagedBytes: 6n, namespaceStagedBytes: 5n } }),
    ).toEqual({ kind: 'limit' });
    expect(
      assessUploadPartAdmission({
        ...common,
        sizeBytes: 7n,
        usage: { globalStagedBytes: 7n, namespaceStagedBytes: 5n },
      }),
    ).toEqual({
      kind: 'file-too-large',
      sizeBytes: 7n,
      maxStagedBytes: 6n,
    });
  });
});
