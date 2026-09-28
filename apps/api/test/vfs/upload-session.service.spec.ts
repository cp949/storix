import { randomUUID } from 'node:crypto';
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

  function setup() {
    const sessions = new Map<string, VfsUploadSessionEntity>();
    const repo = {
      createSession: async (input: CreateUploadSessionInput) => {
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
      claimTerminalTransition: async (_ns: string, id: string, next: VfsUploadSessionState) => {
        const session = sessions.get(id);
        if (!session || session.state !== 'OPEN') return false;
        session.state = next;
        return true;
      },
    };
    let enabled = true;
    let parentExists = true;
    const nodes = {
      getRootWithLimits: async () => ({ root: { id: 'root' }, limits: { maxFileSizeBytes: '8' } }),
      resolvePath: async (_ns: string, _root: string, segments: string[]) => {
        if (segments.join('/') === 'parent') return parentExists ? { id: 'parent', type: 'DIRECTORY' } : null;
        return null;
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
      policy,
      {
        get: (name: string) => (name === 'STORIX_MAX_FILE_SIZE_BYTES' ? '8' : undefined),
      } as unknown as ConfigService,
    );
    return {
      service,
      sessions,
      setEnabled: (value: boolean) => {
        enabled = value;
      },
      setParentExists: (value: boolean) => {
        parentExists = value;
      },
    };
  }

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
    });
    expect(JSON.stringify(status)).not.toMatch(/secret|upload-staging/);
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
});
