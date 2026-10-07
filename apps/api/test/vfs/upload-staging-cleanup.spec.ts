/**
 * repository test double과 제어 저장소로 DB 오류 전달과 AbortSignal 단계 차단을 검증한다.
 * 규칙은 docs/design/07-resumable-upload.md "staging 정리 module".
 */
import { jest } from '@jest/globals';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { UploadStagingCleanup } from '../../src/vfs/upload-staging-cleanup.js';

const target = { sessionId: 'session', partIndex: 0, stagingKey: 'upload-staging/key' };
const applied = { applied: true, refundedBytes: '4' };

/** storage DELETE와 DB 정산의 실패를 서로 독립적으로 주입한다. */
function fixture() {
  const storage = { delete: jest.fn<BlobStorage['delete']>().mockResolvedValue(undefined) };
  const sessions = {
    releasePartReservationDetailed: jest
      .fn<VfsUploadSessionRepository['releasePartReservationDetailed']>()
      .mockResolvedValue(applied),
    retireExpiredPartReservation: jest
      .fn<VfsUploadSessionRepository['retireExpiredPartReservation']>()
      .mockResolvedValue(true),
    markTombstoneDeletedDetailed: jest
      .fn<VfsUploadSessionRepository['markTombstoneDeletedDetailed']>()
      .mockResolvedValue(applied),
    markStagingObjectDeletedDetailed: jest
      .fn<VfsUploadSessionRepository['markStagingObjectDeletedDetailed']>()
      .mockResolvedValue(applied),
    findCleanupTombstone: jest
      .fn<VfsUploadSessionRepository['findCleanupTombstone']>()
      .mockResolvedValue({ putSettledAt: null }),
    findCleanupPart: jest
      .fn<VfsUploadSessionRepository['findCleanupPart']>()
      .mockResolvedValue({ state: 'CLEANUP' }),
  };
  return {
    storage,
    sessions,
    cleanup: new UploadStagingCleanup(
      storage as unknown as BlobStorage,
      sessions as unknown as VfsUploadSessionRepository,
    ),
  };
}

// DELETE 오류와 DB 오류를 혼동하거나 deadline 뒤 다음 I/O를 시작하는 회귀를 차단한다.
describe('staging 정리 오류와 deadline', () => {
  it('DELETE 실패 뒤 정착 기록을 기다리고 원래 오류를 반환한다', async () => {
    const f = fixture();
    const error = new Error('delete failed');
    f.storage.delete.mockRejectedValue(error);
    expect(await f.cleanup.cleanupSettledReservation(target)).toEqual({ kind: 'delete-failed', error });
    expect(f.sessions.releasePartReservationDetailed).toHaveBeenCalledWith(
      'session',
      0,
      true,
      target.stagingKey,
    );
  });

  it.each(['cleanupSettledReservation', 'cleanupExpiredReservation', 'cleanupStoredPart'] as const)(
    '%s의 DB 오류는 DELETE 실패로 바꾸지 않는다',
    async (method) => {
      const f = fixture();
      const error = new Error('database failed');
      f.sessions.releasePartReservationDetailed.mockRejectedValue(error);
      f.sessions.markTombstoneDeletedDetailed.mockRejectedValue(error);
      f.sessions.markStagingObjectDeletedDetailed.mockRejectedValue(error);
      await expect(f.cleanup[method](target)).rejects.toBe(error);
    },
  );

  it('tombstone의 DB 오류는 전달한다', async () => {
    const f = fixture();
    const error = new Error('database failed');
    f.sessions.markTombstoneDeletedDetailed.mockRejectedValue(error);
    await expect(f.cleanup.cleanupTombstone(target.stagingKey)).rejects.toBe(error);
  });

  it('DELETE 실패 뒤 정착 DB 기록이 실패하면 DB 오류를 전달한다', async () => {
    const f = fixture();
    f.storage.delete.mockRejectedValue(new Error('delete failed'));
    const error = new Error('database failed');
    f.sessions.releasePartReservationDetailed.mockRejectedValue(error);
    await expect(f.cleanup.cleanupSettledReservation(target)).rejects.toBe(error);
  });

  it('retire 대기 중 abort는 DELETE를 시작하지 않는다', async () => {
    const f = fixture();
    const controller = new AbortController();
    const error = new Error('deadline');
    f.sessions.retireExpiredPartReservation.mockImplementation(async () => {
      controller.abort(error);
      return true;
    });
    await expect(f.cleanup.cleanupExpiredReservation(target, controller.signal)).rejects.toBe(error);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });

  it('DELETE 대기 중 abort는 mark를 시작하지 않는다', async () => {
    const f = fixture();
    const controller = new AbortController();
    const error = new Error('deadline');
    f.storage.delete.mockImplementation(async () => {
      controller.abort(error);
    });
    await expect(f.cleanup.cleanupExpiredReservation(target, controller.signal)).rejects.toBe(error);
    expect(f.sessions.markTombstoneDeletedDetailed).not.toHaveBeenCalled();
  });

  it('이미 abort된 요청은 retire도 시작하지 않는다', async () => {
    const f = fixture();
    const controller = new AbortController();
    const error = new Error('deadline');
    controller.abort(error);
    await expect(f.cleanup.cleanupExpiredReservation(target, controller.signal)).rejects.toBe(error);
    expect(f.sessions.retireExpiredPartReservation).not.toHaveBeenCalled();
  });

  it('retire가 적용되지 않으면 삭제 없이 건너뛴다', async () => {
    const f = fixture();
    f.sessions.retireExpiredPartReservation.mockResolvedValue(false);
    expect(await f.cleanup.cleanupExpiredReservation(target)).toEqual({
      kind: 'skipped',
      reason: 'reservation-not-retired',
    });
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
});
