// mock manager로 extract capture의 오류 우선순위와 DB wall-clock deadline SQL을 단위 테스트한다.
// source 조건(404·412)이 destination 조건(404·409·412)보다 먼저 판정되는 순서와 Blob 불일치의 서버 오류 분류를 고정한다.
// 실제 DB 동작은 extract-source.repository.shared-tests.ts가 두 DB에서 검증한다.
import { jest } from '@jest/globals';
import type { DataSource, EntityManager } from 'typeorm';
import { ArchiveSourceRepository } from '../../src/persistence/archive-source.repository.js';
import { isDbDeadlinePassed } from '../../src/persistence/db-deadline.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ExtractSourceRepository } from '../../src/persistence/extract-source.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';

const NS = '11111111-1111-4111-8111-111111111111';
const ROOT = '00000000-0000-4000-8000-000000000001';
const DB_NOW = new Date('2026-10-19T00:00:00.000Z');

interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  type: 'FILE' | 'DIRECTORY';
  version?: number;
  blobId?: string | null;
  size?: string | null;
}

let idCounter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

/** 이름 경로로 트리를 만든다. 'a/b.zip'은 DIRECTORY a와 FILE b.zip이다. */
function tree(spec: Record<string, 'FILE' | 'DIRECTORY'>): FakeNode[] {
  const nodes: FakeNode[] = [{ id: ROOT, parentId: null, name: '', type: 'DIRECTORY' }];
  for (const [path, type] of Object.entries(spec)) {
    const segments = path.split('/');
    let parent = ROOT;
    segments.forEach((name, index) => {
      let node = nodes.find((n) => n.parentId === parent && n.name === name);
      if (!node) {
        const last = index === segments.length - 1;
        node = {
          id: nextId(),
          parentId: parent,
          name,
          type: last ? type : 'DIRECTORY',
          blobId: last && type === 'FILE' ? `blob-${name}` : null,
          size: last && type === 'FILE' ? '3' : null,
        };
        nodes.push(node);
      }
      parent = node.id;
    });
  }
  return nodes;
}

function entityOf(node: FakeNode) {
  return {
    ...node,
    namespaceId: NS,
    mimeType: null,
    version: node.version ?? 1,
    createdAt: DB_NOW,
    updatedAt: DB_NOW,
    expiresAt: null,
  };
}

/** 트랜잭션 콜백에 mock manager를 넘기는 DataSource와 호출 기록을 만든다. */
function harness(
  nodes: FakeNode[],
  options: { sqlite?: boolean; blobMissing?: boolean; namespaceStatus?: string } = {},
) {
  const queries: { sql: string; parameters?: unknown[] }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, parameters?: unknown[]) => {
      queries.push({ sql, parameters });
      if (/now/i.test(sql) && !/>=/.test(sql))
        return [{ now: options.sqlite ? '2026-10-19 00:00:00.000' : DB_NOW }];
      return [{ expired: false }];
    }),
    getRepository: (entity: unknown) => {
      if (entity === NamespaceEntity)
        return { findOneBy: async () => ({ id: NS, status: options.namespaceStatus ?? 'ACTIVE' }) };
      if (entity === VfsNodeEntity)
        return {
          findOneBy: async (where: { id?: string; parentId?: string | null; name?: string }) => {
            const found = nodes.find((node) =>
              where.id !== undefined
                ? node.id === where.id
                : where.parentId === null
                  ? node.parentId === null
                  : node.parentId === where.parentId && node.name === where.name,
            );
            return found ? entityOf(found) : null;
          },
        };
      if (entity === BlobEntity)
        return {
          findOneBy: async ({ id }: { id: string }) =>
            options.blobMissing
              ? null
              : { id, storageKey: `blobs/${id}`, sha256: 'a'.repeat(64), encryptionIv: null },
        };
      throw new Error('unexpected repository');
    },
  } as unknown as EntityManager;
  const dataSource = {
    options: { type: options.sqlite ? 'better-sqlite3' : 'postgres' },
    transaction: async (...args: unknown[]) =>
      (args[args.length - 1] as (m: EntityManager) => Promise<unknown>)(manager),
  } as unknown as DataSource;
  return { repository: new ExtractSourceRepository(dataSource), manager, queries, dataSource };
}

const SRC_REVISION = (nodes: FakeNode[], name: string) =>
  encodeRevision(entityOf(nodes.find((n) => n.name === name)!));

describe('ExtractSourceRepository.capture 오류 우선순위', () => {
  const command = (
    nodes: FakeNode[],
    overrides: Partial<Parameters<ExtractSourceRepository['capture']>[2]> = {},
  ) => ({
    sourceSegments: ['.staging', 'up.zip'],
    sourceRevision: SRC_REVISION(nodes, 'up.zip'),
    destinationSegments: ['site'],
    ...overrides,
  });

  it('정상 입력은 source metadata와 DB 시각 기준 deadline을 돌려준다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE' });
    const { repository } = harness(nodes);
    const result = await repository.capture(NS, ROOT, command(nodes), 30);
    expect(result.deadlineAt).toEqual(new Date(DB_NOW.getTime() + 30000));
    expect(result.source).toMatchObject({
      storageKey: expect.stringContaining('blobs/'),
      size: 3n,
      sha256: 'a'.repeat(64),
      encryptionIv: null,
    });
  });

  it('SQLite는 문자열 시각을 UTC로 읽어 같은 deadline을 만든다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE' });
    const { repository, queries } = harness(nodes, { sqlite: true });
    const result = await repository.capture(NS, ROOT, command(nodes), 30);
    expect(result.deadlineAt).toEqual(new Date(DB_NOW.getTime() + 30000));
    expect(queries[0].sql).toContain("strftime('%Y-%m-%d %H:%M:%f', 'now')");
  });

  it('source가 없으면 destination 상태와 무관하게 source 404를 먼저 낸다', async () => {
    const nodes = tree({ '.staging': 'DIRECTORY', f: 'FILE' });
    const { repository } = harness(nodes);
    await expect(
      repository.capture(
        NS,
        ROOT,
        {
          sourceSegments: ['.staging', 'up.zip'],
          sourceRevision: encodeRevision(entityOf(nodes[1])),
          destinationSegments: ['f', 'x'],
        },
        30,
      ),
    ).rejects.toMatchObject({ code: 'VFS_NODE_NOT_FOUND', status: 404, path: '/.staging/up.zip' });
  });

  it('source가 DIRECTORY이거나 FILE 조상 아래면 404다', async () => {
    const nodes = tree({ dir: 'DIRECTORY', f: 'FILE' });
    const { repository } = harness(nodes);
    const dir = nodes.find((n) => n.name === 'dir')!;
    await expect(
      repository.capture(
        NS,
        ROOT,
        {
          sourceSegments: ['dir'],
          sourceRevision: encodeRevision(entityOf(dir)),
          destinationSegments: ['site'],
        },
        30,
      ),
    ).rejects.toMatchObject({ code: 'VFS_NODE_NOT_FOUND', path: '/dir' });
    await expect(
      repository.capture(
        NS,
        ROOT,
        {
          sourceSegments: ['f', 'x'],
          sourceRevision: encodeRevision(entityOf(dir)),
          destinationSegments: ['site'],
        },
        30,
      ),
    ).rejects.toMatchObject({ code: 'VFS_NODE_NOT_FOUND', path: '/f/x' });
  });

  it('source revision 불일치 412는 destination 오류보다 먼저다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE', f: 'FILE' });
    const { repository } = harness(nodes);
    const stale = encodeRevision({ id: nodes.find((n) => n.name === 'up.zip')!.id, version: 9 });
    await expect(
      repository.capture(
        NS,
        ROOT,
        { ...command(nodes), sourceRevision: stale, destinationSegments: ['f'] },
        30,
      ),
    ).rejects.toMatchObject({
      code: 'VFS_PRECONDITION_FAILED',
      status: 412,
      path: '/.staging/up.zip',
      current: { path: '/.staging/up.zip', revision: expect.stringMatching(/^r1\./) },
    });
  });

  it('destination이 FILE이거나 조상이 FILE이면 409, 부모가 없으면 첫 부재 조상의 404다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE', f: 'FILE' });
    const { repository } = harness(nodes);
    await expect(
      repository.capture(NS, ROOT, command(nodes, { destinationSegments: ['f'] }), 30),
    ).rejects.toMatchObject({
      code: 'VFS_NOT_DIRECTORY',
      status: 409,
      path: '/f',
    });
    await expect(
      repository.capture(NS, ROOT, command(nodes, { destinationSegments: ['f', 'x', 'y'] }), 30),
    ).rejects.toMatchObject({
      code: 'VFS_NOT_DIRECTORY',
      path: '/f',
    });
    await expect(
      repository.capture(NS, ROOT, command(nodes, { destinationSegments: ['a', 'b', 'c'] }), 30),
    ).rejects.toMatchObject({
      code: 'VFS_NODE_NOT_FOUND',
      status: 404,
      path: '/a',
    });
  });

  it('destinationRevision은 대상이 없으면 404, 다르면 412, 같으면 통과하고 생략하면 조건이 없다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE', site: 'DIRECTORY' });
    const { repository } = harness(nodes);
    const site = nodes.find((n) => n.name === 'site')!;
    const current = encodeRevision(entityOf(site));
    await expect(
      repository.capture(NS, ROOT, command(nodes, { destinationRevision: current }), 30),
    ).resolves.toBeDefined();
    await expect(
      repository.capture(
        NS,
        ROOT,
        command(nodes, { destinationRevision: encodeRevision({ id: site.id, version: 5 }) }),
        30,
      ),
    ).rejects.toMatchObject({ code: 'VFS_PRECONDITION_FAILED', path: '/site', current: { path: '/site' } });
    await expect(
      repository.capture(
        NS,
        ROOT,
        command(nodes, { destinationSegments: ['new'], destinationRevision: current }),
        30,
      ),
    ).rejects.toMatchObject({ code: 'VFS_NODE_NOT_FOUND', path: '/new' });
    await expect(
      repository.capture(NS, ROOT, command(nodes, { destinationSegments: ['new'] }), 30),
    ).resolves.toBeDefined();
  });

  it('source가 destination 아래에 있어도 capture는 성공한다', async () => {
    const nodes = tree({ 'site/up.zip': 'FILE' });
    const { repository } = harness(nodes);
    await expect(
      repository.capture(
        NS,
        ROOT,
        {
          sourceSegments: ['site', 'up.zip'],
          sourceRevision: SRC_REVISION(nodes, 'up.zip'),
          destinationSegments: ['site'],
        },
        30,
      ),
    ).resolves.toMatchObject({ source: { size: 3n } });
  });

  it('비활성 namespace는 NAMESPACE_NOT_FOUND다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE' });
    const { repository } = harness(nodes, { namespaceStatus: 'DELETING' });
    await expect(repository.capture(NS, ROOT, command(nodes), 30)).rejects.toMatchObject({
      code: 'NAMESPACE_NOT_FOUND',
    });
  });

  it('Blob이 없으면 서버 오류로 던지고 도메인 오류로 숨기지 않는다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE' });
    const { repository } = harness(nodes, { blobMissing: true });
    const error = await repository.capture(NS, ROOT, command(nodes), 30).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBeUndefined();
    expect((error as Error).message).toContain('데이터 일관성 위반');
  });

  it('size가 없는 FILE node는 서버 오류다', async () => {
    const nodes = tree({ '.staging/up.zip': 'FILE' });
    nodes.find((n) => n.name === 'up.zip')!.size = null;
    const { repository } = harness(nodes);
    await expect(repository.capture(NS, ROOT, command(nodes), 30)).rejects.toThrow('데이터 일관성 위반');
  });
});

describe('DB wall-clock deadline', () => {
  it('PostgreSQL은 clock_timestamp와 timestamptz 바인드로 비교한다', async () => {
    const { manager, queries } = harness([]);
    (manager.query as jest.Mock).mockImplementationOnce(async (sql: unknown, parameters: unknown) => {
      queries.push({ sql: sql as string, parameters: parameters as unknown[] });
      return [{ expired: true }];
    });
    await expect(isDbDeadlinePassed(manager, false, new Date('2026-10-19T00:00:00.000Z'))).resolves.toBe(
      true,
    );
    expect(queries.at(-1)).toEqual({
      sql: 'SELECT clock_timestamp() >= $1::timestamptz AS expired',
      parameters: ['2026-10-19T00:00:00.000Z'],
    });
  });

  it('SQLite는 julianday 비교의 숫자 결과를 불리언으로 읽는다', async () => {
    const { manager, queries } = harness([], { sqlite: true });
    (manager.query as jest.Mock).mockImplementationOnce(async (sql: unknown, parameters: unknown) => {
      queries.push({ sql: sql as string, parameters: parameters as unknown[] });
      return [{ expired: 1 }];
    });
    await expect(isDbDeadlinePassed(manager, true, new Date('2026-10-19T00:00:00.000Z'))).resolves.toBe(true);
    expect(queries.at(-1)?.sql).toBe("SELECT julianday('now') >= julianday(?) AS expired");
    await expect(isDbDeadlinePassed(manager, true, new Date())).resolves.toBe(false);
  });

  it('extract는 VFS_EXTRACT_TIMEOUT, archive는 기존 VFS_ARCHIVE_TIMEOUT 오류를 유지한다', async () => {
    const expired = async () => [{ expired: true }];
    const { manager: extractManager, repository } = harness([]);
    (extractManager.query as jest.Mock).mockImplementation(expired);
    await expect(repository.assertDeadline(extractManager, new Date())).rejects.toMatchObject({
      status: 503,
      code: 'VFS_EXTRACT_TIMEOUT',
    });
    const archive = new ArchiveSourceRepository({ options: { type: 'postgres' } } as unknown as DataSource);
    await expect(archive.assertDeadline(extractManager, new Date())).rejects.toMatchObject({
      status: 503,
      code: 'VFS_ARCHIVE_TIMEOUT',
    });
  });

  it('만료되지 않았으면 조용히 끝난다', async () => {
    const { manager, repository } = harness([]);
    await expect(repository.assertDeadline(manager, new Date())).resolves.toBeUndefined();
  });
});
