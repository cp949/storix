/** 현재 staging 진단의 경계와 큰 조각 수에서의 연산량을 실제 순수 함수로 검증한다. */
import { jest } from '@jest/globals';
import { assessUploadSessionStaging } from '../../src/vfs/upload-session-staging.policy.js';

describe('업로드 세션 staging 진단', () => {
  const now = new Date('2026-10-07T00:00:00.000Z');

  it('현재 한도를 넘는 미저장 세션을 진단한다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 10n,
        partCount: 3,
        parts: [{ partIndex: 0, state: 'STORED', leaseExpiresAt: null }],
        maxStagedBytes: 8n,
        now,
      }),
    ).toEqual({ maxStagedBytes: '8', status: 'FILE_TOO_LARGE' });
  });

  it('모든 누락 조각에 유효 예약이 있으면 파일 크기보다 진행 중 상태를 우선한다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 10n,
        partCount: 3,
        parts: [
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 1, state: 'RESERVED', leaseExpiresAt: new Date(now.getTime() + 1) },
          { partIndex: 2, state: 'RESERVED', leaseExpiresAt: new Date(now.getTime() + 1) },
        ],
        maxStagedBytes: 8n,
        now,
      }),
    ).toEqual({ maxStagedBytes: '8', status: 'PARTS_IN_PROGRESS' });
  });

  it('lease가 현재 시각과 같으면 유효 예약으로 세지 않는다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 10n,
        partCount: 2,
        parts: [
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 1, state: 'RESERVED', leaseExpiresAt: now },
        ],
        maxStagedBytes: 8n,
        now,
      }).status,
    ).toBe('FILE_TOO_LARGE');
  });

  it('최대 조각 수에서도 미저장 index 전체를 열거하지 않는다', () => {
    const originalHas = Set.prototype.has;
    let lookups = 0;
    // 기존 결함을 OOM 없이 재현한다. 소수의 실제 행을 진단할 때 전체 index 탐색을 차단한다.
    const has = jest.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value) {
      if (++lookups > 16) throw new Error('미저장 index 전체 탐색');
      return originalHas.call(this, value);
    });
    let result;
    try {
      result = assessUploadSessionStaging({
        sizeBytes: 2147483647n,
        partCount: 2147483647,
        parts: [
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 1, state: 'RESERVED', leaseExpiresAt: new Date(now.getTime() + 1) },
        ],
        maxStagedBytes: 2147483647n,
        now,
      });
    } finally {
      has.mockRestore();
    }
    expect(result).toEqual({ maxStagedBytes: '2147483647', status: 'WITHIN_LIMIT' });
  });

  it('모든 조각이 저장됐으면 현재 staging 한도를 넘겨도 저장 완료로 진단한다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 10n,
        partCount: 2,
        parts: [
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 1, state: 'STORED', leaseExpiresAt: null },
        ],
        maxStagedBytes: 8n,
        now,
      }).status,
    ).toBe('PARTS_STORED');
  });

  it('정확히 한도 이하면 이어갈 수 있는 상태로 진단한다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 8n,
        partCount: 2,
        parts: [{ partIndex: 0, state: 'STORED', leaseExpiresAt: null }],
        maxStagedBytes: 8n,
        now,
      }).status,
    ).toBe('WITHIN_LIMIT');
  });

  it('조각이 없는 0 byte 세션은 저장 완료로 진단한다', () => {
    expect(
      assessUploadSessionStaging({ sizeBytes: 0n, partCount: 0, parts: [], maxStagedBytes: 8n, now }).status,
    ).toBe('PARTS_STORED');
  });

  it('2의 53제곱을 넘는 바이트를 bigint로 비교한다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 9007199254740993n,
        partCount: 1,
        parts: [],
        maxStagedBytes: 9007199254740992n,
        now,
      }).status,
    ).toBe('FILE_TOO_LARGE');
  });

  it('중복 index와 정리·삭제·만료·lease 없는 예약을 저장 또는 진행으로 세지 않는다', () => {
    expect(
      assessUploadSessionStaging({
        sizeBytes: 10n,
        partCount: 2,
        parts: [
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 0, state: 'STORED', leaseExpiresAt: null },
          { partIndex: 1, state: 'CLEANUP', leaseExpiresAt: new Date(now.getTime() + 1) },
        ],
        maxStagedBytes: 8n,
        now,
      }).status,
    ).toBe('FILE_TOO_LARGE');
  });
});
