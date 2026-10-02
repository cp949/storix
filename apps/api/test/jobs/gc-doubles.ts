import { jest } from '@jest/globals';
import type {
  BlobRepository,
  OrphanBlobCursor,
  OrphanBlobPageRow,
} from '../../src/persistence/blob.repository.js';
import type {
  BlobObjectInfo,
  BlobPage,
  BlobPageOptions,
  BlobStorage,
} from '../../src/storage/blob-storage.js';

/** GC 단위 테스트용 저장소. key 오름차순 page와 삭제 기록을 제공한다. */
export class PagedStorage {
  readonly deleted: string[] = [];
  readonly pageCalls: Array<{ prefix: string; options: BlobPageOptions }> = [];
  private readonly objects: BlobObjectInfo[];

  constructor(
    objects: readonly BlobObjectInfo[] = [],
    private readonly onDelete: (key: string) => Promise<void> = async () => undefined,
  ) {
    this.objects = [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async listPage(prefix: string, options: BlobPageOptions): Promise<BlobPage> {
    this.pageCalls.push({ prefix, options });
    const matching = this.objects.filter(
      (item) =>
        item.key.startsWith(prefix) && (options.startAfter === undefined || item.key > options.startAfter),
    );
    const items = matching.slice(0, options.limit);
    return { items, nextAfter: matching.length > options.limit ? items[items.length - 1].key : null };
  }

  async delete(key: string): Promise<void> {
    await this.onDelete(key);
    this.deleted.push(key);
  }

  asBlobStorage(): BlobStorage {
    return this as unknown as BlobStorage;
  }
}

/** GC 단위 테스트용 blob repository. DB 대신 메모리 집합과 정렬된 orphan 목록을 쓴다. */
export class BlobRepositoryDouble {
  readonly deletedRows: string[] = [];
  readonly orphanCalls: Array<{ after: OrphanBlobCursor | null; limit: number }> = [];

  constructor(
    private readonly known: ReadonlySet<string> = new Set(),
    private orphans: OrphanBlobPageRow[] = [],
  ) {}

  findKnownStorageKeys = jest.fn(
    async (keys: readonly string[]) => new Set(keys.filter((key) => this.known.has(key))),
  );

  async findOrphanBlobsPage(
    _cutoff: Date,
    after: OrphanBlobCursor | null,
    limit: number,
  ): Promise<OrphanBlobPageRow[]> {
    this.orphanCalls.push({ after, limit });
    const sorted = [...this.orphans].sort((a, b) =>
      a.zeroSince < b.zeroSince ? -1 : a.zeroSince > b.zeroSince ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    return sorted
      .filter(
        (row) =>
          after === null ||
          row.zeroSince > after.zeroSince ||
          (row.zeroSince === after.zeroSince && row.id > after.id),
      )
      .slice(0, limit);
  }

  async deleteBlobRows(ids: string[]): Promise<void> {
    this.deletedRows.push(...ids);
    this.orphans = this.orphans.filter((row) => !ids.includes(row.id));
  }

  asBlobRepository(): BlobRepository {
    return this as unknown as BlobRepository;
  }
}
