import { DomainError } from '../common/domain-error.js';
import type { BlobRepository } from '../persistence/blob.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';

/**
 * 업로드한 object를 가리키는 Blob row가 없고 오류가 확정된 4xx 롤백이면 object 삭제를 시도한다.
 * 삭제 실패는 무시한다.
 *
 * commit 결과가 불명확한 DB 장애(ack 유실)에서 참조된 객체를 지우면 공개 파일이 손실된다.
 * 참조 여부를 확인하지 못해도, 5xx와 비도메인 오류여도 보존하고 orphan GC에 맡긴다.
 * 규칙은 docs/design/02-receipt-error-replay.md "content 업로드"를 따른다.
 */
export async function deleteUnreferencedUpload(
  blobs: Pick<BlobRepository, 'findKnownStorageKeys'>,
  storage: Pick<BlobStorage, 'delete'>,
  storageKey: string,
  error: unknown,
): Promise<void> {
  const referenced = await blobs
    .findKnownStorageKeys([storageKey])
    .then((known) => known.has(storageKey))
    .catch(() => true);
  if (!referenced && error instanceof DomainError && error.status < 500)
    await storage.delete(storageKey).catch(() => undefined);
}
