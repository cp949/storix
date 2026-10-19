// extract HTTP 계약을 두 DB wrapper가 공용으로 실행하는 시나리오다.
// 실제 body parser, controller, receipt, repository, 트랜잭션을 거치며 source와 대상 부모는 mkdir·content API로 준비한다.
// 규칙은 docs/design/17-file-extract.md "공개 계약"과 "실행". wrapper는 서버·DB·저장소를 준비해 context로 넘긴다.
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import type { DataSource } from 'typeorm';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { ArchiveGate } from '../../src/vfs/archive-gate.js';
import { VfsFeatureDisabledError } from '../../src/vfs/vfs.errors.js';
import { buildTar } from './tar-fixture.test-support.js';
import { centralDirectoryOffset, handZip } from './zip-fixture.test-support.js';

/** namespace 생성 옵션이다. */
export interface ExtractNamespaceOptions {
  readonly encrypted?: boolean;
  readonly trashEnabled?: boolean;
}

/** wrapper가 준비해 넘기는 서버와 관측 수단이다. */
export interface ExtractHttpContext {
  /** supertest가 요청을 보낼 HTTP 서버다. */
  readonly server: () => Parameters<typeof request>[0];

  /** 모든 요청에 붙일 인증 헤더다. 인증이 없는 fixture는 빈 객체다. */
  readonly headers: () => Record<string, string>;

  readonly createNamespace: (options?: ExtractNamespaceOptions) => Promise<string>;

  readonly dataSource: () => DataSource;

  /** 서비스가 쓰는 저장소 인스턴스다. 실패 주입을 위해 spy를 건다. */
  readonly storage: () => BlobStorage;

  /** 저장소에 있는 모든 object key다. */
  readonly storageKeys: () => Promise<string[]>;

  readonly capabilities: () => CapabilityService;

  readonly gate: () => ArchiveGate;
}

/** 모든 형식이 같은 트리를 만들도록 쓰는 기준 내용이다. */
const FILES: Readonly<Record<string, string>> = {
  'index.html': '<html>',
  'css/app.css': 'body{}',
  'deep/er/file.txt': 'deep',
};

const binaryParser = (response: request.Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
};

/** 기준 내용을 담은 tar다. 빈 DIRECTORY `empty/`를 하나 더 둔다. */
export function sampleTar(): Buffer {
  return buildTar([
    { name: 'index.html', body: Buffer.from(FILES['index.html']) },
    { name: 'css/app.css', body: Buffer.from(FILES['css/app.css']) },
    { name: 'empty/', type: '5' },
    { name: 'deep/er/file.txt', body: Buffer.from(FILES['deep/er/file.txt']) },
  ]);
}

export const sampleTarGz = (): Buffer => gzipSync(sampleTar());

/** 기준 내용을 담은 ZIP이다. 첫 FILE은 DEFLATE, local header offset이 16 byte 경계에 맞지 않게 이름을 골랐다. */
export function sampleZip(): Buffer {
  return handZip([
    { name: 'index.html', body: Buffer.from(FILES['index.html']), method: 8 },
    { name: 'css/app.css', body: Buffer.from(FILES['css/app.css']) },
    { name: 'empty/' },
    { name: 'deep/er/file.txt', body: Buffer.from(FILES['deep/er/file.txt']), method: 8 },
  ]);
}

const SAMPLES: readonly (readonly [string, () => Buffer])[] = [
  ['tar', sampleTar],
  ['tar.gz', sampleTarGz],
  ['zip', sampleZip],
];

export function registerExtractHttpScenarios(ctx: ExtractHttpContext): void {
  const base = (namespaceId: string) => `/api/v2/namespaces/${namespaceId}/fs`;

  async function mkdir(namespaceId: string, path: string): Promise<void> {
    const response = await request(ctx.server())
      .post(`${base(namespaceId)}/mkdir`)
      .set(ctx.headers())
      .send({ path, parents: true });
    expect(response.status).toBeLessThan(300);
  }

  async function upload(namespaceId: string, path: string, bytes: Buffer): Promise<void> {
    const response = await request(ctx.server())
      .post(`${base(namespaceId)}/content`)
      .query({ path, parents: 'true', force: 'true' })
      .set(ctx.headers())
      .set('Content-Type', 'application/octet-stream')
      .send(bytes);
    expect(response.status).toBeLessThan(300);
  }

  async function stat(namespaceId: string, path: string) {
    return request(ctx.server())
      .get(`${base(namespaceId)}/stat`)
      .query({ path })
      .set(ctx.headers());
  }

  async function readBytes(namespaceId: string, path: string): Promise<Buffer> {
    const response = await request(ctx.server())
      .get(`${base(namespaceId)}/content`)
      .query({ path })
      .set(ctx.headers())
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    return response.body as Buffer;
  }

  /** extract 요청을 보낸다. body가 문자열이면 원문 그대로 보낸다. */
  function extract(
    namespaceId: string,
    body: Record<string, unknown> | string,
    key: string = randomUUID(),
    scope = 'extract-http',
  ) {
    return request(ctx.server())
      .post(`${base(namespaceId)}/extract`)
      .set(ctx.headers())
      .set('X-Mutation-Scope', scope)
      .set('Idempotency-Key', key)
      .set('Content-Type', 'application/json')
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  }

  /** source를 올리고 요청 본문의 공통 필드를 돌려준다. */
  async function prepare(namespaceId: string, archive: Buffer, sourcePath = '/.staging/u/up.bin') {
    await mkdir(namespaceId, '/sites');
    await upload(namespaceId, sourcePath, archive);
    const response = await stat(namespaceId, sourcePath);
    return { source: sourcePath, sourceRevision: response.body.revision as string };
  }

  const receiptCount = (namespaceId: string, key: string) =>
    ctx.dataSource().getRepository(VfsMutationReceiptEntity).countBy({ namespaceId, idempotencyKey: key });

  async function expectSampleTree(
    namespaceId: string,
    destination: string,
    mime = 'application/octet-stream',
  ) {
    for (const [name, content] of Object.entries(FILES))
      expect((await readBytes(namespaceId, `${destination}/${name}`)).toString()).toBe(content);
    expect((await stat(namespaceId, `${destination}/empty`)).body.type).toBe('DIRECTORY');
    expect((await stat(namespaceId, `${destination}/css`)).body.type).toBe('DIRECTORY');
    expect((await stat(namespaceId, `${destination}/css/app.css`)).body.mimeType).toBe(mime);
  }

  describe('성공', () => {
    it.each(SAMPLES)(
      '%s를 없던 destination에 풀면 201이고 트리·MIME·revision이 stat과 맞다',
      async (_name, build) => {
        const namespaceId = await ctx.createNamespace();
        const common = await prepare(namespaceId, build());
        const response = await extract(namespaceId, {
          ...common,
          destination: '/sites/site',
          mode: 'overwrite',
          mimeTypes: { '.html': 'text/html' },
        });
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          entryCount: 4,
          createdCount: 3,
          replacedCount: 0,
          resource: { path: '/sites/site', type: 'DIRECTORY', name: 'site' },
        });
        expect(response.body).not.toHaveProperty('trashId');
        await expectSampleTree(namespaceId, '/sites/site');
        expect((await stat(namespaceId, '/sites/site/index.html')).body.mimeType).toBe('text/html');
        const destination = (await stat(namespaceId, '/sites/site')).body;
        expect(response.body.resource.version).toBe(destination.version);
        expect(
          (response.body.affectedRevisions as { path: string; revision: string }[]).find(
            (item) => item.path === '/sites/site',
          )?.revision,
        ).toBe(destination.revision);
      },
      60000,
    );

    it('overwrite는 기존 대상에 200이고 FILE id를 유지하며 아카이브에 없는 FILE을 남긴다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      await upload(namespaceId, '/sites/site/index.html', Buffer.from('old'));
      await upload(namespaceId, '/sites/site/keep.txt', Buffer.from('keep'));
      const before = (await stat(namespaceId, '/sites/site/index.html')).body;
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ entryCount: 4, createdCount: 2, replacedCount: 1 });
      const after = (await stat(namespaceId, '/sites/site/index.html')).body;
      expect(after.id).toBe(before.id);
      expect(after.version).toBe(before.version + 1);
      expect((await readBytes(namespaceId, '/sites/site/index.html')).toString()).toBe('<html>');
      expect((await readBytes(namespaceId, '/sites/site/keep.txt')).toString()).toBe('keep');
      expect(response.body.resource.version).toBe((await stat(namespaceId, '/sites/site')).body.version);
    }, 60000);

    it('clean은 기존 subtree와 그 안의 source를 지우고 200이며 휴지통이 꺼져 있으면 trashId가 없다', async () => {
      const namespaceId = await ctx.createNamespace();
      await mkdir(namespaceId, '/sites/site/sub');
      await upload(namespaceId, '/sites/site/old.txt', Buffer.from('old'));
      await upload(namespaceId, '/sites/site/sub/old2.txt', Buffer.from('old2'));
      const common = await prepare(namespaceId, sampleZip(), '/sites/site/up.zip');
      const response = await extract(namespaceId, { ...common, destination: '/sites/site', mode: 'clean' });
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('trashId');
      for (const gone of ['/sites/site/old.txt', '/sites/site/sub', '/sites/site/up.zip'])
        expect((await stat(namespaceId, gone)).status).toBe(404);
      await expectSampleTree(namespaceId, '/sites/site');
      expect(response.body.resource.version).toBe((await stat(namespaceId, '/sites/site')).body.version);
    }, 60000);

    it('휴지통이 켜진 namespace의 clean은 trashId를 돌려준다', async () => {
      const namespaceId = await ctx.createNamespace({ trashEnabled: true });
      await upload(namespaceId, '/sites/site/old.txt', Buffer.from('old'));
      const common = await prepare(namespaceId, sampleTar());
      const response = await extract(namespaceId, { ...common, destination: '/sites/site', mode: 'clean' });
      expect(response.status).toBe(200);
      expect(response.body.trashId).toEqual(expect.any(String));
      expect((await stat(namespaceId, '/sites/site/old.txt')).status).toBe(404);
    }, 60000);

    it('clean도 없던 destination이면 201이다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTarGz());
      const response = await extract(namespaceId, { ...common, destination: '/sites/fresh', mode: 'clean' });
      expect(response.status).toBe(201);
      await expectSampleTree(namespaceId, '/sites/fresh');
    }, 60000);

    it('빈 ZIP·빈 tar·모두 제외한 archive의 clean은 기존 대상을 비운 빈 DIRECTORY를 남긴다', async () => {
      const namespaceId = await ctx.createNamespace();
      await upload(namespaceId, '/sites/site/old.txt', Buffer.from('old'));
      for (const [archive, exclude] of [
        [handZip([]), []],
        [buildTar([]), []],
        [sampleTar(), ['**']],
      ] as const) {
        await upload(namespaceId, '/sites/site/old.txt', Buffer.from('old'));
        const common = await prepare(namespaceId, archive);
        const response = await extract(namespaceId, {
          ...common,
          destination: '/sites/site',
          mode: 'clean',
          exclude,
        });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ entryCount: 0, createdCount: 0, replacedCount: 0 });
        expect((await stat(namespaceId, '/sites/site/old.txt')).status).toBe(404);
        expect((await stat(namespaceId, '/sites/site')).body.type).toBe('DIRECTORY');
      }
    }, 90000);

    it('같은 key의 재시도는 최초 status·body·헤더를 그대로 재생하고 새 object나 version 증가가 없다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const first = await extract(namespaceId, body, key);
      expect(first.status).toBe(201);
      const keysBefore = (await ctx.storageKeys()).sort();
      const versionBefore = (await stat(namespaceId, '/sites/site')).body.version;
      const replay = await extract(namespaceId, body, key);
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      expect((await ctx.storageKeys()).sort()).toEqual(keysBefore);
      expect((await stat(namespaceId, '/sites/site')).body.version).toBe(versionBefore);
      const reused = await extract(namespaceId, { ...body, mode: 'clean' }, key);
      expect(reused.status).toBe(409);
      expect(reused.body.code).toBe('MUTATION_KEY_REUSED');
    }, 60000);
  });

  describe('dryRun', () => {
    it('성공한 dryRun은 대상을 바꾸지 않고 receipt를 남기지 않으며 같은 key로 본 실행할 수 있다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTarGz());
      const key = randomUUID();
      const dry = await extract(
        namespaceId,
        { ...common, destination: '/sites/site', mode: 'overwrite', dryRun: true, exclude: ['css/**'] },
        key,
      );
      expect(dry.status).toBe(200);
      expect(dry.body).toEqual({
        format: 'tar.gz',
        entryCount: 3,
        totalBytes: 10,
        entries: [
          { name: 'index.html', type: 'FILE', size: 6 },
          { name: 'empty', type: 'DIRECTORY', size: 0 },
          { name: 'deep/er/file.txt', type: 'FILE', size: 4 },
        ],
      });
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
      expect(await receiptCount(namespaceId, key)).toBe(0);
      const real = await extract(
        namespaceId,
        { ...common, destination: '/sites/site', mode: 'overwrite', exclude: ['css/**'] },
        key,
      );
      expect(real.status).toBe(201);
    }, 60000);

    it('dryRun의 결정적 실패는 receipt에 저장하고 재생하며 대상을 바꾸지 않는다', async () => {
      const namespaceId = await ctx.createNamespace();
      const broken = handZip([
        { name: 'ok.txt', body: Buffer.from('ok') },
        { name: 'bad.txt', body: Buffer.from('bad'), crc: 1 },
      ]);
      const common = await prepare(namespaceId, broken);
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite', dryRun: true };
      const first = await extract(namespaceId, body, key);
      expect(first.status).toBe(400);
      expect(first.body).toMatchObject({
        code: 'VFS_EXTRACT_INVALID_ENTRY',
        entryIndex: 1,
        entryName: 'bad.txt',
      });
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
      expect(await receiptCount(namespaceId, key)).toBe(1);
      const replay = await extract(namespaceId, body, key);
      expect(replay.status).toBe(400);
      expect(replay.body).toEqual(first.body);
    }, 60000);

    it('gzip trailer가 깨진 tar.gz는 dryRun에서도 성공하지 않는다', async () => {
      const namespaceId = await ctx.createNamespace();
      const gz = sampleTarGz();
      gz[gz.length - 6] ^= 0xff;
      const common = await prepare(namespaceId, gz);
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
        dryRun: true,
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VFS_EXTRACT_INVALID_ENTRY');
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
    }, 60000);
  });

  describe('요청 본문과 헤더', () => {
    it('64 KiB까지 JSON 원문을 처리하고 65537 byte는 BAD_REQUEST 413이며 receipt를 만들지 않는다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const fields = { ...common, destination: '/sites/site', mode: 'overwrite', dryRun: true };
      const padTo = (length: number) => {
        const text = JSON.stringify(fields);
        return text + ' '.repeat(length - Buffer.byteLength(text));
      };
      const accepted = await extract(namespaceId, padTo(65536));
      expect(accepted.status).toBe(200);
      const key = randomUUID();
      const rejected = await extract(namespaceId, padTo(65537), key);
      expect(rejected.status).toBe(413);
      expect(rejected.body.code).toBe('BAD_REQUEST');
      expect(await receiptCount(namespaceId, key)).toBe(0);
    }, 60000);

    it('64개 exclude 패턴을 가진 큰 정상 본문도 처리한다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const exclude = Array.from({ length: 63 }, (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(990)}`);
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
        dryRun: true,
        exclude,
      });
      expect(response.status).toBe(200);
      expect(response.body.entryCount).toBe(4);
    }, 60000);

    it('잘못된 JSON·알 수 없는 키·잘못된 revision 형식은 receipt에 저장하는 400이다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const key = randomUUID();
      const bad = await extract(namespaceId, '{not json', key);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('VFS_INVALID_EXTRACT_REQUEST');
      expect(await receiptCount(namespaceId, key)).toBe(1);
      expect((await extract(namespaceId, '{not json', key)).body).toEqual(bad.body);
      const unknown = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
        extra: 1,
      });
      expect(unknown.body.code).toBe('VFS_INVALID_EXTRACT_REQUEST');
      const revision = await extract(namespaceId, {
        ...common,
        sourceRevision: 'bad',
        destination: '/sites/site',
        mode: 'overwrite',
      });
      expect(revision.body.code).toBe('VFS_INVALID_REVISION');
    }, 60000);

    it('Idempotency-Key나 X-Mutation-Scope가 없으면 receipt 없는 400이다', async () => {
      const namespaceId = await ctx.createNamespace();
      const response = await request(ctx.server())
        .post(`${base(namespaceId)}/extract`)
        .set(ctx.headers())
        .set('Content-Type', 'application/json')
        .send('{}');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
    }, 60000);

    it('capability가 꺼져 있으면 receipt 없는 409이고 켜면 같은 key로 실행된다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const spy = jest.spyOn(ctx.capabilities(), 'requireEnabled').mockImplementation(() => {
        throw new VfsFeatureDisabledError('extract');
      });
      try {
        const disabled = await extract(namespaceId, body, key);
        expect(disabled.status).toBe(409);
        expect(disabled.body.code).toBe('VFS_FEATURE_DISABLED');
        expect(await receiptCount(namespaceId, key)).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect((await extract(namespaceId, body, key)).status).toBe(201);
    }, 60000);

    it('gate가 포화이면 Retry-After를 담은 503이고 receipt가 없으며 풀리면 같은 key로 실행된다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const held = ctx.gate().tryAcquire();
      expect(held).not.toBeNull();
      try {
        const busy = await extract(namespaceId, body, key);
        expect(busy.status).toBe(503);
        expect(busy.body.code).toBe('VFS_EXTRACT_BUSY');
        expect(busy.headers['retry-after']).toBe('10');
        expect(await receiptCount(namespaceId, key)).toBe(0);
      } finally {
        held!.release();
      }
      expect((await extract(namespaceId, body, key)).status).toBe(201);
    }, 60000);
  });

  describe('조건 실패와 원자성', () => {
    it('source revision이 다르면 412 current를 담고 대상을 만들지 않으며 오류 재생이 최초 응답과 같다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      await upload(namespaceId, common.source, Buffer.concat([sampleTar(), Buffer.alloc(512)]));
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const first = await extract(namespaceId, body, key);
      expect(first.status).toBe(412);
      expect(first.body).toMatchObject({
        code: 'VFS_PRECONDITION_FAILED',
        path: common.source,
        current: { path: common.source, type: 'FILE', revision: expect.stringMatching(/^r1\./) },
      });
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
      const replay = await extract(namespaceId, body, key);
      expect(replay.body).toEqual(first.body);
    }, 60000);

    it('destinationRevision이 다르면 412이고 대상은 그대로다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      await upload(namespaceId, '/sites/site/keep.txt', Buffer.from('keep'));
      const destination = (await stat(namespaceId, '/sites/site')).body;
      await upload(namespaceId, '/sites/site/other.txt', Buffer.from('changes the revision'));
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'clean',
        destinationRevision: destination.revision,
      });
      expect(response.status).toBe(412);
      expect(response.body).toMatchObject({ code: 'VFS_PRECONDITION_FAILED', path: '/sites/site' });
      expect((await readBytes(namespaceId, '/sites/site/keep.txt')).toString()).toBe('keep');
    }, 60000);

    it('source·destination 종류 오류는 404·409다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      await upload(namespaceId, '/sites/plain.txt', Buffer.from('file'));
      const directorySource = await extract(namespaceId, {
        ...common,
        source: '/sites',
        destination: '/sites/site',
        mode: 'overwrite',
      });
      expect(directorySource.status).toBe(404);
      const fileDestination = await extract(namespaceId, {
        ...common,
        destination: '/sites/plain.txt',
        mode: 'overwrite',
      });
      expect(fileDestination.status).toBe(409);
      expect(fileDestination.body.code).toBe('VFS_NOT_DIRECTORY');
      const missingParent = await extract(namespaceId, {
        ...common,
        destination: '/nowhere/deep/site',
        mode: 'overwrite',
      });
      expect(missingParent.status).toBe(404);
      expect(missingParent.body.path).toBe('/nowhere');
    }, 60000);

    it('종류 충돌은 409에 entry 정보를 담고 앞 entry 반영·올린 object를 모두 되돌리며 재생이 같다', async () => {
      const namespaceId = await ctx.createNamespace();
      await upload(namespaceId, '/sites/site/assets', Buffer.from('not a dir'));
      const archive = buildTar([
        { name: 'first.txt', body: Buffer.from('first') },
        { name: 'assets/app.js', body: Buffer.from('js') },
      ]);
      const common = await prepare(namespaceId, archive);
      const keysBefore = (await ctx.storageKeys()).sort();
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const first = await extract(namespaceId, body, key);
      expect(first.status).toBe(409);
      expect(first.body).toMatchObject({
        code: 'VFS_EXTRACT_TYPE_CONFLICT',
        entryIndex: 1,
        entryName: 'assets/app.js',
        path: '/sites/site/assets',
      });
      expect((await stat(namespaceId, '/sites/site/first.txt')).status).toBe(404);
      expect((await ctx.storageKeys()).sort()).toEqual(keysBefore);
      const blobs = await ctx.dataSource().getRepository(BlobEntity).countBy({ namespaceId });
      expect(blobs).toBe(2);
      const replay = await extract(namespaceId, body, key);
      expect(replay.body).toEqual(first.body);
    }, 60000);

    it('quota를 넘으면 413이고 대상·올린 object가 남지 않는다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const used = (
        await ctx.dataSource().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId })
      ).liveFileByteCount;
      await ctx
        .dataSource()
        .getRepository(NamespaceEntity)
        .update({ id: namespaceId }, { maxTotalLogicalBytes: String(BigInt(String(used)) + 3n) });
      const keysBefore = (await ctx.storageKeys()).sort();
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
      });
      expect(response.status).toBe(413);
      expect(response.body.code).toBe('VFS_QUOTA_EXCEEDED');
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
      expect((await ctx.storageKeys()).sort()).toEqual(keysBefore);
    }, 60000);

    it('뒤쪽 entry가 손상된 archive는 400이고 앞 entry의 object도 남지 않는다', async () => {
      const namespaceId = await ctx.createNamespace();
      const broken = handZip([
        { name: 'first.txt', body: Buffer.from('first') },
        { name: 'late.txt', body: Buffer.from('late'), crc: 1 },
      ]);
      const common = await prepare(namespaceId, broken);
      const keysBefore = (await ctx.storageKeys()).sort();
      const response = await extract(namespaceId, {
        ...common,
        destination: '/sites/site',
        mode: 'overwrite',
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'VFS_EXTRACT_INVALID_ENTRY',
        entryIndex: 1,
        entryName: 'late.txt',
      });
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
      expect((await ctx.storageKeys()).sort()).toEqual(keysBefore);
    }, 60000);

    it('경로 이탈·지원하지 않는 형식·symlink는 receipt에 저장하는 400이다', async () => {
      const namespaceId = await ctx.createNamespace();
      const cases: [Buffer, string][] = [
        [buildTar([{ name: '../evil', body: Buffer.from('x') }]), 'VFS_EXTRACT_INVALID_ENTRY'],
        [buildTar([{ name: 'link', type: '2', linkName: '/etc/passwd' }]), 'VFS_EXTRACT_INVALID_ENTRY'],
        [Buffer.from('BZh91AY&SY' + 'x'.repeat(600)), 'VFS_EXTRACT_UNSUPPORTED_FORMAT'],
        [
          handZip([{ name: 'ln', body: Buffer.from('/etc/passwd'), madeBy: 0x031e, external: 0xa1ff0000 }]),
          'VFS_EXTRACT_INVALID_ENTRY',
        ],
      ];
      for (const [archive, code] of cases) {
        const common = await prepare(namespaceId, archive);
        const key = randomUUID();
        const response = await extract(
          namespaceId,
          { ...common, destination: '/sites/site', mode: 'overwrite' },
          key,
        );
        expect(response.status).toBe(400);
        expect(response.body.code).toBe(code);
        expect(await receiptCount(namespaceId, key)).toBe(1);
      }
      expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
    }, 90000);
  });

  describe('저장소 장애', () => {
    it('두 번째 업로드가 실패하면 500이고 receipt와 대상이 없으며 앞 object는 보존되고 같은 key로 재시도할 수 있다', async () => {
      const namespaceId = await ctx.createNamespace();
      const common = await prepare(namespaceId, sampleTar());
      const key = randomUUID();
      const body = { ...common, destination: '/sites/site', mode: 'overwrite' };
      const storage = ctx.storage();
      const original = storage.put.bind(storage);
      let calls = 0;
      const spy = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error('injected put failure');
        return original(...args);
      });
      const keysBefore = (await ctx.storageKeys()).sort();
      try {
        const failed = await extract(namespaceId, body, key);
        expect(failed.status).toBe(500);
        expect(await receiptCount(namespaceId, key)).toBe(0);
        expect((await stat(namespaceId, '/sites/site')).status).toBe(404);
        // 5xx는 확정 실패가 아니므로 이미 올린 object를 지우지 않고 GC에 맡긴다.
        expect((await ctx.storageKeys()).length).toBe(keysBefore.length + 1);
      } finally {
        spy.mockRestore();
      }
      const retried = await extract(namespaceId, body, key);
      expect(retried.status).toBe(201);
      await expectSampleTree(namespaceId, '/sites/site');
    }, 60000);
  });

  describe('암호화 namespace', () => {
    it.each([
      ['zip', sampleZip],
      ['tar.gz', sampleTarGz],
    ] as const)(
      '%s source를 비블록 경계 range로 읽어 풀고 결과는 평문으로 읽히며 저장 object는 암호문이다',
      async (name, build) => {
        const namespaceId = await ctx.createNamespace({ encrypted: true });
        const archive = build();
        if (name === 'zip') expect(centralDirectoryOffset(archive) % 16).not.toBe(0);
        const common = await prepare(namespaceId, archive);
        const response = await extract(namespaceId, {
          ...common,
          destination: '/sites/site',
          mode: 'overwrite',
        });
        expect(response.status).toBe(201);
        await expectSampleTree(namespaceId, '/sites/site');
        const node = await ctx
          .dataSource()
          .getRepository(VfsNodeEntity)
          .findOneByOrFail({ namespaceId, name: 'index.html' });
        const blob = await ctx.dataSource().getRepository(BlobEntity).findOneByOrFail({ id: node.blobId! });
        expect(blob.encryptionIv).not.toBeNull();
        const chunks: Buffer[] = [];
        for await (const chunk of await ctx.storage().get(blob.storageKey))
          chunks.push(Buffer.from(chunk as Buffer));
        const raw = Buffer.concat(chunks);
        expect(raw.length).toBe(FILES['index.html'].length);
        expect(raw.toString()).not.toBe(FILES['index.html']);
      },
      60000,
    );
  });
}
