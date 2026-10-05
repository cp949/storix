import { randomUUID } from 'node:crypto';
import { NamespaceEntity } from '../../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import type { VfsNodeRepositoryTestHelpers } from '../vfs-node.repository.shared-test-context.js';

// 노드 1행의 바인드 변수는 9개다. SQLite 상한(32766)과 PostgreSQL 상한(65535)을 모두 넘는 규모다.
const COPY_NODE_COUNT = 8_000;
// 삭제 청크(500)를 여러 개 만들고 부모·자식이 청크 경계에 걸치는 중첩 트리로 삭제 순서를 확인한다.
const DELETE_BRANCH_COUNT = 600;
// 평평한 디렉터리의 대량 rm·cp 시간 검사 규모. SQLite 재귀 CTE가 O(N²)이던 시기에는
// 12,000개 rm이 약 5.5초, cp가 약 6.7초였고, 선형일 때는 rm 0.1~0.5초, cp 1.5초 안쪽이다.
// 상한은 선형 실측(cp 최대)과 비선형 실측(rm 최소) 사이에 둔다.
const FLAT_NODE_COUNT = 12_000;
const FLAT_OPERATION_MAX_MS = 3_500;

export function runBulkLimitsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace } = helpers;

  /** 부모 아래에 빈 디렉터리 노드를 직접 만든다. repository 경로로는 수만 개를 만들기 어렵다. */
  async function insertDirectories(namespaceId: string, parentId: string, count: number) {
    const repo = getDs().getRepository(VfsNodeEntity);
    for (let offset = 0; offset < count; offset += 500) {
      const rows = Array.from({ length: Math.min(500, count - offset) }, (_, index) =>
        repo.create({
          id: randomUUID(),
          namespaceId,
          parentId,
          type: 'DIRECTORY',
          name: `d${offset + index}`,
        }),
      );
      await repo.insert(rows);
    }
    await getDs().getRepository(NamespaceEntity).increment({ id: namespaceId }, 'liveNodeCount', count);
  }

  async function bigDirectory(name: string, count: number) {
    const namespace = await createNamespace(name);
    const root = (await getRepo().getRoot(namespace.id))!;
    const dir = await getRepo().ensureDirectory(namespace.id, root.id, ['big'], false);
    await insertDirectories(namespace.id, dir.node.id, count);
    return { namespace, root };
  }

  describe('평평한 디렉터리의 대량 노드 처리 시간', () => {
    it.each([
      ['휴지통 비활성', false],
      ['휴지통 활성', true],
    ])(
      '노드 수에 비선형으로 느려지지 않고 재귀 rm이 끝난다 (%s)',
      async (_title, trashEnabled) => {
        const { namespace, root } = await bigDirectory(`flat-rm-${trashEnabled}-ns`, FLAT_NODE_COUNT);
        await getDs().getRepository(NamespaceEntity).update(namespace.id, { trashEnabled });

        const startedAt = performance.now();
        await getRepo().removeNode(namespace.id, root.id, ['big'], true, FLAT_NODE_COUNT + 10);
        const elapsedMs = performance.now() - startedAt;

        expect(await getRepo().resolvePath(namespace.id, root.id, ['big'])).toBeNull();
        expect(elapsedMs).toBeLessThan(FLAT_OPERATION_MAX_MS);
      },
      30_000,
    );

    it('노드 수에 비선형으로 느려지지 않고 재귀 cp가 끝난다', async () => {
      const { namespace, root } = await bigDirectory('flat-cp-ns', FLAT_NODE_COUNT);

      const startedAt = performance.now();
      await getRepo().copyNode(namespace.id, root.id, ['big'], ['copy'], false, FLAT_NODE_COUNT + 10);
      const elapsedMs = performance.now() - startedAt;

      const copy = await getRepo().resolvePath(namespace.id, root.id, ['copy']);
      expect(
        await getDs().getRepository(VfsNodeEntity).countBy({ namespaceId: namespace.id, parentId: copy!.id }),
      ).toBe(FLAT_NODE_COUNT);
      // PostgreSQL의 12,000개 cp는 재귀 CTE가 아닌 다른 단계 때문에 약 20초가 걸려(CTE 수정 전후 동일)
      // 시간 상한을 둘 수 없다. 재귀 CTE 회귀는 SQLite에서만 시간으로 잡는다.
      if (getDs().options.type === 'better-sqlite3') expect(elapsedMs).toBeLessThan(FLAT_OPERATION_MAX_MS);
    }, 60_000);
  });

  describe('DB 바인드 변수 상한을 넘는 대량 노드', () => {
    it('SQLite·PostgreSQL 상한을 넘는 노드 수의 디렉터리 cp가 성공한다', async () => {
      const { namespace, root } = await bigDirectory('bulk-copy-ns', COPY_NODE_COUNT);

      await getRepo().copyNode(namespace.id, root.id, ['big'], ['copy'], false, COPY_NODE_COUNT + 10);

      const copy = await getRepo().resolvePath(namespace.id, root.id, ['copy']);
      expect(
        await getDs().getRepository(VfsNodeEntity).countBy({ namespaceId: namespace.id, parentId: copy!.id }),
      ).toBe(COPY_NODE_COUNT);
    });

    it.each([
      ['휴지통 비활성', false],
      ['휴지통 활성', true],
    ])(
      '삭제 청크 경계에 부모와 자식이 걸쳐도 중첩 트리 rm이 FK 위반 없이 성공한다 (%s)',
      async (_title, trashEnabled) => {
        const { namespace, root } = await bigDirectory(`bulk-rm-${trashEnabled}-ns`, DELETE_BRANCH_COUNT);
        const repository = getDs().getRepository(VfsNodeEntity);
        const branches = await repository.findBy({ namespaceId: namespace.id, type: 'DIRECTORY' });
        for (const branch of branches.filter((node) => node.name.startsWith('d'))) {
          await repository.insert(
            repository.create({
              id: randomUUID(),
              namespaceId: namespace.id,
              parentId: branch.id,
              type: 'DIRECTORY',
              name: 'leaf',
            }),
          );
        }
        await getDs()
          .getRepository(NamespaceEntity)
          .increment({ id: namespace.id }, 'liveNodeCount', DELETE_BRANCH_COUNT);
        await getDs().getRepository(NamespaceEntity).update(namespace.id, { trashEnabled });

        await getRepo().removeNode(namespace.id, root.id, ['big'], true, 2 * DELETE_BRANCH_COUNT + 10);

        expect(await getRepo().resolvePath(namespace.id, root.id, ['big'])).toBeNull();
        expect(await repository.countBy({ namespaceId: namespace.id })).toBe(1);
      },
    );
  });
}
