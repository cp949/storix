import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { encodeCursor } from '../common/keyset-cursor.js';
import {
  NamespaceResourceLimits,
  VfsNodeMatch,
  VfsNodeRecord,
  VfsNodeRepository,
} from '../persistence/vfs-node.repository.js';
import { PathResolver } from './path-resolver.js';
import {
  VfsAlreadyExistsError,
  VfsInvalidCursorError,
  VfsInvalidOperationError,
  VfsNamespaceNotFoundError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
} from './vfs.errors.js';
import { VfsService } from './vfs.service.js';

const NAMESPACE_ID = '11111111-1111-1111-1111-111111111111';

function makeNode(overrides: Partial<VfsNodeRecord> = {}): VfsNodeRecord {
  return {
    id: 'node-1',
    name: 'a',
    type: 'DIRECTORY',
    blobId: null,
    size: null,
    mimeType: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<VfsNodeMatch> = {}): VfsNodeMatch {
  return { ...makeNode(), relativeSegments: ['a'], ...overrides };
}

describe('VfsService', () => {
  let repo: {
    getRoot: jest.Mock<() => Promise<VfsNodeRecord | null>>;
    getRootWithLimits: jest.Mock<() => Promise<{ root: VfsNodeRecord; limits: NamespaceResourceLimits } | null>>;
    resolvePath: jest.Mock<() => Promise<VfsNodeRecord | null>>;
    listChildren: jest.Mock<() => Promise<VfsNodeRecord[]>>;
    findRecursive: jest.Mock<() => Promise<VfsNodeMatch[]>>;
    ensureDirectory: jest.Mock<() => Promise<{ node: VfsNodeRecord; created: boolean }>>;
    moveNode: jest.Mock<() => Promise<{ node: VfsNodeRecord; finalPath: string }>>;
    copyNode: jest.Mock<() => Promise<{ node: VfsNodeRecord; finalPath: string }>>;
    removeEmptyDirectory: jest.Mock<() => Promise<void>>;
    removeNode: jest.Mock<() => Promise<void>>;
  };
  let config: { getOrThrow: jest.Mock<() => string> };
  let service: VfsService;

  function createService(): VfsService {
    return new VfsService(new PathResolver(), repo as unknown as VfsNodeRepository, config as unknown as ConfigService);
  }

  beforeEach(() => {
    repo = {
      getRoot: jest.fn(),
      getRootWithLimits: jest.fn(),
      resolvePath: jest.fn(),
      listChildren: jest.fn(),
      findRecursive: jest.fn(),
      ensureDirectory: jest.fn(),
      moveNode: jest.fn(),
      copyNode: jest.fn(),
      removeEmptyDirectory: jest.fn(),
      removeNode: jest.fn(),
    };
    config = { getOrThrow: jest.fn<() => string>().mockReturnValue('1000') };
    service = createService();
  });

  describe('namespace 검증', () => {
    it('UUID 형식이 아닌 namespaceId는 repository 조회 없이 거부한다', async () => {
      await expect(service.stat('not-a-uuid', '/a')).rejects.toThrow(VfsNamespaceNotFoundError);
      expect(repo.getRoot).not.toHaveBeenCalled();
    });

    it('존재하지 않는 namespace는 VfsNamespaceNotFoundError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(null);

      await expect(service.stat(NAMESPACE_ID, '/a')).rejects.toThrow(VfsNamespaceNotFoundError);
    });
  });

  describe('mkdir', () => {
    it('root 경로(/)는 VfsAlreadyExistsError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));

      await expect(service.mkdir(NAMESPACE_ID, '/', false)).rejects.toThrow(VfsAlreadyExistsError);
      expect(repo.ensureDirectory).not.toHaveBeenCalled();
    });

    it('새 디렉터리를 생성하면 201과 canonical path를 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.ensureDirectory.mockResolvedValue({ node: makeNode({ id: 'n2', name: 'b' }), created: true });

      const result = await service.mkdir(NAMESPACE_ID, '/a/b', true);

      expect(repo.ensureDirectory).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a', 'b'], true);
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ path: '/a/b', name: 'b' });
    });

    it('parents=true로 이미 존재하는 디렉터리를 만들면 200을 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.ensureDirectory.mockResolvedValue({ node: makeNode({ id: 'n2', name: 'b' }), created: false });

      const result = await service.mkdir(NAMESPACE_ID, '/a/b', true);

      expect(result.status).toBe(200);
    });
  });

  describe('ls', () => {
    it('대상 경로가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(null);

      await expect(service.ls(NAMESPACE_ID, '/missing', undefined, undefined)).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });

    it('대상이 FILE이면 VfsNotDirectoryError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(makeNode({ id: 'f1', name: 'a', type: 'FILE' }));

      await expect(service.ls(NAMESPACE_ID, '/a', undefined, undefined)).rejects.toThrow(
        VfsNotDirectoryError,
      );
    });

    it('cursor가 잘못된 형식이면 VfsInvalidCursorError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));

      await expect(service.ls(NAMESPACE_ID, '/', 'not-a-cursor!!', undefined)).rejects.toThrow(
        VfsInvalidCursorError,
      );
    });

    it('root를 나열하면 이름 기반 canonical path를 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.listChildren.mockResolvedValue([
        makeNode({ id: 'c1', name: 'a' }),
        makeNode({ id: 'c2', name: 'b' }),
      ]);

      const result = await service.ls(NAMESPACE_ID, '/', undefined, undefined);

      expect(repo.listChildren).toHaveBeenCalledWith(NAMESPACE_ID, 'root', null, 100);
      expect(result.items.map((i) => i.path)).toEqual(['/a', '/b']);
      expect(result.nextCursor).toBeNull();
    });

    it('limit보다 많은 결과가 오면 nextCursor를 채워서 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.listChildren.mockResolvedValue([
        makeNode({ id: 'c1', name: 'a' }),
        makeNode({ id: 'c2', name: 'b' }),
      ]);

      const result = await service.ls(NAMESPACE_ID, '/', undefined, '1');

      expect(repo.listChildren).toHaveBeenCalledWith(NAMESPACE_ID, 'root', null, 1);
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBe(encodeCursor({ name: 'a', id: 'c1' }));
    });
  });

  describe('stat', () => {
    it('존재하는 경로를 응답 DTO로 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(makeNode({ id: 'n1', name: 'a', type: 'DIRECTORY' }));

      const result = await service.stat(NAMESPACE_ID, '/a');

      expect(result).toMatchObject({ path: '/a', name: 'a', type: 'DIRECTORY' });
    });
  });

  describe('exists', () => {
    it('경로가 없으면 exists:false를 반환하고 예외를 던지지 않는다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(null);

      const result = await service.exists(NAMESPACE_ID, '/missing');

      expect(result).toEqual({ exists: false });
    });

    it('경로가 있으면 exists:true를 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(makeNode({ id: 'n1', name: 'a' }));

      const result = await service.exists(NAMESPACE_ID, '/a');

      expect(result).toEqual({ exists: true });
    });
  });

  describe('find', () => {
    it('시작 경로가 없으면 VfsNodeNotFoundError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(null);

      await expect(service.find(NAMESPACE_ID, '/missing', {})).rejects.toThrow(VfsNodeNotFoundError);
    });

    it('시작 경로가 FILE이면 VfsNotDirectoryError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.resolvePath.mockResolvedValue(makeNode({ id: 'f1', name: 'a', type: 'FILE' }));

      await expect(service.find(NAMESPACE_ID, '/a', {})).rejects.toThrow(VfsNotDirectoryError);
    });

    it('name/match/type 옵션을 필터로 변환해 repository에 전달한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.findRecursive.mockResolvedValue([]);

      await service.find(NAMESPACE_ID, '/', { name: 'report', match: 'contains', type: 'FILE' });

      expect(repo.findRecursive).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        { name: { mode: 'contains', value: 'report' }, type: 'FILE' },
        null,
        100,
      );
    });

    it('알 수 없는 match 값은 exact로 대체한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.findRecursive.mockResolvedValue([]);

      await service.find(NAMESPACE_ID, '/', { name: 'report', match: 'weird' });

      expect(repo.findRecursive).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        { name: { mode: 'exact', value: 'report' } },
        null,
        100,
      );
    });

    it('결과의 path는 시작 경로에 relativeSegments를 이어붙인 값이다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.findRecursive.mockResolvedValue([
        makeMatch({ id: 'n1', name: 'report.pdf', type: 'FILE', relativeSegments: ['a', 'report.pdf'] }),
      ]);

      const result = await service.find(NAMESPACE_ID, '/', {});

      expect(result.items[0].path).toBe('/a/report.pdf');
    });
  });

  describe('move', () => {
    it('source가 root(/)이면 VfsInvalidOperationError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));

      await expect(service.move(NAMESPACE_ID, '/', '/x', false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
      expect(repo.moveNode).not.toHaveBeenCalled();
    });

    it('repository에 source/destination segments와 destinationParents를 그대로 전달한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.moveNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      await service.move(NAMESPACE_ID, '/a', '/dest', true);

      expect(repo.moveNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], ['dest'], true);
    });

    it('이동에 성공하면 200과 repository가 반환한 최종 경로를 반환한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.moveNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      const result = await service.move(NAMESPACE_ID, '/a', '/dest', false);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ path: '/dest/b', name: 'b' });
    });
  });

  describe('copy', () => {
    it('source가 root(/)이면 VfsInvalidOperationError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: null },
      });

      await expect(service.copy(NAMESPACE_ID, '/', '/x', false)).rejects.toThrow(
        VfsInvalidOperationError,
      );
      expect(repo.copyNode).not.toHaveBeenCalled();
    });

    it('repository에 source/destination segments, destinationParents, MAX_SYNC_COPY_NODES를 그대로 전달한다', async () => {
      config.getOrThrow.mockReturnValue('7');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: null },
      });
      repo.copyNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      await service.copy(NAMESPACE_ID, '/a', '/dest', true);

      expect(repo.copyNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], ['dest'], true, 7);
    });

    it('복사에 성공하면 201과 repository가 반환한 최종 경로를 반환한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: null },
      });
      repo.copyNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      const result = await service.copy(NAMESPACE_ID, '/a', '/dest', false);

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ path: '/dest/b', name: 'b' });
    });

    it('namespace의 maxSyncCopyNodes가 전역보다 작으면 그 값을 repository에 전달한다', async () => {
      config.getOrThrow.mockReturnValue('1000');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: 3 },
      });
      repo.copyNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      await service.copy(NAMESPACE_ID, '/a', '/dest', false);

      expect(repo.copyNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], ['dest'], false, 3);
    });

    it('namespace의 maxSyncCopyNodes가 전역보다 크면 전역값을 상한으로 전달한다', async () => {
      config.getOrThrow.mockReturnValue('5');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: 999 },
      });
      repo.copyNode.mockResolvedValue({ node: makeNode({ name: 'b' }), finalPath: '/dest/b' });

      await service.copy(NAMESPACE_ID, '/a', '/dest', false);

      expect(repo.copyNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], ['dest'], false, 5);
    });
  });

  describe('rmdir', () => {
    it('root 경로(/)는 VfsInvalidOperationError를 던진다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));

      await expect(service.rmdir(NAMESPACE_ID, '/')).rejects.toThrow(VfsInvalidOperationError);
      expect(repo.removeEmptyDirectory).not.toHaveBeenCalled();
    });

    it('repository.removeEmptyDirectory에 위임한다', async () => {
      repo.getRoot.mockResolvedValue(makeNode({ id: 'root', name: '' }));
      repo.removeEmptyDirectory.mockResolvedValue(undefined);

      await service.rmdir(NAMESPACE_ID, '/a');

      expect(repo.removeEmptyDirectory).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a']);
    });
  });

  describe('rm', () => {
    it('root 경로(/)는 VfsInvalidOperationError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: null },
      });

      await expect(service.rm(NAMESPACE_ID, '/', true)).rejects.toThrow(VfsInvalidOperationError);
      expect(repo.removeNode).not.toHaveBeenCalled();
    });

    it('recursive 값과 설정된 MAX_SYNC_DELETE_NODES를 repository에 전달한다', async () => {
      config.getOrThrow.mockReturnValue('42');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: null, maxSyncCopyNodes: null },
      });
      repo.removeNode.mockResolvedValue(undefined);

      await service.rm(NAMESPACE_ID, '/a', true);

      expect(repo.removeNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], true, 42);
    });

    it('namespace의 maxSyncDeleteNodes가 전역보다 작으면 그 값을 repository에 전달한다', async () => {
      config.getOrThrow.mockReturnValue('1000');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: 3, maxSyncCopyNodes: null },
      });
      repo.removeNode.mockResolvedValue(undefined);

      await service.rm(NAMESPACE_ID, '/a', true);

      expect(repo.removeNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], true, 3);
    });

    it('namespace의 maxSyncDeleteNodes가 전역보다 크면 전역값을 상한으로 전달한다', async () => {
      config.getOrThrow.mockReturnValue('5');
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeNode({ id: 'root', name: '' }),
        limits: { maxFileSizeBytes: null, maxSyncDeleteNodes: 999, maxSyncCopyNodes: null },
      });
      repo.removeNode.mockResolvedValue(undefined);

      await service.rm(NAMESPACE_ID, '/a', true);

      expect(repo.removeNode).toHaveBeenCalledWith(NAMESPACE_ID, 'root', ['a'], true, 5);
    });
  });
});
