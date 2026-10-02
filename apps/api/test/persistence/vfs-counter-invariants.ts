import type { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';

/**
 * 저장된 counter가 실제 행에서 다시 계산한 값과 같은지 확인한다.
 *
 * - `vfs_node.child_file_count`는 그 DIRECTORY의 직접 자식 FILE 수와 같아야 한다.
 * - `namespace.live_node_count`는 root를 제외한 live FILE·DIRECTORY 수와 같아야 한다.
 * - snapshot·trash manifest entry는 `vfs_node` 행이 아니므로 재계산 대상에 들어가지 않는다.
 */
export async function expectCountersMatchRows(dataSource: DataSource, namespaceId: string): Promise<void> {
  const namespace = await dataSource.getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId });
  const nodes = await dataSource.getRepository(VfsNodeEntity).findBy({ namespaceId });

  const fileCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === 'FILE' && node.parentId) {
      fileCounts.set(node.parentId, (fileCounts.get(node.parentId) ?? 0) + 1);
    }
  }
  const actualFolders = nodes
    .filter((node) => node.type === 'DIRECTORY')
    .map((node) => ({ name: node.name, parentId: node.parentId, count: fileCounts.get(node.id) ?? 0 }));
  const storedFolders = nodes
    .filter((node) => node.type === 'DIRECTORY')
    .map((node) => ({
      name: node.name,
      parentId: node.parentId,
      count: Number(String(node.childFileCount)),
    }));
  expect(storedFolders).toEqual(actualFolders);

  const liveNodes = nodes.filter((node) => node.parentId !== null).length;
  expect(String(namespace.liveNodeCount)).toBe(String(liveNodes));
}
