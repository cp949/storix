import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import type { BlobStorage } from '../storage/blob-storage.js';
import type { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import type { VfsUploadSessionRepository } from '../persistence/vfs-upload-session.repository.js';
import type { CapabilityService } from '../capability/capability.service.js';
import { UploadSessionPartService } from './upload-session-part.service.js';

const namespaceId = randomUUID();
const sessionId = randomUUID();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(encrypted = false, sizeBytes = '6', durationSeconds?: string) {
  const objects = new Map<string, Buffer>();
  const rows = new Map<number, { sizeBytes: string; stagingKey: string; digest: string | null; encryptionIv: string | null; state: string }>();
  let failPut = false;
  let failDelete = false;
  const storage = {
    async put(key: string, source: Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
      objects.set(key, Buffer.concat(chunks));
      if (failPut) throw new Error('put uncertain');
    },
    async delete(key: string) { if (failDelete) throw new Error('delete unavailable'); objects.delete(key); },
  } as BlobStorage;
  const session = { id: sessionId, namespaceId, state: 'OPEN', sizeBytes, partSizeBytes: 4,
    partCount: Math.ceil(Number(sizeBytes) / 4), expiresAt: new Date(Date.now() + 60_000),
    maxExpiresAt: new Date(Date.now() + 120_000) };
  const repo = {
    async findForStatus(ns: string, id: string) { return ns === namespaceId && id === sessionId ? { session, parts: [] } : null; },
    async findPart(_id: string, index: number) { return rows.get(index) ?? null; },
    async reservePart(_id: string, index: number, size: string, key: string) {
      const existing = rows.get(index);
      if (existing && existing.state !== 'DELETED') return { kind: 'exists', part: existing };
      const part = { sizeBytes: size, stagingKey: key, digest: null, encryptionIv: null, state: 'RESERVED' };
      rows.set(index, part);
      return { kind: 'reserved', part };
    },
    async commitPart(_id: string, index: number, digest: string, iv: string | null, key: string) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED') return false;
      Object.assign(row, { digest, encryptionIv: iv, state: 'STORED' });
      return true;
    },
    async releasePartReservation(_id: string, index: number, mayExist: boolean, key: string) {
      const row = rows.get(index);
      if (!row || row.stagingKey !== key || row.state !== 'RESERVED') return false;
      if (mayExist) row.state = 'CLEANUP'; else rows.delete(index);
      return true;
    },
    async renewSession(_ns: string, _id: string, now: Date, inactivitySeconds: number) {
      if (session.expiresAt <= now || session.maxExpiresAt <= now) return false;
      session.expiresAt = new Date(Math.min(now.getTime() + inactivitySeconds * 1000,
        session.maxExpiresAt.getTime()));
      return true;
    },
  } as unknown as VfsUploadSessionRepository;
  const nodes = { async getRootWithLimits() { return { root: {}, limits: { encryptionPolicy: encrypted ? 'ENCRYPTED' : 'NONE' } }; } } as unknown as VfsNodeRepository;
  const capabilities = { requireEnabled() {} } as unknown as CapabilityService;
  const policy = { global: { maxStagedBytes: 10n, maxActiveSessions: 2, partSizeBytes: 4, inactivitySeconds: 60,
    maxLifetimeSeconds: 120 }, namespaces: { [namespaceId]: { maxStagedBytes: 10n, maxActiveSessions: 2 } } };
  const service = new UploadSessionPartService(nodes, repo, capabilities, policy, storage,
    Buffer.alloc(32, 7), new ConfigService(durationSeconds
      ? { STORIX_MUTATION_MAX_UPLOAD_SECONDS: durationSeconds } : {}));
  return { service, session, objects, rows, setFailPut: (value: boolean) => { failPut = value; },
    setFailDelete: (value: boolean) => { failDelete = value; } };
}

const source = (value: string) => Readable.from([Buffer.from(value)]);

it('accepts exact non-final and final part lengths with plaintext digest', async () => {
  const f = fixture();
  expect(await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req')).toMatchObject({
    index: 0, sizeBytes: '4', sha256: sha('abcd'), replayed: false,
  });
  expect(await f.service.putPart(namespaceId, sessionId, '1', source('xy'), '2', 'req')).toMatchObject({
    index: 1, sizeBytes: '2', sha256: sha('xy'), replayed: false,
  });
  expect([...f.objects.keys()].every((key) => /^upload-staging\/[0-9a-f-]{36}$/.test(key))).toBe(true);
});

it('rejects invalid index and declared length before reserving', async () => {
  const f = fixture();
  await expect(f.service.putPart(namespaceId, sessionId, '-1', source('abcd'), '4', 'req')).rejects.toMatchObject({ status: 400 });
  await expect(f.service.putPart(namespaceId, sessionId, '2', source('abcd'), '4', 'req')).rejects.toMatchObject({ status: 400 });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '3', 'req')).rejects.toMatchObject({ status: 400 });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcd'), undefined, 'req')).rejects.toMatchObject({ status: 400 });
  expect(f.rows.size).toBe(0);
});

it('ends a stalled part at the configured upload duration and releases its reservation', async () => {
  const f = fixture(false, '4', '1');
  const stalled = Readable.from((async function* () {
    yield Buffer.from('ab');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    yield Buffer.from('cd');
  })());
  await expect(f.service.putPart(namespaceId, sessionId, '0', stalled, '4', 'req')).rejects.toThrow('duration exceeded');
  expect(f.rows.size).toBe(0);
});

it('rejects truncated and oversized streams without retaining a reservation', async () => {
  const f = fixture();
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abc'), '4', 'req')).rejects.toMatchObject({ status: 400 });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcde'), '4', 'req')).rejects.toMatchObject({ status: 413 });
  expect(f.rows.size).toBe(0);
});

it('replays identical plaintext and rejects different content without changing accepted object', async () => {
  const f = fixture();
  const first = await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req');
  expect(await f.service.putPart(namespaceId, sessionId, '0', source('abcd'), '4', 'req2')).toMatchObject({
    ...first, replayed: true,
  });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('wxyz'), '4', 'req3')).rejects.toMatchObject({ status: 409 });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abc'), '3', 'req4')).rejects.toMatchObject({ status: 409 });
  await expect(f.service.putPart(namespaceId, sessionId, '0', source('abcde'), '4', 'req5')).rejects.toMatchObject({ status: 409 });
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
