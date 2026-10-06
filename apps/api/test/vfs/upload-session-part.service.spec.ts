import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import { UploadSessionPartService } from '../../src/vfs/upload-session-part.service.js';
import { ContentIngressService } from '../../src/vfs/content-ingress.service.js';

const namespaceId = randomUUID();
const sessionId = randomUUID();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(
  encrypted = false,
  sizeBytes = '6',
  durationSeconds?: string,
  partSizeBytes = 4,
  maxStagedBytes = 10n,
) {
  const objects = new Map<string, Buffer>();
  const rows = new Map<
    number,
    {
      sizeBytes: string;
      stagingKey: string;
      digest: string | null;
      encryptionIv: string | null;
      state: string;
      leaseExpiresAt: Date;
    }
  >();
  const retired = new Map<string, boolean>();
  let failPut = false;
  let failDelete = false;
  let loseCommitAck = false;
  let deleteDelayMs = 0;
  let commitDelayMs = 0;
  let finishPut: (() => void) | null = null;
  let stallPut = false;
  let resumePut: (() => void) | null = null;
  let stallBeforeConsume = false;
  // 저장소가 반환한 만료 시각을 테스트가 지정한다. 없으면 갱신 규칙대로 계산한다.
  let committedExpiry: Date | null = null;
  let recoveredExpiry: Date | null = null;
  let recoveryLookups = 0;
  const storage = {
    async put(key: string, source: Readable) {
      if (stallBeforeConsume)
        await new Promise<void>((resolve) => {
          resumePut = resolve;
        });
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
      if (stallPut)
        await new Promise<void>((resolve) => {
          finishPut = resolve;
        });
      objects.set(key, Buffer.concat(chunks));
      if (failPut) throw new Error('put uncertain');
    },
    async delete(key: string) {
      if (deleteDelayMs) await new Promise((resolve) => setTimeout(resolve, deleteDelayMs));
      if (failDelete) throw new Error('delete unavailable');
      objects.delete(key);
    },
  } as BlobStorage;
  const session = {
    id: sessionId,
    namespaceId,
    state: 'OPEN',
    sizeBytes,
    partSizeBytes,
    partCount: Math.ceil(Number(sizeBytes) / partSizeBytes),
    expiresAt: new Date(Date.now() + 60_000),
    maxExpiresAt: new Date(Date.now() + 120_000),
  };
  const repo = {
    async findForStatus(ns: string, id: string) {
      return ns === namespaceId && id === sessionId ? { session, parts: [] } : null;
    },
    async findPart(_id: string, index: number) {
      return rows.get(index) ?? null;
    },
    async reservePart(_id: string, index: number, size: string, key: string) {
      const existing = rows.get(index);
      if (existing && existing.state !== 'DELETED') return { kind: 'exists', part: existing };
      if ([...retired.values()].some((deleted) => !deleted)) return { kind: 'in-progress' };
      const part = {
        sizeBytes: size,
        stagingKey: key,
        digest: null,
        encryptionIv: null,
        state: 'RESERVED',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      rows.set(index, part);
      return { kind: 'reserved', part };
    },
    async commitPart(
      _id: string,
      index: number,
      digest: string,
      iv: string | null,
      key: string,
      inactivitySeconds?: number,
    ) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED') return null;
      Object.assign(row, { digest, encryptionIv: iv, state: 'STORED' });
      if (inactivitySeconds !== undefined)
        session.expiresAt = new Date(
          Math.min(Date.now() + inactivitySeconds * 1000, session.maxExpiresAt.getTime()),
        );
      if (commitDelayMs) await new Promise((resolve) => setTimeout(resolve, commitDelayMs));
      if (loseCommitAck) throw new Error('commit acknowledgement lost');
      return { expiresAt: committedExpiry ?? session.expiresAt };
    },
    async findStoredPartWithExpiry(_id: string, index: number, key: string) {
      recoveryLookups++;
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'STORED' || !row.digest) return null;
      return { part: row, expiresAt: recoveredExpiry ?? session.expiresAt };
    },
    async releasePartReservation(_id: string, index: number, mayExist: boolean, key: string) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED') return false;
      if (mayExist) row.state = 'CLEANUP';
      else rows.delete(index);
      return true;
    },
    async renewPartLease(_id: string, index: number, key: string) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED') return false;
      row.leaseExpiresAt = new Date(Date.now() + 60_000);
      return true;
    },
    async retireExpiredPartReservation(_id: string, index: number, key: string) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED' || row.leaseExpiresAt > new Date())
        return false;
      rows.delete(index);
      retired.set(key, false);
      return true;
    },
    async markTombstoneDeleted(key: string) {
      if (!retired.has(key)) return false;
      retired.set(key, true);
      return true;
    },
    async renewSession(_ns: string, _id: string, now: Date, inactivitySeconds: number) {
      if (session.expiresAt <= now || session.maxExpiresAt <= now) return null;
      session.expiresAt = new Date(
        Math.min(now.getTime() + inactivitySeconds * 1000, session.maxExpiresAt.getTime()),
      );
      return { expiresAt: session.expiresAt };
    },
  } as unknown as VfsUploadSessionRepository;
  const nodes = {
    async getRoot() {
      return { id: 'root' };
    },
    async getRootWithLimits() {
      return { root: {}, limits: { encryptionPolicy: encrypted ? 'ENCRYPTED' : 'NONE' } };
    },
  } as unknown as VfsNodeRepository;
  const capabilities = { requireEnabled() {} } as unknown as CapabilityService;
  const policy = {
    global: {
      maxStagedBytes,
      maxActiveSessions: 2,
      partSizeBytes,
      inactivitySeconds: 60,
      maxLifetimeSeconds: 120,
    },
    namespaces: { [namespaceId]: { maxStagedBytes, maxActiveSessions: 2 } },
  };
  const service = new UploadSessionPartService(
    nodes,
    repo,
    capabilities,
    policy,
    storage,
    new ContentIngressService(storage, Buffer.alloc(32, 7)),
    new ConfigService(durationSeconds ? { STORIX_MUTATION_MAX_UPLOAD_SECONDS: durationSeconds } : {}),
  );
  return {
    service,
    session,
    objects,
    rows,
    setFailPut: (value: boolean) => {
      failPut = value;
    },
    setFailDelete: (value: boolean) => {
      failDelete = value;
    },
    setLoseCommitAck: (value: boolean) => {
      loseCommitAck = value;
    },
    setDeleteDelay: (value: number) => {
      deleteDelayMs = value;
    },
    setCommitDelay: (value: number) => {
      commitDelayMs = value;
    },
    setCommittedExpiry: (value: Date) => {
      committedExpiry = value;
    },
    setRecoveredExpiry: (value: Date) => {
      recoveredExpiry = value;
    },
    recoveryLookups: () => recoveryLookups,
    setStallPut: (value: boolean) => {
      stallPut = value;
    },
    finishStalledPut: () => finishPut?.(),
    setStallBeforeConsume: (value: boolean) => {
      stallBeforeConsume = value;
    },
    resumePut: () => resumePut?.(),
    setUnsettledTombstone: (index: number, key: string) => {
      retired.set(key, false);
      rows.set(index, {
        sizeBytes: '4',
        stagingKey: key,
        digest: null,
        encryptionIv: null,
        state: 'DELETED',
        leaseExpiresAt: new Date(0),
      });
    },
  };
}

const source = (value: string) => Readable.from([Buffer.from(value)]);

// 상한을 넘는 초를 ms로 바꿔 setTimeout에 넘기면 1ms 뒤에 발화해 모든 조각 요청이 즉시 끊긴다.
it('업로드 최대 지속 시간이 타이머 상한을 넘으면 생성 시점에 거부한다', () => {
  expect(() => fixture(false, '6', '2592000')).toThrow('잘못된 정수 환경변수 값');
});

it('accepts exact non-final and final part lengths with plaintext digest', async () => {
  const f = fixture();
  expect(await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).toMatchObject({
    index: 0,
    sizeBytes: '4',
    sha256: sha('abcd'),
    replayed: false,
  });
  expect(await f.service.putPart(namespaceId, sessionId, '1', source('xy'), '2', 'req')).toMatchObject({
    index: 1,
    sizeBytes: '2',
    sha256: sha('xy'),
    replayed: false,
  });
  expect([...f.objects.keys()].every((key) => /^upload-staging\/[0-9a-f-]{36}$/.test(key))).toBe(true);
});

it('rejects invalid index and declared length before reserving', async () => {
  const f = fixture();
  await expect(
    f.service.putPart(namespaceId, sessionId, '-1', source('abcd'), '4', 'req'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '2', source('abcd'), '4', 'req'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '3', 'req'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abcd'), undefined, 'req'),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.rows.size).toBe(0);
});

it('returns 409 while an earlier uncertain PUT is still awaiting exact-key cleanup', async () => {
  const f = fixture(false, '4');
  f.setUnsettledTombstone(0, 'upload-staging/old-unsettled');
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'retry'),
  ).rejects.toMatchObject({ status: 409, code: 'VFS_UPLOAD_PART_IN_PROGRESS' });
});

it('ends a stalled part at the configured upload duration and releases its reservation', async () => {
  const f = fixture(false, '4', '1');
  const stalled = Readable.from(
    (async function* () {
      yield Buffer.from('ab');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      yield Buffer.from('cd');
    })(),
  );
  await expect(f.service.putPart(namespaceId, sessionId, '0', stalled, '4', 'req')).rejects.toThrow(
    'duration exceeded',
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(f.rows.size).toBe(0);
});

it('returns at the deadline while a storage PUT is stalled and keeps its reservation until late cleanup', async () => {
  const f = fixture(false, '4', '1');
  f.setStallPut(true);
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).rejects.toThrow(
    'duration exceeded',
  );
  expect(f.rows.get(0)?.state).toBe('RESERVED');
  f.finishStalledPut();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(f.rows.size).toBe(0);
  expect(f.objects.size).toBe(0);
});

it('returns at the deadline while sink backpressure is stalled and keeps the reservation', async () => {
  const f = fixture(false, '200000', '1', 200000, 200000n);
  f.setStallBeforeConsume(true);
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', Readable.from([Buffer.alloc(200000)]), '200000', 'req'),
  ).rejects.toThrow('duration exceeded');
  expect(f.rows.get(0)?.state).toBe('RESERVED');
  f.resumePut();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(f.rows.size).toBe(0);
});

it('retries an expired reservation only after deleting its exact old key', async () => {
  const f = fixture(false, '4');
  f.rows.set(0, {
    sizeBytes: '4',
    stagingKey: 'upload-staging/old',
    digest: null,
    encryptionIv: null,
    state: 'RESERVED',
    leaseExpiresAt: new Date(Date.now() - 1000),
  });
  f.objects.set('upload-staging/old', Buffer.from('old!'));
  const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
  expect(result.sha256).toBe(sha('abcd'));
  expect(f.objects.has('upload-staging/old')).toBe(false);
  expect(f.rows.get(0)?.stagingKey).toMatch(/^upload-staging\/[0-9a-f-]{36}$/);
});

it('rejects truncated and oversized streams without retaining a reservation', async () => {
  const f = fixture();
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abc'), '4', 'req'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abcde'), '4', 'req'),
  ).rejects.toMatchObject({ status: 413 });
  expect(f.rows.size).toBe(0);
});

it('replays identical plaintext and rejects different content without changing accepted object', async () => {
  const f = fixture();
  const { expiresAt, ...first } = await f.service.putPart(
    namespaceId,
    sessionId,
    '0',
    source('abcd'),
    '4',
    'req',
  );
  expect(typeof expiresAt).toBe('string');
  // expiresAt은 재전송이 다시 갱신하는 시각이라 조각 동일성 비교에서 뺀다.
  expect(await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req2')).toMatchObject({
    ...first,
    replayed: true,
  });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('wxyz'), '4', 'req3'),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abc'), '3', 'req4'),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.service.putPart(namespaceId, sessionId, '0', source('abcde'), '4', 'req5'),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.objects.size).toBe(1);
  expect([...f.objects.values()][0].toString()).toBe('abcd');
});

it('renews same-digest replay activity up to the absolute lifetime', async () => {
  const f = fixture(false, '4');
  await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
  const now = Date.now();
  f.session.expiresAt = new Date(now + 1000);
  f.session.maxExpiresAt = new Date(now + 10_000);
  await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'replay');
  expect(f.session.expiresAt).toEqual(f.session.maxExpiresAt);
});

it('keeps an uncertain failed write charged when deletion also fails, then uses a fresh key after cleanup', async () => {
  const f = fixture();
  f.setFailPut(true);
  f.setFailDelete(true);
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).rejects.toThrow();
  const oldKey = f.rows.get(0)?.stagingKey;
  expect(f.rows.get(0)?.state).toBe('CLEANUP');
  f.rows.get(0)!.state = 'DELETED';
  f.setFailPut(false);
  f.setFailDelete(false);
  await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req2');
  expect(f.rows.get(0)?.stagingKey).not.toBe(oldKey);
});

it('stages ciphertext with IV while retaining the plaintext digest', async () => {
  const f = fixture(true);
  const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
  expect(result.sha256).toBe(sha('abcd'));
  expect(f.rows.get(0)?.encryptionIv).toMatch(/^[0-9a-f]{32}$/);
  expect([...f.objects.values()][0].equals(Buffer.from('abcd'))).toBe(false);
});

it('preserves a stored object when the database commit acknowledgement is lost', async () => {
  const f = fixture();
  f.setLoseCommitAck(true);
  const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
  expect(result).toMatchObject({ sha256: sha('abcd'), replayed: false });
  expect(f.rows.get(0)?.state).toBe('STORED');
  expect(f.objects.size).toBe(1);
  expect([...f.objects.values()][0].toString()).toBe('abcd');
});

it('returns at the deadline while failed-write cleanup remains charged in the background', async () => {
  const f = fixture(false, '4', '1');
  f.setFailPut(true);
  f.setDeleteDelay(1200);
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).rejects.toThrow(
    'duration exceeded',
  );
  expect(f.rows.get(0)?.state).toBe('RESERVED');
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(f.rows.size).toBe(0);
});

it('returns at the deadline while part commit acknowledgement remains pending', async () => {
  const f = fixture(false, '4', '1');
  f.setCommitDelay(1200);
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).rejects.toThrow(
    'duration exceeded',
  );
  expect(f.rows.get(0)?.state).toBe('STORED');
  expect(f.objects.size).toBe(1);
});

describe('조각 저장 응답의 세션 만료 시각', () => {
  it('새 조각 응답은 저장소가 반환한 만료를 그대로 담고 추가 조회로 대체하지 않는다', async () => {
    const f = fixture();
    const returned = new Date(Date.now() + 33_000);
    f.setCommittedExpiry(returned);
    const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
    expect(result.expiresAt).toBe(returned.toISOString());
    expect(f.recoveryLookups()).toBe(0);
  });

  it('조각 저장은 비활동 만료를 갱신한 값을 최대 수명 안에서 응답한다', async () => {
    const f = fixture();
    f.session.maxExpiresAt = new Date(Date.now() + 10_000);
    const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
    expect(result.expiresAt).toBe(f.session.maxExpiresAt.toISOString());
  });

  it('동일 조각 재전송 응답도 갱신된 만료를 담고 최대 수명을 넘지 않는다', async () => {
    const f = fixture(false, '4');
    await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
    const now = Date.now();
    f.session.expiresAt = new Date(now + 1000);
    f.session.maxExpiresAt = new Date(now + 10_000);
    const replay = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'replay');
    expect(replay.replayed).toBe(true);
    expect(replay.expiresAt).toBe(f.session.maxExpiresAt.toISOString());
    expect(Date.parse(replay.expiresAt)).toBeLessThanOrEqual(f.session.maxExpiresAt.getTime());
  });

  it('commit ACK를 잃은 복구는 복구 조회가 읽은 만료를 응답한다', async () => {
    const f = fixture();
    f.setLoseCommitAck(true);
    const observed = new Date(Date.now() + 44_000);
    f.setRecoveredExpiry(observed);
    const result = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
    expect(result).toMatchObject({ sha256: sha('abcd'), replayed: false, expiresAt: observed.toISOString() });
    expect(f.recoveryLookups()).toBe(1);
  });
});
