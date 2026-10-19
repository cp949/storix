// extract capture의 source·destination 조건, 오류 우선순위, DB wall-clock deadline, 읽기 전용 성질을 두 DB에서 공용으로 검증한다.
// PostgreSQL은 REPEATABLE READ snapshot, SQLite는 일반 읽기 transaction이다. 규칙은 docs/design/17-file-extract.md "실행".
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import type { ExtractSourceRepository } from '../../src/persistence/extract-source.repository.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';

/** 공용 시나리오가 필요로 하는 저장소와 연결이다. */
export interface ExtractSourceSharedContext {
  readonly dataSource: DataSource;
  readonly repository: ExtractSourceRepository;
  readonly nodeRepository: VfsNodeRepository;
}

export function runExtractSourceSharedTests(getContext: () => ExtractSourceSharedContext): void {
  /** 독립 namespace와 root를 만든다. */
  async function createNamespace() {
    const { dataSource } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `extract-source-${randomUUID()}`,
    );
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    return { namespaceId: namespace.id, root };
  }

  /** 경로의 DIRECTORY를 모두 만든다. */
  async function mkdir(namespaceId: string, rootId: string, segments: string[]) {
    return (await getContext().nodeRepository.ensureDirectory(namespaceId, rootId, segments, true)).node;
  }

  /** Blob을 참조하는 FILE을 만들고 카운터도 맞춘다. */
  async function seedFile(
    namespaceId: string,
    parentId: string,
    name: string,
    size = '3',
    sha = 'b'.repeat(64),
  ) {
    const { dataSource } = getContext();
    const blobRepo = dataSource.getRepository(BlobEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey: `blobs/${randomUUID()}`,
        size,
        mimeType: 'application/zip',
        sha256: sha,
        referenceCount: 1,
      }),
    );
    const node = await nodeRepo.save(
      nodeRepo.create({
        namespaceId,
        parentId,
        type: 'FILE',
        name,
        blobId: blob.id,
        size,
        mimeType: 'application/zip',
      }),
    );
    await nodeRepo.increment({ id: parentId }, 'childFileCount', 1);
    await dataSource.getRepository(NamespaceEntity).increment({ id: namespaceId }, 'liveNodeCount', 1);
    await dataSource
      .getRepository(NamespaceEntity)
      .increment({ id: namespaceId }, 'liveFileByteCount', Number(size));
    return { node: await nodeRepo.findOneByOrFail({ id: node.id }), blob };
  }

  /** capture가 바꾸면 안 되는 상태를 읽는다. */
  async function stateOf(namespaceId: string) {
    const { dataSource } = getContext();
    const nodes = await dataSource
      .getRepository(VfsNodeEntity)
      .find({ where: { namespaceId }, order: { id: 'ASC' } });
    const blobs = await dataSource
      .getRepository(BlobEntity)
      .find({ where: { namespaceId }, order: { id: 'ASC' } });
    return {
      nodes: nodes.map(({ id, version, parentId, name }) => ({ id, version, parentId, name })),
      references: blobs.map(({ id, referenceCount }) => ({ id, referenceCount })),
      receipts: await dataSource.getRepository(VfsMutationReceiptEntity).countBy({ namespaceId }),
    };
  }

  it('source metadata와 DB 시각 기준 deadline을 capture한다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const staging = await mkdir(namespaceId, root.id, ['.staging', 'u']);
    const { node, blob } = await seedFile(namespaceId, staging.id, 'up.zip', '7', 'c'.repeat(64));
    const before = Date.now();
    const capture = await repository.capture(
      namespaceId,
      root.id,
      {
        sourceSegments: ['.staging', 'u', 'up.zip'],
        sourceRevision: encodeRevision(node),
        destinationSegments: ['site'],
      },
      30,
    );
    expect(capture.source).toEqual({
      nodeId: node.id,
      storageKey: blob.storageKey,
      size: 7n,
      sha256: 'c'.repeat(64),
      encryptionIv: null,
    });
    // DB와 API가 같은 호스트 시계를 쓰므로 30초 deadline이 몇 초 안의 오차로 계산된다.
    expect(capture.deadlineAt.getTime()).toBeGreaterThan(before + 25_000);
    expect(capture.deadlineAt.getTime()).toBeLessThan(Date.now() + 35_000);
  });

  it('source 부재·DIRECTORY·FILE 조상 아래는 source 경로의 404다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    await mkdir(namespaceId, root.id, ['dir']);
    const { node: plain } = await seedFile(namespaceId, root.id, 'plain.bin');
    const revision = encodeRevision(plain);
    const attempt = (sourceSegments: string[]) =>
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments, sourceRevision: revision, destinationSegments: ['site'] },
        30,
      );
    await expect(attempt(['missing.zip'])).rejects.toMatchObject({
      status: 404,
      code: 'VFS_NODE_NOT_FOUND',
      path: '/missing.zip',
    });
    await expect(attempt(['no', 'such', 'a.zip'])).rejects.toMatchObject({
      status: 404,
      path: '/no/such/a.zip',
    });
    await expect(attempt(['dir'])).rejects.toMatchObject({ status: 404, path: '/dir' });
    await expect(attempt(['plain.bin', 'inner'])).rejects.toMatchObject({
      status: 404,
      path: '/plain.bin/inner',
    });
  });

  it('휴지통으로 옮긴 source는 404다', async () => {
    const { repository, nodeRepository, dataSource } = getContext();
    const { namespaceId, root } = await createNamespace();
    await dataSource.getRepository(NamespaceEntity).update({ id: namespaceId }, { trashEnabled: true });
    const { node } = await seedFile(namespaceId, root.id, 'gone.zip', '0');
    const revision = encodeRevision(node);
    const trashId = await nodeRepository.removeNode(namespaceId, root.id, ['gone.zip'], false, 1000);
    expect(typeof trashId).toBe('string');
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments: ['gone.zip'], sourceRevision: revision, destinationSegments: ['site'] },
        30,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/gone.zip' });
  });

  it('source revision이 다르면 412와 현재 상태(current)를 담는다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node } = await seedFile(namespaceId, root.id, 'up.zip');
    const stale = encodeRevision({ id: node.id, version: node.version + 1 });
    const error = await repository
      .capture(
        namespaceId,
        root.id,
        { sourceSegments: ['up.zip'], sourceRevision: stale, destinationSegments: ['site'] },
        30,
      )
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toMatchObject({
      status: 412,
      code: 'VFS_PRECONDITION_FAILED',
      path: '/up.zip',
      current: { id: node.id, path: '/up.zip', type: 'FILE', revision: encodeRevision(node) },
    });
    const otherNode = encodeRevision({ id: randomUUID(), version: node.version });
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments: ['up.zip'], sourceRevision: otherNode, destinationSegments: ['site'] },
        30,
      ),
    ).rejects.toMatchObject({ status: 412 });
  });

  it('destination이 FILE이거나 조상이 FILE이면 409 VFS_NOT_DIRECTORY다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node: source } = await seedFile(namespaceId, root.id, 'up.zip');
    await seedFile(namespaceId, root.id, 'file.bin');
    const attempt = (destinationSegments: string[]) =>
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments: ['up.zip'], sourceRevision: encodeRevision(source), destinationSegments },
        30,
      );
    await expect(attempt(['file.bin'])).rejects.toMatchObject({
      status: 409,
      code: 'VFS_NOT_DIRECTORY',
      path: '/file.bin',
    });
    await expect(attempt(['file.bin', 'child'])).rejects.toMatchObject({
      status: 409,
      code: 'VFS_NOT_DIRECTORY',
      path: '/file.bin',
    });
    await expect(attempt(['file.bin', 'a', 'b'])).rejects.toMatchObject({
      status: 409,
      code: 'VFS_NOT_DIRECTORY',
      path: '/file.bin',
    });
  });

  it('destination 부모가 없으면 처음 없는 조상 경로의 404이고 대상 자체가 없는 것은 허용한다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node: source } = await seedFile(namespaceId, root.id, 'up.zip');
    await mkdir(namespaceId, root.id, ['exists']);
    const attempt = (destinationSegments: string[]) =>
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments: ['up.zip'], sourceRevision: encodeRevision(source), destinationSegments },
        30,
      );
    await expect(attempt(['a', 'b', 'c'])).rejects.toMatchObject({
      status: 404,
      code: 'VFS_NODE_NOT_FOUND',
      path: '/a',
    });
    await expect(attempt(['exists', 'b', 'c'])).rejects.toMatchObject({ status: 404, path: '/exists/b' });
    await expect(attempt(['exists', 'new'])).resolves.toBeDefined();
    await expect(attempt(['exists'])).resolves.toBeDefined();
  });

  it('destinationRevision은 대상이 없으면 404, 다르면 412 current, 같으면 통과하고 생략하면 조건이 없다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node: source } = await seedFile(namespaceId, root.id, 'up.zip');
    const site = await mkdir(namespaceId, root.id, ['site']);
    const base = { sourceSegments: ['up.zip'], sourceRevision: encodeRevision(source) };
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        { ...base, destinationSegments: ['site'], destinationRevision: encodeRevision(site) },
        30,
      ),
    ).resolves.toBeDefined();
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        {
          ...base,
          destinationSegments: ['site'],
          destinationRevision: encodeRevision({ id: site.id, version: site.version + 1 }),
        },
        30,
      ),
    ).rejects.toMatchObject({
      status: 412,
      code: 'VFS_PRECONDITION_FAILED',
      path: '/site',
      current: { id: site.id, path: '/site', type: 'DIRECTORY' },
    });
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        { ...base, destinationSegments: ['new'], destinationRevision: encodeRevision(site) },
        30,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'VFS_NODE_NOT_FOUND', path: '/new' });
    await expect(
      repository.capture(namespaceId, root.id, { ...base, destinationSegments: ['new'] }, 30),
    ).resolves.toBeDefined();
  });

  it('source 오류가 destination 오류보다 먼저 보고된다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node } = await seedFile(namespaceId, root.id, 'up.zip');
    await seedFile(namespaceId, root.id, 'file.bin');
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        {
          sourceSegments: ['absent.zip'],
          sourceRevision: encodeRevision(node),
          destinationSegments: ['file.bin'],
        },
        30,
      ),
    ).rejects.toMatchObject({ status: 404, path: '/absent.zip' });
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        {
          sourceSegments: ['up.zip'],
          sourceRevision: encodeRevision({ id: node.id, version: node.version + 1 }),
          destinationSegments: ['file.bin'],
        },
        30,
      ),
    ).rejects.toMatchObject({ status: 412, path: '/up.zip' });
  });

  it('source가 destination 아래여도 capture가 성공하고 node·참조 수·receipt를 바꾸지 않는다', async () => {
    const { repository } = getContext();
    const { namespaceId, root } = await createNamespace();
    const site = await mkdir(namespaceId, root.id, ['site', 'in']);
    const { node } = await seedFile(namespaceId, site.id, 'up.zip');
    const before = await stateOf(namespaceId);
    const capture = await repository.capture(
      namespaceId,
      root.id,
      {
        sourceSegments: ['site', 'in', 'up.zip'],
        sourceRevision: encodeRevision(node),
        destinationSegments: ['site'],
      },
      30,
    );
    expect(capture.source.nodeId).toBe(node.id);
    expect(await stateOf(namespaceId)).toEqual(before);
  });

  it('비활성 namespace는 NAMESPACE_NOT_FOUND다', async () => {
    const { repository, dataSource } = getContext();
    const { namespaceId, root } = await createNamespace();
    const { node } = await seedFile(namespaceId, root.id, 'up.zip');
    await dataSource.getRepository(NamespaceEntity).update({ id: namespaceId }, { status: 'DELETING' });
    await expect(
      repository.capture(
        namespaceId,
        root.id,
        { sourceSegments: ['up.zip'], sourceRevision: encodeRevision(node), destinationSegments: ['site'] },
        30,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NAMESPACE_NOT_FOUND' });
  });

  it('assertDeadline은 DB 시계로 미래는 허용하고 과거는 VFS_EXTRACT_TIMEOUT 503으로 거부한다', async () => {
    const { repository, dataSource } = getContext();
    await dataSource.transaction(async (manager) => {
      await expect(
        repository.assertDeadline(manager, new Date(Date.now() + 60_000)),
      ).resolves.toBeUndefined();
      await expect(repository.assertDeadline(manager, new Date(Date.now() - 60_000))).rejects.toMatchObject({
        status: 503,
        code: 'VFS_EXTRACT_TIMEOUT',
      });
    });
  });
}
