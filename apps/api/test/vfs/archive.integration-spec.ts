// PostgreSQL·S3 Testcontainers에서 archive HTTP 생성과 receipt 재생을 확인한다.
// 검증 규칙은 docs/design/16-file-archive.md의 "공개 계약", "실행과 실패 경계" 절을 따른다.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import request from 'supertest';
import { jest } from '@jest/globals';
import { IsNull } from 'typeorm';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { createFsHttpFixture } from './fs-http-fixture.test-support.js';

// 실제 PostgreSQL·S3 fixture에서 archive 생성과 평문 다운로드를 검증한다.
describe('archive HTTP PostgreSQL 계약 검증', () => {
  const ctx = createFsHttpFixture({ enableArchive: true });

  it('ZIP FILE을 만들고 동일 key 재시도에서 receipt를 재생한다', async () => {
    const namespaceId = await ctx.createNamespace(`archive-${randomUUID()}`);
    const db = ctx.migrationDataSource;
    const root = await db.getRepository(VfsNodeEntity).findOneByOrFail({ namespaceId, parentId: IsNull() });
    const bytes = Buffer.from('postgres archive source');
    const storageKey = `blobs/${randomUUID()}`;
    await ctx.app.get<BlobStorage>(BLOB_STORAGE).put(storageKey, Readable.from(bytes), 'text/plain');
    const blob = await db.getRepository(BlobEntity).save(
      db.getRepository(BlobEntity).create({
        namespaceId,
        storageKey,
        size: String(bytes.length),
        mimeType: 'text/plain',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        referenceCount: 1,
      }),
    );
    const source = await db.getRepository(VfsNodeEntity).save(
      db.getRepository(VfsNodeEntity).create({
        namespaceId,
        parentId: root.id,
        type: 'FILE',
        name: 'source.txt',
        blobId: blob.id,
        size: String(bytes.length),
        mimeType: 'text/plain',
      }),
    );
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    const key = randomUUID();
    const body = { target: '/result.zip', entries: [{ id: source.id, name: 'source.txt' }] };
    const storage = ctx.app.get<BlobStorage>(BLOB_STORAGE);
    const getSpy = jest.spyOn(storage, 'get');
    const first = await request(ctx.httpServer)
      .post(path)
      .set('X-Mutation-Scope', 'archive-postgres')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(first.body.entryCount).toBe(1);
    expect(first.body.resource.mimeType).toBe('application/zip');
    const resultNode = await db.getRepository(VfsNodeEntity).findOneByOrFail({ id: first.body.resource.id });
    const resultBlob = await db.getRepository(BlobEntity).findOneByOrFail({ id: resultNode.blobId! });
    const zip = await storage.get(resultBlob.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of zip) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).subarray(0, 4).toString('hex')).toBe('504b0304');

    const sourceReadsBeforeReplay = getSpy.mock.calls.length;
    const replay = await request(ctx.httpServer)
      .post(path)
      .set('X-Mutation-Scope', 'archive-postgres')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(getSpy).toHaveBeenCalledTimes(sourceReadsBeforeReplay);
    getSpy.mockRestore();
  }, 60000);

  it('PostgreSQL 암호화 namespace에서 source와 archive 다운로드가 평문을 보존한다', async () => {
    const created = await request(ctx.httpServer)
      .post('/api/v2/namespaces')
      .set('Idempotency-Key', randomUUID())
      .send({ name: `archive-encrypted-${randomUUID()}`, encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const namespaceId = created.body.id as string;
    const payload = Buffer.from('postgres encrypted archive payload');
    await request(ctx.httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/secret.txt' })
      .set('Content-Type', 'text/plain')
      .send(payload)
      .expect(201);
    const sourceDownload = await request(ctx.httpServer)
      .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
      .query({ path: '/secret.txt' })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(sourceDownload.body).toEqual(payload);
    const source = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId, name: 'secret.txt' });

    const archived = await request(ctx.httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/archive`)
      .set('X-Mutation-Scope', 'archive-postgres-encrypted')
      .set('Idempotency-Key', randomUUID())
      .set('X-Expires-In', '3600')
      .send({ target: '/result.zip', entries: [{ id: source.id, name: 'secret.txt' }] })
      .expect(201);
    expect(archived.body.resource.expiresAt).toEqual(expect.any(String));
    const downloaded = await request(ctx.httpServer)
      .get(`/api/v2/namespaces/${namespaceId}/fs/download`)
      .query({ path: '/result.zip' })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const zipBytes = downloaded.body as Buffer;
    expect(zipBytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    execFileSync(
      'python3',
      [
        '-c',
        "import io,sys,zipfile; assert zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())).read('secret.txt') == b'postgres encrypted archive payload'",
      ],
      { input: zipBytes },
    );

    const resultNode = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ id: archived.body.resource.id as string });
    const resultBlob = await ctx.migrationDataSource
      .getRepository(BlobEntity)
      .findOneByOrFail({ id: resultNode.blobId! });
    const stored = await ctx.app.get<BlobStorage>(BLOB_STORAGE).get(resultBlob.storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stored) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks)).not.toEqual(zipBytes);
  }, 60000);

  it('PostgreSQL archive commit은 변경된 quota를 적용한다', async () => {
    const namespaceId = await ctx.createNamespace(`archive-quota-${randomUUID()}`);
    const payload = Buffer.from('quota source');
    await request(ctx.httpServer)
      .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
      .query({ path: '/source.txt' })
      .set('Content-Type', 'text/plain')
      .send(payload)
      .expect(201);
    const source = await ctx.migrationDataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId, name: 'source.txt' });
    await ctx.migrationDataSource
      .getRepository(NamespaceEntity)
      .update({ id: namespaceId }, { maxTotalLogicalBytes: String(payload.length) });
    const path = `/api/v2/namespaces/${namespaceId}/fs/archive`;
    await request(ctx.httpServer)
      .post(path)
      .set('X-Mutation-Scope', 'archive-postgres-quota')
      .set('Idempotency-Key', randomUUID())
      .send({ target: '/over-quota.zip', entries: [{ id: source.id, name: 'source.txt' }] })
      .expect(413);
    await expect(
      ctx.migrationDataSource.getRepository(VfsNodeEntity).findOneBy({ namespaceId, name: 'over-quota.zip' }),
    ).resolves.toBeNull();
  }, 60000);
});
