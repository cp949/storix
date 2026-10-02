import { randomUUID } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import { BlobRepository, BLOB_DELETE_CHUNK_SIZE } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';

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

  describe('findOrphanBlobsPage', () => {
    it('grace period가 지난 reference_count=0 blob만 반환한다', async () => {
      const { repository, setZeroSinceSecondsAgo } = getContext();
      const stillReferenced = await createBlob(1);
      const tooRecent = await createBlob(0);
      const eligible = await createBlob(0);

      await setZeroSinceSecondsAgo(tooRecent.id, 0);
      await setZeroSinceSecondsAgo(eligible.id, 3600);

      const cutoff = new Date(Date.now() - 60_000);
      const orphanIds = (await repository.findOrphanBlobsPage(cutoff, null, 1000)).map((row) => row.id);

      expect(orphanIds).toContain(eligible.id);
      expect(orphanIds).not.toContain(tooRecent.id);
      expect(orphanIds).not.toContain(stillReferenced.id);
    });

    it('(zero_since, id) 순서의 keyset으로 모든 후보를 한 번씩만 page 단위로 돌려준다', async () => {
      const { repository, setZeroSinceSecondsAgo } = getContext();
      const blobs = await Promise.all(Array.from({ length: 7 }, () => createBlob(0)));
      // 3개는 같은 zero_since라 id가 tie-breaker가 된다.
      for (const [index, blob] of blobs.entries())
        await setZeroSinceSecondsAgo(blob.id, index < 3 ? 7200 : 7200 + index * 60);
      const mine = new Set(blobs.map((blob) => blob.id));
      const cutoff = new Date(Date.now() - 60_000);

      const seen: string[] = [];
      let cursor: { zeroSince: string; id: string } | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const page = await repository.findOrphanBlobsPage(cutoff, cursor, 2);
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(2);
        seen.push(...page.map((row) => row.id));
        const last = page[page.length - 1];
        cursor = { zeroSince: last.zeroSince, id: last.id };
      }

      const filtered = seen.filter((id) => mine.has(id));
      expect(filtered).toHaveLength(7);
      expect(new Set(seen).size).toBe(seen.length);
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

  describe('findKnownStorageKeys', () => {
    it('참조 여부와 무관하게 DB에 있는 storage_key만 돌려준다', async () => {
      const { repository } = getContext();
      const referenced = await createBlob(1);
      const orphaned = await createBlob(0);

      const known = await repository.findKnownStorageKeys([
        referenced.storageKey,
        orphaned.storageKey,
        'blobs/ab/not-in-db',
      ]);

      expect(known).toEqual(new Set([referenced.storageKey, orphaned.storageKey]));
    });

    it('빈 목록은 빈 집합이다', async () => {
      expect(await getContext().repository.findKnownStorageKeys([])).toEqual(new Set());
    });

    it('질의 청크 크기를 넘는 key 목록도 모두 대조한다', async () => {
      const { repository } = getContext();
      const blobs = await Promise.all(Array.from({ length: 3 }, () => createBlob(1)));
      const filler = Array.from({ length: 1200 }, (_, i) => `blobs/zz/missing-${i}`);
      const keys = [...filler.slice(0, 600), blobs[0].storageKey, ...filler.slice(600), blobs[1].storageKey];

      const known = await repository.findKnownStorageKeys(keys);

      expect(known).toEqual(new Set([blobs[0].storageKey, blobs[1].storageKey]));
    });
  });
}
