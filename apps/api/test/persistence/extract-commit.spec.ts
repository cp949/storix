// applyExtract가 destination을 다루는 순서와 status(200·201)·재검사 오류를 DB 없이 단위 테스트한다.
// 내부 잠금·삭제·생성 helper를 기록용으로 대체한 서브클래스를 쓰며, entry 반영과 카운터는
// extract-commit.shared-tests.ts가 두 DB에서 검증한다. 규칙은 docs/design/17-file-extract.md "실행".
import { ConfigService } from '@nestjs/config';
import type { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsNodeRepositoryExtract } from '../../src/persistence/vfs-node.repository.extract.js';
import type { MutationTx, VfsNodeRecord } from '../../src/persistence/vfs-node.repository.types.js';
import { encodeRevision } from '../../src/vfs/revision.js';

const DEST_ID = '00000000-0000-4000-8000-0000000000d1';
const NEW_DEST_ID = '00000000-0000-4000-8000-0000000000d2';

function directory(version = 1): VfsNodeEntity {
  return {
    id: DEST_ID,
    namespaceId: 'ns',
    parentId: 'parent',
    name: 'site',
    type: 'DIRECTORY',
    blobId: null,
    size: null,
    mimeType: null,
    version,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: null,
    childFileCount: 0,
  } as unknown as VfsNodeEntity;
}

/** 내부 helper 호출을 기록하고 준비한 destination을 돌려주는 대역이다. */
class Probe extends VfsNodeRepositoryExtract {
  readonly calls: string[] = [];
  removeArgs: unknown[] = [];
  destination: VfsNodeEntity | null = null;
  trashId: string | null = 'trash-1';

  constructor() {
    super({} as never, {} as never, {} as never, {} as never, {} as never, new ConfigService());
  }

  protected override async lockParentChain(): Promise<string> {
    this.calls.push('lockParentChain');
    return 'parent';
  }

  protected override async lockTargetNode(): Promise<VfsNodeEntity | null> {
    this.calls.push('lockTargetNode');
    return this.destination;
  }

  protected override async markAncestorChain(_tx: MutationTx, id: string): Promise<void> {
    this.calls.push(`markAncestorChain:${id}`);
  }

  override async removeNode(...args: unknown[]): Promise<string | null> {
    this.calls.push('removeNode');
    this.removeArgs = args;
    return this.trashId;
  }

  override async ensureDirectory(): Promise<{ node: VfsNodeRecord; created: boolean }> {
    this.calls.push('ensureDirectory');
    return { node: { id: NEW_DEST_ID } as VfsNodeRecord, created: true };
  }
}

const tx = {
  manager: { getRepository: () => ({}) },
  namespaceId: 'ns',
  rootId: 'root',
  changed: new Map(),
  feedBefore: null,
} as unknown as MutationTx;

const plan = (overrides: Record<string, unknown> = {}) => ({
  destinationSegments: ['site'],
  mode: 'overwrite' as const,
  entries: [],
  maxSyncDeleteNodes: 77,
  ...overrides,
});

describe('applyExtract destination 처리', () => {
  it('대상이 없으면 201이고 ensureDirectory로 만든다', async () => {
    const probe = new Probe();
    const result = await probe.applyExtract(tx, plan());
    expect(result).toEqual({ status: 201, destinationId: NEW_DEST_ID, createdCount: 0, replacedCount: 0 });
    expect(probe.calls).toContain('ensureDirectory');
    expect(probe.calls).not.toContain('removeNode');
  });

  it('overwrite로 기존 대상을 쓰면 200이고 새로 만들거나 지우지 않는다', async () => {
    const probe = new Probe();
    probe.destination = directory();
    const result = await probe.applyExtract(tx, plan());
    expect(result).toMatchObject({ status: 200, destinationId: DEST_ID });
    expect(probe.calls).toContain(`markAncestorChain:${DEST_ID}`);
    expect(probe.calls).not.toContain('ensureDirectory');
    expect(probe.calls).not.toContain('removeNode');
  });

  it('clean은 기존 대상을 재귀 삭제한 뒤 다시 만들고 새 id여도 200이며 trashId를 담는다', async () => {
    const probe = new Probe();
    probe.destination = directory();
    const result = await probe.applyExtract(tx, plan({ mode: 'clean' }));
    expect(result).toEqual({
      status: 200,
      destinationId: NEW_DEST_ID,
      createdCount: 0,
      replacedCount: 0,
      trashId: 'trash-1',
    });
    expect(probe.calls.indexOf('removeNode')).toBeLessThan(probe.calls.indexOf('ensureDirectory'));
    expect(probe.removeArgs.slice(0, 5)).toEqual(['ns', 'root', ['site'], true, 77]);
  });

  it('clean에서 휴지통이 꺼져 있으면 trashId가 없다', async () => {
    const probe = new Probe();
    probe.destination = directory();
    probe.trashId = null;
    const result = await probe.applyExtract(tx, plan({ mode: 'clean' }));
    expect(result).not.toHaveProperty('trashId');
    expect(result.status).toBe(200);
  });

  it('clean이어도 대상이 없으면 삭제하지 않고 201이다', async () => {
    const probe = new Probe();
    const result = await probe.applyExtract(tx, plan({ mode: 'clean' }));
    expect(result.status).toBe(201);
    expect(probe.calls).not.toContain('removeNode');
  });

  it('대상이 FILE이면 409 VFS_NOT_DIRECTORY다', async () => {
    const probe = new Probe();
    probe.destination = { ...directory(), type: 'FILE' } as VfsNodeEntity;
    await expect(probe.applyExtract(tx, plan())).rejects.toMatchObject({
      status: 409,
      code: 'VFS_NOT_DIRECTORY',
      path: '/site',
    });
  });

  it('destinationRevision은 대상이 없으면 404, 다르면 412 current, 같으면 통과한다', async () => {
    const probe = new Probe();
    const revision = encodeRevision({ id: DEST_ID, version: 1 });
    await expect(probe.applyExtract(tx, plan({ destinationRevision: revision }))).rejects.toMatchObject({
      status: 404,
      code: 'VFS_NODE_NOT_FOUND',
      path: '/site',
    });
    probe.destination = directory(2);
    await expect(probe.applyExtract(tx, plan({ destinationRevision: revision }))).rejects.toMatchObject({
      status: 412,
      code: 'VFS_PRECONDITION_FAILED',
      path: '/site',
      current: { id: DEST_ID, revision: encodeRevision({ id: DEST_ID, version: 2 }) },
    });
    probe.destination = directory(1);
    await expect(probe.applyExtract(tx, plan({ destinationRevision: revision }))).resolves.toMatchObject({
      status: 200,
    });
  });

  it('revision을 생략하면 현재 대상에 mode를 적용한다', async () => {
    const probe = new Probe();
    probe.destination = directory(9);
    await expect(probe.applyExtract(tx, plan())).resolves.toMatchObject({
      status: 200,
      destinationId: DEST_ID,
    });
  });

  it('잘못된 destination·entry 경로는 잠금 전에 VFS_INVALID_PATH로 거부한다', async () => {
    const probe = new Probe();
    await expect(probe.applyExtract(tx, plan({ destinationSegments: ['..'] }))).rejects.toMatchObject({
      code: 'VFS_INVALID_PATH',
    });
    await expect(
      probe.applyExtract(
        tx,
        plan({ entries: [{ entryIndex: 0, name: 'a', segments: ['a', '..'], type: 'FILE', blob: null }] }),
      ),
    ).rejects.toMatchObject({ code: 'VFS_INVALID_PATH' });
    expect(probe.calls).toEqual([]);
  });
});
