// 실제 in-memory SQLite와 migration으로 archive capture·오류·DB deadline을 검증한다.
// 원본 참조 수와 요청 순서 유지, namespace 제한, Nest provider 주입을 확인한다.
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { ArchiveSourceRepository } from '../../src/persistence/archive-source.repository.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsArchiveSourceNotFoundError } from '../../src/vfs/vfs.errors.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';

// 입력과 DB 상태를 고정해 capture 결과와 거부 조건을 재현한다.
describe('ArchiveSourceRepository SQLite capture 검증', () => {
  let dataSource: DataSource;
  let repository: ArchiveSourceRepository;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    installSqliteGate(dataSource);
    repository = new ArchiveSourceRepository(dataSource);
  });

  afterAll(async () => dataSource.destroy());

  /** 독립 namespace·root와 Blob을 참조하는 FILE을 만들어 capture 입력을 제공한다. */
  async function fixture(name = 'archive-source') {
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `${name}-${randomUUID()}`,
    );
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    const blob = await dataSource.getRepository(BlobEntity).save(
      dataSource.getRepository(BlobEntity).create({
        namespaceId: namespace.id,
        storageKey: `blobs/${randomUUID()}`,
        size: '7',
        mimeType: 'text/plain',
        sha256: 'a'.repeat(64),
        referenceCount: 1,
      }),
    );
    const file = await dataSource.getRepository(VfsNodeEntity).save(
      dataSource.getRepository(VfsNodeEntity).create({
        namespaceId: namespace.id,
        parentId: root.id,
        type: 'FILE',
        name: 'source.txt',
        blobId: blob.id,
        size: '7',
        mimeType: 'text/plain',
      }),
    );
    return { namespace, root, blob, file };
  }

  const limits = { maxEntries: 10, maxSourceBytes: 100n, maxSeconds: 30 };

  it('Nest provider가 DataSource를 주입해 capture를 실행한다', async () => {
    const { namespace, root, file } = await fixture();
    const module = await Test.createTestingModule({
      providers: [ArchiveSourceRepository, { provide: DataSource, useValue: dataSource }],
    }).compile();
    try {
      const result = await module
        .get(ArchiveSourceRepository)
        .capture(
          namespace.id,
          root.id,
          { target: '/result.zip', entries: [{ id: file.id, name: 'source.txt' }] },
          limits,
        );
      expect(result.entries[0].id).toBe(file.id);
    } finally {
      await module.close();
    }
  });

  it('현재 FILE metadata를 입력 순서대로 capture하고 reference count를 바꾸지 않는다', async () => {
    const { namespace, root, blob, file } = await fixture();
    const before = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });
    const result = await repository.capture(
      namespace.id,
      root.id,
      {
        target: '/result.zip',
        entries: [{ id: file.id, name: 'folder/source.txt', revision: encodeRevision(file) }],
      },
      limits,
    );
    const after = await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: blob.id });

    expect(result.entries).toMatchObject([
      { id: file.id, blobId: blob.id, storageKey: blob.storageKey, plaintextBytes: 7n },
    ]);
    expect(result.sourceBytes).toBe(7n);
    expect(result.deadlineAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.referenceCount).toBe(before.referenceCount);
  });

  it('같은 FILE을 여러 이름으로 요청하면 순서와 중복 byte를 합계에 보존한다', async () => {
    const { namespace, root, file } = await fixture();
    const result = await repository.capture(
      namespace.id,
      root.id,
      {
        target: '/result.zip',
        entries: [
          { id: file.id, name: 'second.txt' },
          { id: file.id, name: 'first.txt' },
        ],
      },
      limits,
    );
    expect(result.entries.map(({ name }) => name)).toEqual(['second.txt', 'first.txt']);
    expect(result.sourceBytes).toBe(14n);
  });

  it('400개를 넘는 FILE과 Blob을 조회해 역순 입력을 보존한다', async () => {
    const { namespace, root } = await fixture();
    const blobRepository = dataSource.getRepository(BlobEntity);
    const blobs = await blobRepository.save(
      Array.from({ length: 401 }, () =>
        blobRepository.create({
          namespaceId: namespace.id,
          storageKey: `blobs/${randomUUID()}`,
          size: '1',
          mimeType: 'application/octet-stream',
          sha256: 'd'.repeat(64),
          referenceCount: 1,
        }),
      ),
    );
    const nodeRepository = dataSource.getRepository(VfsNodeEntity);
    const files = await nodeRepository.save(
      blobs.map((blob, index) =>
        nodeRepository.create({
          namespaceId: namespace.id,
          parentId: root.id,
          type: 'FILE',
          name: `source-${index}`,
          blobId: blob.id,
          size: '1',
          mimeType: 'application/octet-stream',
        }),
      ),
    );
    const requested = [...files].reverse().map((file) => ({ id: file.id, name: file.name }));
    const result = await repository.capture(
      namespace.id,
      root.id,
      { target: '/result.zip', entries: requested },
      { maxEntries: 401, maxSourceBytes: 401n, maxSeconds: 30 },
    );
    expect(result.entries.map(({ id }) => id)).toEqual(requested.map(({ id }) => id));
    expect(result.sourceBytes).toBe(401n);
    expect(
      result.entries.every(
        (entry) => entry.storageKey === blobs[files.findIndex((file) => file.id === entry.id)].storageKey,
      ),
    ).toBe(true);
  });

  it('expiresAt이 지난 FILE도 기존 readContentFile처럼 capture한다', async () => {
    const { namespace, root, file } = await fixture();
    await dataSource.getRepository(VfsNodeEntity).update({ id: file.id }, { expiresAt: new Date(0) });
    const result = await repository.capture(
      namespace.id,
      root.id,
      { target: '/result.zip', entries: [{ id: file.id, name: 'source.txt' }] },
      limits,
    );
    expect(result.entries).toHaveLength(1);
  });

  it('요청 revision이 바뀌었으면 capture를 거부한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [
            {
              id: file.id,
              name: 'source.txt',
              revision: encodeRevision({ id: file.id, version: file.version + 1 }),
            },
          ],
        },
        limits,
      ),
    ).rejects.toMatchObject({
      archiveEntry: 0,
      status: 412,
      path: '/source.txt',
      current: { id: file.id, path: '/source.txt', revision: encodeRevision(file) },
    });
  });

  it('하위 디렉터리 원본의 revision 충돌은 조상을 거슬러 VFS 절대 경로를 돌려준다', async () => {
    const { namespace, root, blob } = await fixture();
    const nodes = dataSource.getRepository(VfsNodeEntity);
    const directory = await nodes.save(
      nodes.create({ namespaceId: namespace.id, parentId: root.id, type: 'DIRECTORY', name: 'docs' }),
    );
    const nested = await nodes.save(
      nodes.create({
        namespaceId: namespace.id,
        parentId: directory.id,
        type: 'FILE',
        name: 'nested.txt',
        blobId: blob.id,
        size: '7',
        mimeType: 'text/plain',
      }),
    );
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [
            {
              id: nested.id,
              name: 'renamed/in-zip.txt',
              revision: encodeRevision({ id: nested.id, version: nested.version + 1 }),
            },
          ],
        },
        limits,
      ),
    ).rejects.toMatchObject({
      archiveEntry: 0,
      status: 412,
      path: '/docs/nested.txt',
      current: { path: '/docs/nested.txt' },
    });
  });

  it('revision 형식 오류에 archive entry index를 붙인다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [{ id: file.id, name: 'source.txt', revision: 'bad' }],
        },
        limits,
      ),
    ).rejects.toMatchObject({ archiveEntry: 0, status: 400, code: 'VFS_INVALID_REVISION' });
  });

  it('같은 namespace의 DIRECTORY ID를 요청하면 400으로 거부한다', async () => {
    const { namespace, root } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [{ id: root.id, name: 'directory' }],
        },
        limits,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'VFS_INVALID_ARCHIVE_REQUEST' });
  });

  it('다른 namespace의 ID는 존재 여부를 숨기고 entry index만 담은 404로 거부한다', async () => {
    const first = await fixture('first');
    const second = await fixture('second');
    const rejection = repository.capture(
      first.namespace.id,
      first.root.id,
      {
        target: '/result.zip',
        entries: [
          { id: first.file.id, name: 'own.txt' },
          { id: second.file.id, name: 'foreign.txt' },
        ],
      },
      limits,
    );
    await expect(rejection).rejects.toBeInstanceOf(VfsArchiveSourceNotFoundError);
    await expect(rejection).rejects.toMatchObject({
      status: 404,
      code: 'VFS_NODE_NOT_FOUND',
      archiveEntry: 1,
    });
    await expect(rejection).rejects.not.toHaveProperty('path');
  });

  it('삭제 중인 namespace는 원본이 있어도 404로 거부한다', async () => {
    const { namespace, root, file } = await fixture();
    await dataSource.getRepository(NamespaceEntity).update({ id: namespace.id }, { status: 'DELETING' });
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        { target: '/result.zip', entries: [{ id: file.id, name: 'source.txt' }] },
        limits,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NAMESPACE_NOT_FOUND' });
  });

  it('원본 합계가 bigint 상한을 넘으면 capture를 거부한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [{ id: file.id, name: 'source.txt' }],
        },
        { ...limits, maxSourceBytes: 6n },
      ),
    ).rejects.toMatchObject({ status: 413, code: 'VFS_ARCHIVE_TOO_LARGE' });
  });

  it('entry 수 상한을 넘으면 원본을 조회하기 전에 거부한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/result.zip',
          entries: [
            { id: file.id, name: 'source.txt' },
            { id: file.id, name: 'copy.txt' },
          ],
        },
        { ...limits, maxEntries: 1 },
      ),
    ).rejects.toMatchObject({ status: 413, code: 'VFS_ARCHIVE_TOO_LARGE' });
  });

  it('target가 이미 있으면 current revision을 포함해 412로 거부한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        {
          target: '/source.txt',
          entries: [{ id: file.id, name: 'source.txt' }],
        },
        limits,
      ),
    ).rejects.toMatchObject({ status: 412, current: { id: file.id } });
  });

  it('target 부모와 원본이 모두 없으면 target 오류를 먼저 반환한다', async () => {
    const { namespace, root } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        { target: '/missing/result.zip', entries: [{ id: randomUUID(), name: 'source.txt' }] },
        limits,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/missing' });
  });

  it('target의 부모 조상이 없으면 해당 경로로 404를 반환한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        { target: '/missing/result.zip', entries: [{ id: file.id, name: 'source.txt' }] },
        limits,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/missing' });
  });

  it('target의 부모 조상이 FILE이면 409를 반환한다', async () => {
    const { namespace, root, file } = await fixture();
    await expect(
      repository.capture(
        namespace.id,
        root.id,
        { target: '/source.txt/result.zip', entries: [{ id: file.id, name: 'source.txt' }] },
        limits,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VFS_NOT_DIRECTORY' });
  });

  it('deadline 이후 최종 transaction 진입을 거부한다', async () => {
    await expect(
      dataSource.transaction((manager) => repository.assertDeadline(manager, new Date(0))),
    ).rejects.toMatchObject({ status: 503, code: 'VFS_ARCHIVE_TIMEOUT' });
    await expect(
      dataSource.transaction((manager) => repository.assertDeadline(manager, new Date(Date.now() + 60000))),
    ).resolves.toBeUndefined();
  });
});
