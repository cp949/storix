import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { CreateUploadSessionInput } from '../../src/persistence/vfs-upload-session.repository.js';
import type { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import type { VfsUploadSessionState } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import type { UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';
import { PathResolver } from '../../src/vfs/path-resolver.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { UploadSessionService } from '../../src/vfs/upload-session.service.js';
import { VfsNodeNotFoundError, VfsNotDirectoryError } from '../../src/vfs/vfs.errors.js';

describe('UploadSessionService lifecycle', () => {
  const namespaceId = randomUUID();
  const key = randomUUID();
  const request = {
    path: '/parent/file.bin',
    sizeBytes: '0',
    mimeType: 'application/octet-stream',
    ifAbsent: true,
  };
  const policy: UploadSessionPolicy = {
    global: {
      maxStagedBytes: 1000n,
      maxActiveSessions: 2,
      partSizeBytes: 4,
      inactivitySeconds: 60,
      maxLifetimeSeconds: 120,
    },
    namespaces: { [namespaceId]: { maxStagedBytes: 1000n, maxActiveSessions: 1 } },
  };

  function setup(activePolicy: UploadSessionPolicy = policy, maxFileSizeBytes = '8') {
    let expiryMax = '2592000';
    let createSessionCalls = 0;
    const sessions = new Map<string, VfsUploadSessionEntity>();
    const repo = {
      createSession: async (input: CreateUploadSessionInput) => {
        createSessionCalls++;
        const existing = [...sessions.values()].find(
          (row) => row.creationKey === input.creationKey && row.scope === input.scope,
        );
        if (existing)
          return existing.fingerprint === input.fingerprint
            ? { kind: 'replay', session: existing }
            : { kind: 'conflict' };
        if (sessions.size >= 1) return { kind: 'limit' };
        const session: VfsUploadSessionEntity = {
          ...input,
          sha256: input.sha256 ?? null,
          state: 'OPEN',
          requestId: input.requestId ?? null,
          creationRequestId: input.requestId ?? null,
          leaseExpiresAt: null,
          leaseToken: null,
          terminalAt: null,
          responseStatus: null,
          responseBody: null,
          lastCompleteFailureCode: null,
          lastCompleteFailureAt: null,
          createdAt: input.now,
          updatedAt: input.now,
          creationExpiresAt: input.expiresAt,
          fileExpiresInSeconds: input.fileExpiresInSeconds,
        };
        sessions.set(input.id, session);
        return { kind: 'created', session };
      },
      findByCreationKey: async (_ns: string, scope: string, creationKey: string) =>
        [...sessions.values()].find((row) => row.scope === scope && row.creationKey === creationKey) ?? null,
      findForStatus: async (_ns: string, id: string) => {
        const session = sessions.get(id);
        return session
          ? {
              session,
              parts: [
                {
                  partIndex: 0,
                  sizeBytes: '4',
                  digest: 'secret',
                  stagingKey: 'upload-staging/private',
                  state: 'STORED',
                },
              ],
            }
          : null;
      },
      findStatusSnapshot: async (_ns: string, id: string) => {
        const session = sessions.get(id);
        return session
          ? {
              session,
              parts: [
                {
                  partIndex: 0,
                  sizeBytes: '4',
                  digest: 'secret',
                  stagingKey: 'upload-staging/private',
                  state: 'STORED',
                  leaseExpiresAt: null,
                },
              ],
            }
          : null;
      },
      claimTerminalTransition: async (_ns: string, id: string, next: VfsUploadSessionState) => {
        const session = sessions.get(id);
        if (!session || session.state !== 'OPEN') return false;
        session.state = next;
        return true;
      },
    };
    let enabled = true;
    let parentExists = true;
    // 경로('a/b') → 노드. 기본 트리는 /parent 디렉터리 하나다.
    const tree = new Map<
      string,
      { id: string; type: 'FILE' | 'DIRECTORY'; version: number } & Record<string, unknown>
    >();
    const nodeAt = (segments: string[]) => {
      const joined = segments.join('/');
      if (joined === 'parent') return parentExists ? { id: 'parent', type: 'DIRECTORY', version: 1 } : null;
      return tree.get(joined) ?? null;
    };
    const nodes = {
      getRoot: async () => ({ id: 'root' }),
      getRootWithLimits: async () => ({ root: { id: 'root' }, limits: { maxFileSizeBytes } }),
      resolvePath: async (_ns: string, _root: string, segments: string[]) => {
        for (let i = 1; i < segments.length; i++)
          if (nodeAt(segments.slice(0, i))?.type !== 'DIRECTORY') return null;
        return nodeAt(segments);
      },
      // VfsNodeRepository.assertParentChain과 같은 규칙: 처음 없는 경로는 404, FILE 조상은 409다.
      assertParentChain: async (_ns: string, _root: string, segments: string[]) => {
        for (let i = 1; i < segments.length; i++) {
          const node = nodeAt(segments.slice(0, i));
          const path = `/${segments.slice(0, i).join('/')}`;
          if (!node) throw new VfsNodeNotFoundError(path);
          if (node.type !== 'DIRECTORY') throw new VfsNotDirectoryError(path);
        }
      },
    };
    const capability = {
      requireEnabled: () => {
        if (!enabled) throw Object.assign(new Error('disabled'), { code: 'VFS_FEATURE_DISABLED' });
      },
    };
    const service = new UploadSessionService(
      new PathResolver(),
      nodes as unknown as VfsNodeRepository,
      repo as unknown as VfsUploadSessionRepository,
      capability as unknown as CapabilityService,
      activePolicy,
      {
        get: (name: string) =>
          name === 'STORIX_MAX_FILE_SIZE_BYTES'
            ? maxFileSizeBytes
            : name === 'STORIX_VFS_EXPIRY_MAX_SECONDS'
              ? expiryMax
              : undefined,
      } as unknown as ConfigService,
    );
    return {
      service,
      sessions,
      getCreateSessionCalls: () => createSessionCalls,
      setEnabled: (value: boolean) => {
        enabled = value;
      },
      setExpiryMax: (value: string) => {
        expiryMax = value;
        (service as unknown as { expiryBounds: { maxSeconds: number } }).expiryBounds.maxSeconds =
          Number(value);
      },
      setParentExists: (value: boolean) => {
        parentExists = value;
      },
      tree,
    };
  }

  describe('생성 시 조건 판정은 완료(putConditionalContent)와 같은 순서·오류를 따른다', () => {
    // 412 응답의 current 표현(toPreconditionCurrent)에 필요한 노드 필드
    const nodeFields = {
      name: 'dir',
      size: null,
      mimeType: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      expiresAt: null,
    };
    const create = (service: UploadSessionService, body: Record<string, unknown>) =>
      service.create(
        namespaceId,
        'scope',
        randomUUID(),
        { sizeBytes: '0', mimeType: 'text/plain', ...body },
        'r',
      );

    it('중간 경로가 FILE이면 409 VFS_NOT_DIRECTORY다', async () => {
      const { service, tree } = setup();
      tree.set('parent/f', { id: randomUUID(), type: 'FILE', version: 1 });
      await expect(create(service, { path: '/parent/f/x.bin', ifAbsent: true })).rejects.toMatchObject({
        code: 'VFS_NOT_DIRECTORY',
        status: 409,
      });
    });

    it('중간 경로가 없으면 처음 없는 경로로 404 VFS_NODE_NOT_FOUND다', async () => {
      const { service } = setup();
      await expect(create(service, { path: '/parent/a/b/x.bin', ifAbsent: true })).rejects.toMatchObject({
        code: 'VFS_NODE_NOT_FOUND',
        path: '/parent/a',
      });
    });

    it('DIRECTORY 대상의 revision이 다르면 409가 아니라 412 VFS_PRECONDITION_FAILED다', async () => {
      const { service, tree } = setup();
      tree.set('parent/dir', { ...nodeFields, id: randomUUID(), type: 'DIRECTORY', version: 1 });
      const stale = encodeRevision({ id: randomUUID(), version: 1 });
      await expect(create(service, { path: '/parent/dir', ifRevision: stale })).rejects.toMatchObject({
        code: 'VFS_PRECONDITION_FAILED',
        status: 412,
      });
    });

    it('DIRECTORY 대상의 revision이 같으면 409 VFS_IS_DIRECTORY다', async () => {
      const { service, tree } = setup();
      const dir = { id: randomUUID(), type: 'DIRECTORY' as const, version: 1 };
      tree.set('parent/dir', dir);
      await expect(
        create(service, { path: '/parent/dir', ifRevision: encodeRevision(dir) }),
      ).rejects.toMatchObject({ code: 'VFS_IS_DIRECTORY', status: 409 });
    });
  });

  it('namespace 항목이 없는 정책은 전역 한도를 적용해 세션을 만든다', async () => {
    const { service } = setup({ global: policy.global, namespaces: {} });
    const created = await service.create(namespaceId, 'scope', key, request, 'req-1');
    expect(created.status).toBe(201);
  });

  // 가짜 저장소로 검사 순서·재생 우선·거절 시 저장소 미호출을 고정한다.
  describe('세션 생성 staging 파일 크기 admission', () => {
    /** 파일 상한과 독립적으로 전역·namespace staging 한도를 설정한다. */
    const withStagingCap = (globalCap: bigint, namespaceCap = globalCap): UploadSessionPolicy => ({
      global: { ...policy.global, maxStagedBytes: globalCap, partSizeBytes: 4, maxActiveSessions: 5 },
      namespaces: {
        [namespaceId]: { maxStagedBytes: namespaceCap, maxActiveSessions: 5 },
      },
    });

    it('기존 파일 상한 검사 뒤 staging 초과를 거절하고 저장소를 호출하지 않는다', async () => {
      const { service, sessions, getCreateSessionCalls } = setup(withStagingCap(8n), '16');
      await expect(
        service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE', status: 413 });
      expect(sessions.size).toBe(0);
      expect(getCreateSessionCalls()).toBe(0);
    });

    it('파일 상한 오류가 staging 오류보다 먼저 발생한다', async () => {
      const { service } = setup(withStagingCap(6n), '8');
      await expect(
        service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_FILE_TOO_LARGE', status: 413 });
      await expect(
        service.create(namespaceId, 'scope', randomUUID(), { ...request, sizeBytes: '7' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE', status: 413 });
    });

    it('거절된 key는 정책 상향 뒤 같은 요청으로 새 세션을 만든다', async () => {
      const { service, sessions } = setup(withStagingCap(8n), '16');
      await expect(
        service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE' });
      (service as unknown as { policy: UploadSessionPolicy }).policy = withStagingCap(10n);
      expect(
        (await service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'r')).status,
      ).toBe(201);
      expect(sessions.size).toBe(1);
    });

    it('정책 하향 뒤 동일 요청 재생은 새 한도 검사보다 먼저 처리한다', async () => {
      const { service } = setup(withStagingCap(8n), '16');
      const original = await service.create(
        namespaceId,
        'scope',
        key,
        { ...request, sizeBytes: '8' },
        'first',
      );
      (service as unknown as { policy: UploadSessionPolicy }).policy = withStagingCap(6n);
      const replay = await service.create(
        namespaceId,
        'scope',
        key,
        { ...request, sizeBytes: '8' },
        'second',
      );
      expect(replay.body).toEqual(original.body);
      await expect(
        service.create(namespaceId, 'scope', randomUUID(), { ...request, sizeBytes: '8' }, 'third'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE' });
    });

    it('크기 초과는 경로 오류보다 먼저 처리하고 한도 이내는 기존 경로 오류를 유지한다', async () => {
      const { service, setParentExists } = setup(withStagingCap(8n), '16');
      setParentExists(false);
      await expect(
        service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE', status: 413 });
      await expect(
        service.create(namespaceId, 'scope', randomUUID(), { ...request, sizeBytes: '8' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_NODE_NOT_FOUND', status: 404 });
    });

    it('크기 초과는 기존 대상 조건·디렉터리 오류보다 먼저 처리한다', async () => {
      const { service, tree } = setup(withStagingCap(8n), '16');
      const dir = {
        id: randomUUID(),
        name: 'dir',
        type: 'DIRECTORY' as const,
        size: null,
        mimeType: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        expiresAt: null,
        version: 1,
      };
      tree.set('parent/dir', dir);
      await expect(
        service.create(namespaceId, 'scope', key, { ...request, path: '/parent/dir', sizeBytes: '9' }, 'r'),
      ).rejects.toMatchObject({ code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE', status: 413 });
      await expect(
        service.create(
          namespaceId,
          'scope',
          randomUUID(),
          { ...request, path: '/parent/dir', sizeBytes: '8' },
          'r',
        ),
      ).rejects.toMatchObject({ code: 'VFS_PRECONDITION_FAILED', status: 412 });
    });
  });

  describe('namespace별 조각 크기', () => {
    const withPartSize = (partSizeBytes?: number): UploadSessionPolicy => ({
      global: { ...policy.global, partSizeBytes: 3, maxActiveSessions: 5 },
      namespaces: {
        [namespaceId]: {
          maxStagedBytes: 1000n,
          maxActiveSessions: 5,
          ...(partSizeBytes === undefined ? {} : { partSizeBytes }),
        },
      },
    });
    const created = async (service: UploadSessionService, sizeBytes: string, creationKey = key) =>
      (await service.create(namespaceId, 'scope', creationKey, { ...request, sizeBytes }, 'req')).body as {
        sessionId: string;
        partSizeBytes: number;
        partCount: number;
      };

    it('namespace 조각 크기로 partCount를 계산해 세션에 저장한다', async () => {
      const { service, sessions } = setup(withPartSize(6));
      const body = await created(service, '8');
      expect(body).toMatchObject({ partSizeBytes: 6, partCount: 2 });
      expect(sessions.get(body.sessionId)).toMatchObject({ partSizeBytes: 6, partCount: 2 });
    });

    it('namespace 값이 없으면 전역 조각 크기를 쓴다', async () => {
      const { service } = setup(withPartSize());
      expect(await created(service, '8')).toMatchObject({ partSizeBytes: 3, partCount: 3 });
    });

    it('0바이트 파일은 조각 0개다', async () => {
      const { service } = setup(withPartSize(6));
      expect(await created(service, '0')).toMatchObject({ partSizeBytes: 6, partCount: 0 });
    });

    it('정책이 바뀐 뒤 같은 creationKey 재생은 저장된 세션의 조각 크기를 돌려준다', async () => {
      const { service } = setup(withPartSize(6));
      await created(service, '8');
      (service as unknown as { policy: UploadSessionPolicy }).policy = withPartSize(2);
      expect(await created(service, '8')).toMatchObject({ partSizeBytes: 6, partCount: 2 });
    });
  });

  it('replays the same creation and rejects a changed body for the same key', async () => {
    const { service } = setup();
    const first = await service.create(namespaceId, 'scope', key, request, 'first-request');
    const replay = await service.create(namespaceId, 'scope', key, request, 'second-request');
    expect(replay.body).toEqual(first.body);
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, mimeType: 'text/plain' }, 'third'),
    ).rejects.toMatchObject({ code: 'MUTATION_KEY_REUSED', status: 409 });
    await service.cancel(namespaceId, (first.body as { sessionId: string }).sessionId);
    expect((await service.create(namespaceId, 'scope', key, request, 'fourth')).body).toEqual(first.body);
  });

  it('validates optional checksum before creating a session and binds it to the creation key', async () => {
    const { service, sessions } = setup();
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, sha256: 'A'.repeat(64) }, 'bad'),
    ).rejects.toMatchObject({
      code: 'VFS_INVALID_CHECKSUM',
      status: 400,
    });
    expect(sessions.size).toBe(0);
    const checksum = 'a'.repeat(64);
    const created = await service.create(
      namespaceId,
      'scope',
      key,
      { ...request, sha256: checksum },
      'created',
    );
    expect(
      (sessions.get((created.body as { sessionId: string }).sessionId) as unknown as { sha256?: string })
        ?.sha256,
    ).toBe(checksum);
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, sha256: 'b'.repeat(64) }, 'changed'),
    ).rejects.toMatchObject({
      code: 'MUTATION_KEY_REUSED',
      status: 409,
    });
    await expect(service.create(namespaceId, 'scope', key, request, 'removed')).rejects.toMatchObject({
      code: 'MUTATION_KEY_REUSED',
      status: 409,
    });
  });

  it('ifAbsent와 expiresInSeconds를 세션에 고정하고 상태와 fingerprint에 포함한다', async () => {
    const { service, sessions } = setup();
    const first = await service.create(
      namespaceId,
      'scope',
      key,
      { ...request, expiresInSeconds: 600 },
      'req-1',
    );
    expect(first.status).toBe(201);
    const stored = [...sessions.values()][0];
    expect(stored.fileExpiresInSeconds).toBe(600);
    expect((await service.status(namespaceId, stored.id)).condition).toEqual({
      ifAbsent: true,
      expiresInSeconds: 600,
    });
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, expiresInSeconds: 601 }, 'req-2'),
    ).rejects.toMatchObject({ code: 'MUTATION_KEY_REUSED' });
  });

  it('현재 MAX가 낮아져도 같은 creation key와 fingerprint면 만료 입력을 replay한다', async () => {
    const { service, sessions, setExpiryMax } = setup();
    const requestWithExpiry = { ...request, expiresInSeconds: 7200 };
    const first = await service.create(namespaceId, 'scope', key, requestWithExpiry, 'req-1');
    setExpiryMax('600');

    const replay = await service.create(namespaceId, 'scope', key, requestWithExpiry, 'req-2');

    expect(replay.body).toEqual(first.body);
    expect(sessions.size).toBe(1);
    await expect(
      service.create(namespaceId, 'scope', randomUUID(), requestWithExpiry, 'req-3'),
    ).rejects.toMatchObject({ code: 'VFS_INVALID_EXPIRY', status: 400 });
  });

  it.each([
    [
      {
        ifAbsent: undefined,
        ifRevision: encodeRevision({ id: randomUUID(), version: 1 }),
        expiresInSeconds: 600,
      },
    ],
    [{ expiresInSeconds: 59 }],
    [{ expiresInSeconds: '600' }],
    [{ expiresInSeconds: 600.5 }],
  ])('잘못된 만료 입력 %j는 세션을 만들지 않고 400 VFS_INVALID_EXPIRY다', async (patch) => {
    const { service, sessions } = setup();
    const body: Record<string, unknown> = { ...request, ...patch };
    if (body.ifAbsent === undefined) delete body.ifAbsent;
    await expect(service.create(namespaceId, 'scope', randomUUID(), body, 'req-1')).rejects.toMatchObject({
      code: 'VFS_INVALID_EXPIRY',
      status: 400,
    });
    expect(sessions.size).toBe(0);
  });

  it('keeps the creation request ID when completion stores its own request ID', async () => {
    const { service, sessions } = setup();
    const first = await service.create(namespaceId, 'scope', key, request, 'creation-request');
    const id = (first.body as { sessionId: string }).sessionId;
    const session = sessions.get(id);
    if (!session) throw new Error('session missing');
    session.state = 'COMPLETED';
    session.requestId = 'completion-request';
    const replay = await service.create(namespaceId, 'scope', key, request, 'creation-retry');
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-request-id']).toBe('creation-request');
  });

  it('uses the retry request ID when a legacy completed row has no creation request ID', async () => {
    const { service, sessions } = setup();
    const first = await service.create(namespaceId, 'scope', key, request, 'creation-request');
    const session = sessions.get((first.body as { sessionId: string }).sessionId);
    if (!session) throw new Error('session missing');
    session.creationRequestId = null;
    session.state = 'COMPLETED';
    session.requestId = 'completion-request';
    const replay = await service.create(namespaceId, 'scope', key, request, 'creation-retry');
    expect(replay.headers['x-request-id']).toBe('creation-retry');
  });

  it('blocks new sessions after disable while status and cancel remain available', async () => {
    const { service, setEnabled } = setup();
    const created = await service.create(namespaceId, 'scope', key, request, 'first-request');
    setEnabled(false);
    expect((await service.create(namespaceId, 'scope', key, request, 'replay')).body).toEqual(created.body);
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '1' }, 'changed'),
    ).rejects.toMatchObject({ code: 'MUTATION_KEY_REUSED' });
    await expect(service.create(namespaceId, 'scope', randomUUID(), request, 'second')).rejects.toMatchObject(
      { code: 'VFS_FEATURE_DISABLED' },
    );
    const id = (created.body as { sessionId: string }).sessionId;
    expect((await service.status(namespaceId, id)).state).toBe('OPEN');
    expect((await service.cancel(namespaceId, id)).state).toBe('CANCELLED');
  });

  it('requires an existing parent and enforces the file-size boundary including zero bytes', async () => {
    const { service, setParentExists } = setup();
    setParentExists(false);
    await expect(service.create(namespaceId, 'scope', key, request, 'first')).rejects.toMatchObject({
      code: 'VFS_NODE_NOT_FOUND',
    });
    setParentExists(true);
    await expect(
      service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '9' }, 'first'),
    ).rejects.toMatchObject({ status: 413 });
    const created = await service.create(namespaceId, 'scope', key, request, 'first');
    expect(created.body).toMatchObject({ state: 'OPEN', partCount: 0, partSizeBytes: 4 });
  });

  it('returns accepted index and size without exposing digest or staging key and preserves immutable metadata', async () => {
    const { service } = setup();
    const created = await service.create(namespaceId, 'scope', key, { ...request, sizeBytes: '4' }, 'first');
    const status = await service.status(namespaceId, (created.body as { sessionId: string }).sessionId);
    expect(status).toMatchObject({
      path: '/parent/file.bin',
      sizeBytes: '4',
      parts: [{ index: 0, sizeBytes: '4' }],
      staging: { maxStagedBytes: '1000', status: 'PARTS_STORED' },
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|upload-staging/);
  });

  it('만료된 세션에는 staging 진단을 생략한다', async () => {
    const { service, sessions } = setup();
    const created = await service.create(namespaceId, 'scope', key, request, 'first');
    const id = (created.body as { sessionId: string }).sessionId;
    const session = sessions.get(id)!;
    session.expiresAt = new Date(Date.now() - 1);
    expect(await service.status(namespaceId, id)).not.toHaveProperty('staging');
  });

  it('정책이 제거된 기존 세션에는 staging 진단을 생략한다', async () => {
    const { service, sessions } = setup();
    const created = await service.create(namespaceId, 'scope', key, request, 'first');
    const id = (created.body as { sessionId: string }).sessionId;
    (service as unknown as { policy: UploadSessionPolicy | null }).policy = null;
    expect(sessions.get(id)?.state).toBe('OPEN');
    expect(await service.status(namespaceId, id)).not.toHaveProperty('staging');
  });

  it('capability를 비활성화해도 기존 세션의 staging 진단은 제공한다', async () => {
    const { service, setEnabled } = setup();
    const created = await service.create(namespaceId, 'scope', key, request, 'first');
    const id = (created.body as { sessionId: string }).sessionId;
    setEnabled(false);
    expect(await service.status(namespaceId, id)).toHaveProperty('staging');
  });

  describe('상태 조회의 완료 실패 기록과 파생 만료', () => {
    async function open() {
      const harness = setup();
      const created = await harness.service.create(namespaceId, 'scope', key, request, 'first');
      const id = (created.body as { sessionId: string }).sessionId;
      return { ...harness, id, session: harness.sessions.get(id)! };
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('실패 기록이 있는 OPEN 세션은 lastCompleteFailure를 코드와 ISO 시각으로 보여준다', async () => {
      const { service, id, session } = await open();
      session.lastCompleteFailureCode = 'VFS_QUOTA_EXCEEDED';
      session.lastCompleteFailureAt = new Date('2026-10-07T00:00:00.000Z');
      expect(await service.status(namespaceId, id)).toMatchObject({
        state: 'OPEN',
        lastCompleteFailure: { code: 'VFS_QUOTA_EXCEEDED', at: '2026-10-07T00:00:00.000Z' },
      });
    });

    it('실패 기록이 없으면 lastCompleteFailure 필드를 생략한다', async () => {
      const { service, id } = await open();
      expect(await service.status(namespaceId, id)).not.toHaveProperty('lastCompleteFailure');
    });

    it.each(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'FINALIZING'] as const)(
      '%s 세션에는 남은 실패 기록이 있어도 lastCompleteFailure를 보이지 않는다',
      async (state) => {
        const { service, id, session } = await open();
        session.state = state;
        session.lastCompleteFailureCode = 'VFS_PRECONDITION_FAILED';
        session.lastCompleteFailureAt = new Date();
        expect(await service.status(namespaceId, id)).not.toHaveProperty('lastCompleteFailure');
      },
    );

    it.each(['expiresAt', 'maxExpiresAt'] as const)(
      'now가 %s와 같으면 OPEN 세션에 expired: true를 준다',
      async (field) => {
        const { service, id, session } = await open();
        jest.useFakeTimers({ now: session[field] });
        expect((await service.status(namespaceId, id)).expired).toBe(true);
      },
    );

    it('만료 시각 전의 OPEN 세션에는 expired 필드가 없다', async () => {
      const { service, id, session } = await open();
      jest.useFakeTimers({ now: new Date(session.expiresAt.getTime() - 1) });
      expect(await service.status(namespaceId, id)).not.toHaveProperty('expired');
    });

    it('OPEN이 아닌 세션에는 만료 시각이 지나도 expired 필드가 없다', async () => {
      const { service, id, session } = await open();
      session.state = 'EXPIRED';
      jest.useFakeTimers({ now: new Date(session.maxExpiresAt.getTime() + 1000) });
      expect(await service.status(namespaceId, id)).not.toHaveProperty('expired');
    });

    it('조회는 세션 상태를 바꾸지 않는다', async () => {
      const { service, id, session } = await open();
      jest.useFakeTimers({ now: new Date(session.maxExpiresAt.getTime() + 1000) });
      await service.status(namespaceId, id);
      await service.status(namespaceId, id);
      expect(session.state).toBe('OPEN');
    });
  });

  it('enforces active session caps and cancels only OPEN once', async () => {
    const { service } = setup();
    const first = await service.create(namespaceId, 'scope', key, request, 'first');
    await expect(service.create(namespaceId, 'scope', randomUUID(), request, 'second')).rejects.toMatchObject(
      { status: 429, retryAfterSeconds: 1 },
    );
    const id = (first.body as { sessionId: string }).sessionId;
    expect((await service.cancel(namespaceId, id)).state).toBe('CANCELLED');
    expect((await service.cancel(namespaceId, id)).state).toBe('CANCELLED');
  });

  it.each(['expiresAt', 'maxExpiresAt'] as const)(
    'GC 전환 전이라도 %s가 지난 OPEN 세션의 취소는 EXPIRED로 전환하고 409로 거부한다',
    async (field) => {
      const { service, sessions } = setup();
      const created = await service.create(namespaceId, 'scope', key, request, 'first');
      const id = (created.body as { sessionId: string }).sessionId;
      sessions.get(id)![field] = new Date(Date.now() - 1000);

      await expect(service.cancel(namespaceId, id)).rejects.toMatchObject({
        code: 'VFS_UPLOAD_SESSION_CLOSED',
        status: 409,
      });
      expect(sessions.get(id)!.state).toBe('EXPIRED');
      await expect(service.cancel(namespaceId, id)).rejects.toMatchObject({ status: 409 });
    },
  );
});
