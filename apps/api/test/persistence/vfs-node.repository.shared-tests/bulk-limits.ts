import { randomUUID } from 'node:crypto';
import { NamespaceEntity } from '../../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../../src/persistence/entities/vfs-node.entity.js';
import { VfsRevisionExhaustedError } from '../../../src/vfs/vfs.errors.js';
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
// 노드마다 노드·부모 체인을 개별 조회하던 시기에는 평평한 12,000개 cp가 쿼리 36,043개,
// 깊이 1,500 체인 mv·cp가 쿼리 약 113만 개(깊이의 제곱에 비례)였다. 배치 조회는 노드 수를 250으로 나눈 만큼만 쓴다.
// 배치 조회 뒤 실측은 평평한 12,000개 cp가 114개, 깊이 1,500 체인 mv가 25개·cp가 30개다.
const FLAT_COPY_MAX_QUERIES = 300;
// PostgreSQL 평평한 12,000개 cp는 쿼리 수를 줄인 뒤에도 통계가 없는 새 DB에서 약 6.6초(3회 6.60~6.64초)다.
// 청크 INSERT와 `id AND namespace_id` 조회의 쿼리 계획 선택이 원인으로 추정한다(GitHub 이슈 #35).
// 상한은 이 실측의 약 1.5배이고, 노드마다 개별 조회하던 시기의 최소 실측(18.1초)보다 낮다.
const FLAT_COPY_MAX_MS_POSTGRES = 10_000;
const CHAIN_MAX_QUERIES = 100;
// 한 줄로 이어진 디렉터리 체인의 깊이. 경로 상한(4096 byte)에서 허용되는 최악(약 2,000)에 가깝다.
const CHAIN_DEPTH = 1_500;

export function runBulkLimitsTests(helpers: VfsNodeRepositoryTestHelpers): void {
  const { getDs, getRepo, createNamespace, countQueries } = helpers;

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

  /** 이름이 `n`인 DIRECTORY가 depth개 한 줄로 이어진 체인을 만들고 최상위 노드를 root 바로 아래에 둔다. */
  async function directoryChain(name: string, depth: number) {
    const namespace = await createNamespace(name);
    const root = (await getRepo().getRoot(namespace.id))!;
    const repo = getDs().getRepository(VfsNodeEntity);
    let parentId = root.id;
    for (let offset = 0; offset < depth; offset += 500) {
      const rows = Array.from({ length: Math.min(500, depth - offset) }, () => {
        const row = repo.create({
          id: randomUUID(),
          namespaceId: namespace.id,
          parentId,
          type: 'DIRECTORY',
          name: 'n',
        });
        parentId = row.id;
        return row;
      });
      await repo.insert(rows);
    }
    await getDs().getRepository(NamespaceEntity).increment({ id: namespace.id }, 'liveNodeCount', depth);
    return { namespace, root };
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
      const { queryCount } = await countQueries(() =>
        getRepo().copyNode(namespace.id, root.id, ['big'], ['copy'], false, FLAT_NODE_COUNT + 10),
      );
      const elapsedMs = performance.now() - startedAt;

      const copy = await getRepo().resolvePath(namespace.id, root.id, ['copy']);
      expect(
        await getDs().getRepository(VfsNodeEntity).countBy({ namespaceId: namespace.id, parentId: copy!.id }),
      ).toBe(FLAT_NODE_COUNT);
      expect(queryCount).toBeLessThan(FLAT_COPY_MAX_QUERIES);
      expect(elapsedMs).toBeLessThan(
        getDs().options.type === 'better-sqlite3' ? FLAT_OPERATION_MAX_MS : FLAT_COPY_MAX_MS_POSTGRES,
      );
    }, 60_000);
  });

  describe('깊은 디렉터리 체인의 mv·cp 처리 시간', () => {
    it.each([
      [
        'mv',
        (namespaceId: string, rootId: string) =>
          getRepo().moveNode(namespaceId, rootId, ['n'], ['moved'], false, CHAIN_DEPTH + 10),
      ],
      [
        'cp',
        (namespaceId: string, rootId: string) =>
          getRepo().copyNode(namespaceId, rootId, ['n'], ['copied'], false, CHAIN_DEPTH + 10),
      ],
    ])(
      '%s 쿼리 수가 깊이에 이차로 늘지 않는다',
      async (title, operate) => {
        const { namespace, root } = await directoryChain(`deep-chain-${title}-ns`, CHAIN_DEPTH);

        const startedAt = performance.now();
        const { queryCount } = await countQueries(() => operate(namespace.id, root.id));
        const elapsedMs = performance.now() - startedAt;

        expect(queryCount).toBeLessThan(CHAIN_MAX_QUERIES);
        expect(elapsedMs).toBeLessThan(FLAT_OPERATION_MAX_MS);
      },
      120_000,
    );
  });

  describe('청크 경계를 넘는 mv의 revision 증가', () => {
    // version 증가 UPDATE 청크(500)를 두 개 이상 만드는 규모다.
    const MOVE_NODE_COUNT = 600;

    it('모든 자손의 version이 정확히 1씩 오른다', async () => {
      const { namespace, root } = await bigDirectory('bulk-move-revision-ns', MOVE_NODE_COUNT);
      const repository = getDs().getRepository(VfsNodeEntity);

      await getRepo().moveNode(namespace.id, root.id, ['big'], ['moved'], false, MOVE_NODE_COUNT + 10);

      const nodes = await repository.findBy({ namespaceId: namespace.id, type: 'DIRECTORY' });
      const children = nodes.filter((node) => node.name.startsWith('d'));
      expect(children).toHaveLength(MOVE_NODE_COUNT);
      expect(children.every((node) => node.version === 2)).toBe(true);
    });

    it('자손 하나가 version 상한에 닿으면 이동 전체가 롤백된다', async () => {
      const { namespace, root } = await bigDirectory('bulk-move-ceiling-ns', MOVE_NODE_COUNT);
      const repository = getDs().getRepository(VfsNodeEntity);
      const children = (await repository.findBy({ namespaceId: namespace.id, type: 'DIRECTORY' })).filter(
        (node) => node.name.startsWith('d'),
      );
      await repository.update(children[children.length - 1].id, { version: 2147483647 });

      await expect(
        getRepo().moveNode(namespace.id, root.id, ['big'], ['moved'], false, MOVE_NODE_COUNT + 10),
      ).rejects.toThrow(VfsRevisionExhaustedError);

      expect(await getRepo().resolvePath(namespace.id, root.id, ['big'])).not.toBeNull();
      expect(await getRepo().resolvePath(namespace.id, root.id, ['moved'])).toBeNull();
      const after = (await repository.findBy({ namespaceId: namespace.id, type: 'DIRECTORY' })).filter(
        (node) => node.name.startsWith('d') && node.id !== children[children.length - 1].id,
      );
      expect(after.every((node) => node.version === 1)).toBe(true);
    });
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
