import { randomUUID } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { BlobRepository, BLOB_DELETE_CHUNK_SIZE } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';

export interface BlobRepositoryTestContext {
  readonly dataSource: DataSource;
  readonly repository: BlobRepository;
  readonly namespaceId: string;
  setZeroSinceSecondsAgo(blobId: string, secondsAgo: number): Promise<void>;
}

// Postgres/SQLite 공용 테스트 본문. 드라이버별 실행 파일(*.integration-spec.ts,
// *.sqlite.integration-spec.ts)이 이 함수를 호출해 같은 테스트를 두 드라이버에
// 대해 반복한다 — 테스트 로직 중복 없이 드라이버별 실행만 분리한다.
export function runBlobRepositorySharedTests(getContext: () => BlobRepositoryTestContext): void {
  async function createBlob(referenceCount: number): Promise<BlobEntity> {
    const { dataSource, namespaceId } = getContext();
    const blobRepo = dataSource.getRepository(BlobEntity);
    return blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'e'.repeat(64),
        referenceCount,
      }),
    );
  }

  describe('decrementReferenceCount', () => {
    it('0보다 크게 감소하면 zero_since를 채우지 않는다', async () => {
      const { dataSource, repository } = getContext();
      const blob = await createBlob(2);

      await dataSource.transaction((manager) => repository.decrementReferenceCount(manager, blob.id, 1));

      const updated = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });
      expect(updated.referenceCount).toBe(1);
      expect(updated.zeroSince).toBeNull();
    });

    it('0이 되는 순간 zero_since를 기록한다', async () => {
      const { dataSource, repository } = getContext();
      const blob = await createBlob(1);

      await dataSource.transaction((manager) => repository.decrementReferenceCount(manager, blob.id, 1));

      const updated = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });
      expect(updated.referenceCount).toBe(0);
      expect(updated.zeroSince).toBeInstanceOf(Date);
    });
  });

  describe('findOrphanBlobs', () => {
    it('grace period가 지난 reference_count=0 blob만 반환한다', async () => {
      const { repository, setZeroSinceSecondsAgo } = getContext();
      const stillReferenced = await createBlob(1);
      const tooRecent = await createBlob(0);
      const eligible = await createBlob(0);

      await setZeroSinceSecondsAgo(tooRecent.id, 0);
      await setZeroSinceSecondsAgo(eligible.id, 3600);

      const cutoff = new Date(Date.now() - 60_000);
      const orphans = await repository.findOrphanBlobs(cutoff);
      const orphanIds = orphans.map((row) => row.id);

      expect(orphanIds).toContain(eligible.id);
      expect(orphanIds).not.toContain(tooRecent.id);
      expect(orphanIds).not.toContain(stillReferenced.id);
    });
  });

  describe('deleteBlobRows', () => {
    it('지정한 id의 row만 삭제한다', async () => {
      const { dataSource, repository } = getContext();
      const target = await createBlob(0);
      const untouched = await createBlob(0);

      await repository.deleteBlobRows([target.id]);

      const blobRepo = dataSource.getRepository(BlobEntity);
      expect(await blobRepo.findOneBy({ id: target.id })).toBeNull();
      expect(await blobRepo.findOneBy({ id: untouched.id })).not.toBeNull();
    });

    it('빈 배열을 넘기면 아무것도 삭제하지 않는다', async () => {
      const { dataSource, repository } = getContext();
      const untouched = await createBlob(0);

      await repository.deleteBlobRows([]);

      expect(await dataSource.getRepository(BlobEntity).findOneBy({ id: untouched.id })).not.toBeNull();
    });

    it('청크 경계를 넘는 개수의 id도 전부 삭제한다', async () => {
      const { dataSource, repository } = getContext();
      const blobRepo = dataSource.getRepository(BlobEntity);
      // BLOB_DELETE_CHUNK_SIZE를 넘는 개수 생성 (청크 배칭이 제대로 동작하는지 확인)
      const count = BLOB_DELETE_CHUNK_SIZE + 100;
      const blobs = await Promise.all(Array.from({ length: count }, () => createBlob(0)));
      const blobIds = blobs.map((b) => b.id);

      await repository.deleteBlobRows(blobIds);

      // 첫 청크만 지우고 나머지 청크를 누락하는 회귀(예: 루프 off-by-one, 첫
      // 반복 후 조기 return)를 잡기 위해 id 하나가 아니라 전체 id 집합에 대해
      // 남은 row 수를 센다.
      const remainingCount = await blobRepo.count({ where: { id: In(blobIds) } });
      expect(remainingCount).toBe(0);
    });
  });

  describe('findAllStorageKeys', () => {
    it('참조 여부와 무관하게 모든 blob의 storage_key를 반환한다', async () => {
      const { repository } = getContext();
      const referenced = await createBlob(1);
      const orphaned = await createBlob(0);

      const keys = await repository.findAllStorageKeys();

      expect(keys.has(referenced.storageKey)).toBe(true);
      expect(keys.has(orphaned.storageKey)).toBe(true);
    });
  });
}
