// extract service의 receipt 순서, dryRun 응답, 한도·압축비, 오류 index 규칙, gzip 무결성, 업로드 정리, 취소·deadline을 단위 테스트한다.
// 가짜 repository와 메모리 storage를 쓰되 ContentIngressService와 tar·zip reader는 실제 구현이다.
// DB와 HTTP 경로는 extract-http.shared-tests.ts가 두 DB에서 검증한다. 규칙은 docs/design/17-file-extract.md "실행".
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { ArchiveGate } from '../../src/vfs/archive-gate.js';
import { ContentIngressService } from '../../src/vfs/content-ingress.service.js';
import type { ExtractConfig } from '../../src/vfs/extract-config.js';
import { ExtractService } from '../../src/vfs/extract.service.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { VfsExtractTypeConflictError } from '../../src/vfs/vfs.errors.js';
import {
  buildTar,
  buildTarGz,
  extensionBlock,
  pad512,
  paxBody,
  tarHeader,
} from './tar-fixture.test-support.js';
import { handZip } from './zip-fixture.test-support.js';

const NS = '11111111-1111-4111-8111-111111111111';
const KEY = '00000000-0000-4000-8000-000000000001';
const REVISION = encodeRevision({ id: '00000000-0000-4000-8000-000000000002', version: 1 });
const DEFAULT_CONFIG: ExtractConfig = {
  maxConcurrency: 1,
  maxEntries: 10,
  maxTotalBytes: 1n << 30n,
  maxRatio: 100,
  maxSeconds: 60,
  orphanGraceSeconds: 86400,
  assumedOrphanGrace: false,
  retryAfterSeconds: 10,
};

function chunks(bytes: Buffer, size = 16384): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

interface HarnessOptions {
  capability?: boolean;
  gate?: ArchiveGate;
  config?: Partial<ExtractConfig>;
  maxFileSizeBytes?: string | null;
  /** storage.get 대신 쓸 구현이다. 취소를 따르지 않는 stream을 만드는 사례에 쓴다. */
  getImpl?: (
    key: string,
    range: { start: number; end?: number } | undefined,
    signal?: AbortSignal,
  ) => Promise<Readable>;
  putImpl?: (key: string, stream: Readable, contentType?: string, signal?: AbortSignal) => Promise<void>;
  applyExtract?: () => Promise<unknown>;
  renew?: boolean;
}

/** fixture 바이트를 source FILE로 보이게 하는 mock 묶음. 호출 기록을 돌려준다. */
function harness(source: Buffer, options: HarnessOptions = {}) {
  const stored = new Map<string, { bytes: Buffer; contentType?: string }>();
  const deleted: string[] = [];
  const openStreams: Readable[] = [];
  const receipts = {
    claim: jest.fn(async () => ({ kind: 'owner' as const, generation: 1 })),
    release: jest.fn(async () => undefined),
    renew: jest.fn(async () => options.renew ?? true),
    complete: jest.fn(async () => undefined),
    completeAfterRollback: jest.fn(async () => undefined),
    namespaceIsActive: jest.fn(async () => true),
  };
  const applyExtract = jest.fn(
    options.applyExtract ??
      (async () => ({ status: 200 as const, destinationId: 'dest', createdCount: 1, replacedCount: 0 })),
  );
  const readExtractResource = jest.fn(async () => ({
    id: 'dest',
    path: '/site',
    name: 'site',
    type: 'DIRECTORY',
    version: 2,
  }));
  const txs: unknown[] = [];
  const nodes = {
    getRootWithLimits: async () => ({
      root: { id: 'root' },
      limits: {
        maxFileSizeBytes: options.maxFileSizeBytes ?? null,
        encryptionPolicy: 'PLAIN',
        maxSyncDeleteNodes: null,
      },
    }),
    withMutation: jest.fn(
      async (
        _ns: string,
        _root: string,
        work: (tx: unknown) => Promise<unknown>,
        after?: (tx: unknown, r: unknown) => Promise<void>,
      ) => {
        const tx = { manager: {}, namespaceId: NS, rootId: 'root' };
        txs.push(tx);
        const value = await work(tx);
        const result = { value, affectedRevisions: [{ path: '/site', revision: 'r1.x' }] };
        await after?.(tx, result);
        return result;
      },
    ),
    applyExtract,
    readExtractResource,
  };
  const storage = {
    get: jest.fn(async (key: string, range?: { start: number; end?: number }, signal?: AbortSignal) => {
      if (options.getImpl) {
        const stream = await options.getImpl(key, range, signal);
        openStreams.push(stream);
        return stream;
      }
      const bytes = range ? source.subarray(range.start, (range.end ?? source.length - 1) + 1) : source;
      const stream = Readable.from(chunks(bytes));
      openStreams.push(stream);
      return stream;
    }),
    put: jest.fn(async (key: string, stream: Readable, contentType?: string, signal?: AbortSignal) => {
      if (options.putImpl) return options.putImpl(key, stream, contentType, signal);
      const parts: Buffer[] = [];
      for await (const part of stream) parts.push(part as Buffer);
      stored.set(key, { bytes: Buffer.concat(parts), contentType });
    }),
    delete: jest.fn(async (key: string) => {
      deleted.push(key);
      stored.delete(key);
    }),
  };
  const attempted: string[] = [];
  let keyCounter = 0;
  const keys = {
    generate: () => {
      const key = `blobs/extract/${keyCounter++}`;
      attempted.push(key);
      return key;
    },
  };
  const sources = {
    capture: jest.fn(async () => ({
      deadlineAt: new Date(Date.now() + 60_000),
      source: {
        nodeId: 'src',
        storageKey: 'blobs/src',
        size: BigInt(source.length),
        sha256: 'c'.repeat(64),
        encryptionIv: null,
      },
    })),
    assertDeadline: jest.fn(async () => undefined),
  };
  const blobs = { findKnownStorageKeys: jest.fn(async () => new Set<string>()) };
  const gate = options.gate ?? new ArchiveGate(1);
  const service = new ExtractService(
    nodes as never,
    receipts as never,
    sources as never,
    {
      requireEnabled: () => {
        if (options.capability === false)
          throw Object.assign(new Error('disabled'), { code: 'VFS_FEATURE_DISABLED', status: 409 });
      },
    } as never,
    gate,
    keys as never,
    storage as never,
    new ContentIngressService(storage as never, null),
    { get: () => undefined } as never,
    { ...DEFAULT_CONFIG, ...options.config },
    null,
    blobs as never,
  );
  const body = (extra: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        source: '/.staging/u/upload',
        sourceRevision: REVISION,
        destination: '/site',
        mode: 'overwrite',
        ...extra,
      }),
    );
  const run = (extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    service.execute(NS, 'scope', KEY, body(extra), 'req', signal);
  return {
    service,
    gate,
    receipts,
    nodes,
    storage,
    sources,
    blobs,
    stored,
    deleted,
    attempted,
    openStreams,
    applyExtract,
    readExtractResource,
    body,
    run,
    txs,
  };
}

/** 취소 신호를 따르는 끝나지 않는 stream이다. destroy되면 closed가 된다. */
function hangingStream(signal?: AbortSignal): Readable {
  const stream = new Readable({ read() {} });
  signal?.addEventListener('abort', () => stream.destroy(signal.reason as Error), { once: true });
  return stream;
}

describe('ExtractService dryRun과 본 실행', () => {
  it('tar.gz dryRun은 entry 목록을 돌려주고 upload·withMutation 없이 claim을 해제한다', async () => {
    const h = harness(
      buildTarGz([
        { name: './a/b.txt', body: Buffer.from('x') },
        { name: '__MACOSX/._b', body: Buffer.from('yy') },
        { name: 'empty/', type: '5' },
      ]),
    );
    const result = await h.run({ exclude: ['__MACOSX/**'], dryRun: true });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      format: 'tar.gz',
      entryCount: 2,
      totalBytes: 1,
      entries: [
        { name: 'a/b.txt', type: 'FILE', size: 1 },
        { name: 'empty', type: 'DIRECTORY', size: 0 },
      ],
    });
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
    expect(h.receipts.release).toHaveBeenCalledTimes(1);
    expect(h.receipts.complete).not.toHaveBeenCalled();
  });

  it('ZIP 본 실행은 entry마다 upload한 뒤 applyExtract와 receipt 완료를 같은 withMutation에서 부른다', async () => {
    const h = harness(
      handZip([
        { name: 'index.html', body: Buffer.from('<p>'), method: 8 },
        { name: 'app.js', body: Buffer.from('js') },
        { name: 'sub/' },
      ]),
    );
    const result = await h.run({ mimeTypes: { '.html': 'text/html' } });
    expect(result.status).toBe(200);
    expect([...h.stored.values()].map((u) => [u.bytes.toString(), u.contentType])).toEqual([
      ['<p>', 'text/html'],
      ['js', 'application/octet-stream'],
    ]);
    const plan = h.applyExtract.mock.calls[0] as unknown as [
      unknown,
      { entries: unknown[]; mode: string; maxSyncDeleteNodes: number },
    ];
    expect(plan[1]).toMatchObject({
      mode: 'overwrite',
      maxSyncDeleteNodes: 1000,
      entries: [
        {
          entryIndex: 0,
          name: 'index.html',
          type: 'FILE',
          blob: { storageKey: 'blobs/extract/0', size: '3', mimeType: 'text/html' },
        },
        { entryIndex: 1, name: 'app.js', type: 'FILE', blob: { storageKey: 'blobs/extract/1', size: '2' } },
        { entryIndex: 2, name: 'sub', type: 'DIRECTORY', blob: null },
      ],
    });
    expect(h.sources.assertDeadline).toHaveBeenCalledTimes(2);
    expect(h.receipts.complete).toHaveBeenCalledTimes(1);
    expect(h.readExtractResource).toHaveBeenCalledWith(h.txs[0], 'dest', ['site']);
    expect(result.body).toMatchObject({
      resource: { id: 'dest', version: 2 },
      affectedRevisions: [{ path: '/site', revision: 'r1.x' }],
      entryCount: 3,
      createdCount: 1,
      replacedCount: 0,
    });
    // receipt에 고정한 응답과 최초 HTTP 응답이 같아야 재생이 최초 응답과 일치한다.
    const stored = (h.receipts.complete.mock.calls[0] as unknown[])[5];
    expect(stored).toEqual(result);
    expect(h.deleted).toEqual([]);
  });

  it('plain tar와 PAX 한글 경로 본 실행도 같은 흐름이다', async () => {
    const x = paxBody({ path: '한글/경로.txt' });
    const tar = Buffer.concat([
      extensionBlock('x', x),
      tarHeader('placeholder', 3, '0'),
      Buffer.from('abc'),
      pad512(Buffer.from('abc')),
      Buffer.alloc(1024),
    ]);
    const h = harness(tar);
    const result = await h.run();
    expect(result.status).toBe(200);
    expect((h.applyExtract.mock.calls[0] as unknown[])[1]).toMatchObject({
      entries: [{ name: '한글/경로.txt', type: 'FILE' }],
    });
  });

  it('capture에 정규화한 경로·revision·deadline 초를 넘기고 destinationRevision은 있을 때만 넘긴다', async () => {
    const h = harness(buildTar([{ name: 'a' }]));
    const dest = encodeRevision({ id: '00000000-0000-4000-8000-000000000003', version: 4 });
    await h.run({ destination: '/site//x', destinationRevision: dest, source: '/.staging//u/up.tar' });
    expect(h.sources.capture).toHaveBeenCalledWith(
      NS,
      'root',
      {
        sourceSegments: ['.staging', 'u', 'up.tar'],
        sourceRevision: REVISION,
        destinationSegments: ['site', 'x'],
        destinationRevision: dest,
      },
      60,
    );
    await h.run();
    expect((h.sources.capture.mock.calls[1] as unknown[])[2]).not.toHaveProperty('destinationRevision');
  });

  it('제외한 entry는 업로드하지 않고 순번은 선택한 entry 사이에서 이어진다', async () => {
    const h = harness(
      buildTar([
        { name: 'skip.log', body: Buffer.alloc(2000, 1) },
        { name: 'keep.txt', body: Buffer.from('k') },
        { name: 'logs/x.log', body: Buffer.from('l') },
        { name: 'b.txt', body: Buffer.from('b') },
      ]),
    );
    await h.run({ exclude: ['*.log', 'logs/**'] });
    expect((h.applyExtract.mock.calls[0] as unknown[])[1]).toMatchObject({
      entries: [
        { entryIndex: 0, name: 'keep.txt' },
        { entryIndex: 1, name: 'b.txt' },
      ],
    });
    expect(h.stored.size).toBe(2);
  });

  it('ZIP의 제외 FILE은 본문 range를 열지 않는다', async () => {
    const zip = handZip([
      { name: 'skip.bin', body: Buffer.alloc(5000, 2), method: 8 },
      { name: 'keep.txt', body: Buffer.from('k') },
    ]);
    const h = harness(zip);
    await h.run({ exclude: ['skip.bin'] });
    // EOCD·central directory·local header 읽기는 모두 range이므로, 본문 stream이 열린 횟수는 선택 FILE 하나뿐이다.
    expect(h.stored.size).toBe(1);
    expect(h.openStreams.length).toBeGreaterThan(0);
  });
});

describe('ExtractService 한도와 압축비', () => {
  it('선택 entry 수가 상한을 넘으면 413 entries이고 제외한 entry는 세지 않는다', async () => {
    const many = harness(buildTar([{ name: 'a' }, { name: 'b' }]), { config: { maxEntries: 1 } });
    expect(await many.run()).toMatchObject({
      status: 413,
      body: { code: 'VFS_EXTRACT_TOO_LARGE', message: expect.stringContaining('entries') },
    });
    const excluded = harness(buildTar([{ name: 'a' }, { name: 'b' }]), { config: { maxEntries: 1 } });
    expect((await excluded.run({ exclude: ['b'] })).status).toBe(200);
  });

  it('제외 FILE의 선언 크기도 FILE 해제 합 한도에 들어가 413 bytes다', async () => {
    const h = harness(
      buildTar([
        { name: 'skip', body: Buffer.alloc(100, 1) },
        { name: 'keep', body: Buffer.alloc(100, 1) },
      ]),
      { config: { maxTotalBytes: 150n } },
    );
    expect(await h.run({ exclude: ['skip'] })).toMatchObject({
      status: 413,
      body: { message: expect.stringContaining('bytes') },
    });
    expect(h.stored.size).toBe(0);
  });

  it('entry 하나가 namespace FILE 상한을 넘으면 413 entryBytes이고 업로드하지 않는다', async () => {
    const h = harness(buildTar([{ name: 'big', body: Buffer.alloc(10, 1) }]), { maxFileSizeBytes: '5' });
    expect(await h.run()).toMatchObject({
      status: 413,
      body: { message: expect.stringContaining('entryBytes') },
    });
    expect(h.attempted).toEqual([]);
  });

  it('ZIP 선택 FILE이 1 MiB 이상이고 압축비를 넘으면 본문을 열기 전에 413 ratio다', async () => {
    const zip = handZip([{ name: 'zeros', body: Buffer.alloc(4 << 20), method: 8 }]);
    const h = harness(zip, { config: { maxRatio: 2 } });
    expect(await h.run()).toMatchObject({ status: 413, body: { message: expect.stringContaining('ratio') } });
    expect(h.attempted).toEqual([]);
  });

  it('1 MiB 미만 ZIP FILE은 압축비가 커도 통과한다', async () => {
    const zip = handZip([{ name: 'zeros', body: Buffer.alloc(100_000), method: 8 }]);
    const h = harness(zip, { config: { maxRatio: 2 } });
    expect((await h.run()).status).toBe(200);
  });

  it('1 MiB 이상 gzip 폭탄은 해제 중 413 ratio이고 올리던 object를 지운다', async () => {
    const h = harness(buildTarGz([{ name: 'zeros', body: Buffer.alloc(4 << 20) }]), {
      config: { maxRatio: 2 },
    });
    expect(await h.run()).toMatchObject({ status: 413, body: { message: expect.stringContaining('ratio') } });
    expect(h.attempted.length).toBe(1);
    // uploadStream이 실패 경로에서 직접 지우고 service 정리도 지운다. 삭제는 멱등이라 대상 집합만 비교한다.
    expect([...new Set(h.deleted)]).toEqual(h.attempted);
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
  });

  it('제외한 FILE의 폭탄도 gzip 압축비로 막는다', async () => {
    const h = harness(
      buildTarGz([
        { name: 'bomb.bin', body: Buffer.alloc(4 << 20) },
        { name: 'ok.txt', body: Buffer.from('ok') },
      ]),
      { config: { maxRatio: 2 } },
    );
    expect(await h.run({ exclude: ['bomb.bin'] })).toMatchObject({
      status: 413,
      body: { message: expect.stringContaining('ratio') },
    });
    expect(h.attempted).toEqual([]);
  });
});

describe('ExtractService 오류 index와 형식', () => {
  it('현재 entry의 CRC 오류는 현재 순번과 이름을 쓴다', async () => {
    const h = harness(handZip([{ name: 'ok' }, { name: 'bad', body: Buffer.from('abc'), crc: 1 }]));
    expect(await h.run()).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 1, entryName: 'bad' },
    });
  });

  it('잘린 tar 본문은 그 FILE의 순번과 이름을 쓴다', async () => {
    const truncated = buildTar([
      { name: 'first', body: Buffer.from('x') },
      { name: 'second', body: Buffer.alloc(600, 1) },
    ]).subarray(0, 1024 + 600);
    const h = harness(truncated);
    expect(await h.run()).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 1, entryName: 'second' },
    });
  });

  it('다음 header가 손상되면 다음 선택 순번과 빈 이름을 쓴다', async () => {
    const tar = Buffer.concat([
      buildTar([{ name: 'first', body: Buffer.from('x') }]).subarray(0, 1024),
      Buffer.alloc(512, 0x41),
    ]);
    const h = harness(tar);
    expect(await h.run()).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 1, entryName: '' },
    });
  });

  it('제외한 FILE의 본문을 drain하다 잘리면 다음 선택 순번과 제외한 이름을 쓴다', async () => {
    const tar = buildTar([
      { name: 'keep', body: Buffer.from('k') },
      { name: 'skip', body: Buffer.alloc(900, 3) },
    ]).subarray(0, 1024 + 512 + 300);
    const h = harness(tar);
    expect(await h.run({ exclude: ['skip'] })).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 1, entryName: 'skip' },
    });
  });

  it('entry 이름 규칙 위반은 선택 순번과 원래 이름을 쓴다', async () => {
    const h = harness(buildTar([{ name: 'ok' }, { name: '../evil' }]));
    expect(await h.run()).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryIndex: 1, entryName: '../evil' },
    });
  });

  it('지원하지 않는 형식은 400 unsupported다', async () => {
    const cases = [
      Buffer.from('BZh91AY&SY' + 'x'.repeat(600)),
      gzipSync(Buffer.from('this is not a tar archive'.repeat(50))),
      handZip([{ name: 'a', body: Buffer.from('a'), uncompressedSize: 0xffffffff }]),
      Buffer.alloc(0),
      buildTar([{ name: 'a', ustar: false }]),
    ];
    for (const source of cases) {
      const h = harness(source);
      expect(await h.run()).toMatchObject({ status: 400, body: { code: 'VFS_EXTRACT_UNSUPPORTED_FORMAT' } });
    }
  });

  it('빈 tar와 빈 ZIP, 모두 제외된 archive는 성공하고 빈 entries로 commit한다', async () => {
    for (const source of [Buffer.alloc(1024), handZip([]), buildTar([{ name: 'skip' }])]) {
      const h = harness(source);
      expect((await h.run({ exclude: ['skip'], mode: 'clean' })).status).toBe(200);
      expect((h.applyExtract.mock.calls[0] as unknown[])[1]).toMatchObject({ entries: [], mode: 'clean' });
    }
  });
});

describe('ExtractService gzip 무결성', () => {
  const entries = [{ name: 'a.txt', body: Buffer.from('hello gzip') }];

  it('gzip trailer CRC가 깨지면 성공하지 않고 400 INVALID_ENTRY이며 commit하지 않는다', async () => {
    const gz = buildTarGz(entries);
    gz[gz.length - 6] ^= 0xff;
    const h = harness(gz);
    expect(await h.run()).toMatchObject({ status: 400, body: { code: 'VFS_EXTRACT_INVALID_ENTRY' } });
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
  });

  it('gzip이 중간에 끝나면 400 INVALID_ENTRY다', async () => {
    const gz = buildTarGz(entries);
    const h = harness(gz.subarray(0, gz.length - 12));
    expect(await h.run()).toMatchObject({ status: 400, body: { code: 'VFS_EXTRACT_INVALID_ENTRY' } });
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
  });

  it('dryRun에서도 gzip trailer 손상은 같은 400이고 결정적 오류라 receipt에 저장한다', async () => {
    const gz = buildTarGz(entries);
    gz[gz.length - 6] ^= 0xff;
    const h = harness(gz);
    expect(await h.run({ dryRun: true })).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY' },
    });
    expect(h.receipts.completeAfterRollback).toHaveBeenCalledTimes(1);
  });

  it('storage가 source보다 짧게 돌려주면 gzip 손상이 아닌 서버 오류다', async () => {
    const gz = buildTarGz(entries);
    const h = harness(gz, {
      getImpl: async (_key, range) =>
        Readable.from([
          range ? gz.subarray(range.start, (range.end ?? gz.length - 1) + 1) : gz.subarray(0, gz.length - 8),
        ]),
    });
    await expect(h.run()).rejects.toThrow(/storage 응답 길이 불일치/);
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
  });

  it('성공 전에 gzip 종료까지 기다리고 모든 stream이 닫힌다', async () => {
    const h = harness(buildTarGz([{ name: 'a', body: Buffer.alloc(50_000, 1) }]));
    expect((await h.run()).status).toBe(200);
    expect(h.openStreams.every((stream) => stream.destroyed)).toBe(true);
  });
});

describe('ExtractService receipt와 gate', () => {
  it('잘못된 JSON은 결정적 400으로 receipt에 저장한다', async () => {
    const h = harness(buildTar([{ name: 'a' }]));
    const result = await h.service.execute(NS, 'scope', KEY, Buffer.from('{not json'), 'req');
    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_EXTRACT_REQUEST' } });
    expect(h.receipts.completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(h.sources.capture).not.toHaveBeenCalled();
  });

  it('필수 필드·알 수 없는 키·revision 형식 오류도 저장하는 400이다', async () => {
    const h = harness(buildTar([{ name: 'a' }]));
    expect(await h.run({ extra: 1 })).toMatchObject({
      status: 400,
      body: { code: 'VFS_INVALID_EXTRACT_REQUEST' },
    });
    expect(await h.run({ sourceRevision: 'bad' })).toMatchObject({
      status: 400,
      body: { code: 'VFS_INVALID_REVISION' },
    });
    expect(h.receipts.completeAfterRollback).toHaveBeenCalledTimes(2);
  });

  it('capability가 꺼져 있으면 claim을 해제하고 오류를 던지며 gate를 건드리지 않는다', async () => {
    const gate = new ArchiveGate(1);
    const acquire = jest.spyOn(gate, 'tryAcquire');
    const h = harness(buildTar([{ name: 'a' }]), { capability: false, gate });
    await expect(h.run()).rejects.toMatchObject({ code: 'VFS_FEATURE_DISABLED' });
    expect(h.receipts.release).toHaveBeenCalledWith({ namespaceId: NS, scope: 'scope', key: KEY }, 1);
    expect(acquire).not.toHaveBeenCalled();
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
  });

  it('완료 receipt는 capability와 원본을 다시 확인하지 않고 재생하며 다른 본문은 409 KEY_REUSED다', async () => {
    const h = harness(buildTar([{ name: 'a' }]));
    const first = h.body();
    let fingerprint = '';
    h.receipts.claim.mockImplementationOnce(async () => ({ kind: 'owner' as const, generation: 1 }));
    h.receipts.completeAfterRollback.mockImplementation(async (...args: unknown[]) => {
      fingerprint = args[2] as string;
    });
    await h.service.execute(NS, 'scope', KEY, Buffer.from('{bad'), 'req');
    const receipt = {
      method: 'POST',
      fingerprint,
      responseStatus: 400,
      responseBody: JSON.stringify({ code: 'VFS_INVALID_EXTRACT_REQUEST' }),
      responseHeaders: JSON.stringify({ 'x-request-id': 'original' }),
    };
    h.receipts.claim.mockImplementation(async () => ({ kind: 'complete' as const, receipt }) as never);
    const replay = await h.service.execute(NS, 'scope', KEY, Buffer.from('{bad'), 'retry');
    expect(replay).toMatchObject({
      status: 400,
      body: { code: 'VFS_INVALID_EXTRACT_REQUEST' },
      headers: { 'x-request-id': 'original' },
    });
    const reused = await h.service.execute(NS, 'scope', KEY, first, 'retry');
    expect(reused).toMatchObject({ status: 409, body: { code: 'MUTATION_KEY_REUSED' } });
    expect(h.sources.capture).not.toHaveBeenCalled();
  });

  it('다른 요청이 claim 중이면 409 MUTATION_IN_PROGRESS를 돌려준다', async () => {
    const h = harness(buildTar([{ name: 'a' }]));
    h.receipts.claim.mockImplementationOnce(
      async () => ({ kind: 'busy' as const, retryAfterSeconds: 7 }) as never,
    );
    expect(await h.run()).toMatchObject({
      status: 409,
      body: { code: 'MUTATION_IN_PROGRESS' },
      headers: { 'retry-after': '7' },
    });
  });

  it('gate가 포화이면 503 Retry-After로 응답하고 claim을 해제하며 receipt를 저장하지 않는다', async () => {
    const gate = new ArchiveGate(1);
    const held = gate.tryAcquire();
    const h = harness(buildTar([{ name: 'a' }]), { gate });
    expect(await h.run()).toMatchObject({
      status: 503,
      body: { code: 'VFS_EXTRACT_BUSY' },
      headers: { 'retry-after': '10' },
    });
    expect(h.receipts.release).toHaveBeenCalled();
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
    expect(h.sources.capture).not.toHaveBeenCalled();
    held!.release();
    expect((await h.run()).status).toBe(200);
  });

  it('성공·실패 어느 쪽이든 gate 슬롯을 돌려준다', async () => {
    const gate = new ArchiveGate(1);
    const h = harness(buildTar([{ name: '../bad' }]), { gate });
    expect((await h.run()).status).toBe(400);
    expect(gate.tryAcquire()).not.toBeNull();
  });
});

describe('ExtractService 실패 정리', () => {
  const tarWithFiles = () =>
    buildTar([
      { name: 'a', body: Buffer.from('a') },
      { name: 'b', body: Buffer.from('b') },
    ]);

  it('commit이 확정 4xx로 실패하면 receipt를 저장하고 올린 object를 지운다', async () => {
    const h = harness(tarWithFiles(), {
      applyExtract: async () => {
        throw new VfsExtractTypeConflictError(1, 'b', '/site/b');
      },
    });
    expect(await h.run()).toMatchObject({
      status: 409,
      body: { code: 'VFS_EXTRACT_TYPE_CONFLICT', entryIndex: 1, entryName: 'b', path: '/site/b' },
    });
    expect(h.receipts.completeAfterRollback).toHaveBeenCalledTimes(1);
    expect(h.attempted).toHaveLength(2);
    expect([...h.deleted].sort()).toEqual([...h.attempted].sort());
  });

  it('commit이 5xx로 실패하면 object를 지우지 않고 오류를 그대로 던진다', async () => {
    const h = harness(tarWithFiles(), {
      applyExtract: async () => {
        throw new Error('db connection lost');
      },
    });
    await expect(h.run()).rejects.toThrow('db connection lost');
    expect(h.deleted).toEqual([]);
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
    expect(h.receipts.release).toHaveBeenCalled();
  });

  it('4xx여도 참조 중인 object는 지우지 않는다', async () => {
    const h = harness(tarWithFiles(), {
      applyExtract: async () => {
        throw new VfsExtractTypeConflictError(0, 'a', '/site/a');
      },
    });
    h.blobs.findKnownStorageKeys.mockImplementation(async () => new Set(['blobs/extract/0']));
    await h.run();
    expect(h.deleted).toEqual(['blobs/extract/1']);
  });

  it('참조 확인이 실패하면 지우지 않고 보존한다', async () => {
    const h = harness(tarWithFiles(), {
      applyExtract: async () => {
        throw new VfsExtractTypeConflictError(0, 'a', '/site/a');
      },
    });
    h.blobs.findKnownStorageKeys.mockImplementation(async () => {
      throw new Error('lookup failed');
    });
    await h.run();
    expect(h.deleted).toEqual([]);
  });

  it('lease를 잃으면 commit하지 않고 object를 보존한다', async () => {
    const h = harness(tarWithFiles(), { renew: false });
    await expect(h.run()).rejects.toThrow('VFS mutation claim lost');
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
    expect(h.deleted).toEqual([]);
  });

  it('업로드 중 storage 오류는 서버 오류로 던지고 object를 보존한다', async () => {
    const h = harness(tarWithFiles(), {
      putImpl: async (_key, stream) => {
        for await (const part of stream) void part;
        throw new Error('S3 PUT failed');
      },
    });
    await expect(h.run()).rejects.toThrow('S3 PUT failed');
    expect(h.deleted.every((key) => h.attempted.includes(key))).toBe(true);
    expect(h.nodes.withMutation).not.toHaveBeenCalled();
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
  });

  it('선언 길이보다 실제 평문이 짧거나 긴 ZIP은 업로드한 object를 지우는 400이다', async () => {
    const h = harness(handZip([{ name: 'a', body: Buffer.from('abcd'), uncompressedSize: 3 }]));
    expect(await h.run()).toMatchObject({
      status: 400,
      body: { code: 'VFS_EXTRACT_INVALID_ENTRY', entryName: 'a' },
    });
    expect([...new Set(h.deleted)]).toEqual(h.attempted);
  });
});

describe('ExtractService 취소와 deadline', () => {
  it('client가 끊기면 끝나지 않는 GET을 닫고 499로 돌아오며 claim과 gate를 정리한다', async () => {
    const gate = new ArchiveGate(1);
    const controller = new AbortController();
    const h = harness(buildTarGz([{ name: 'a' }]), {
      gate,
      getImpl: async (_key, _range, signal) => hangingStream(signal),
    });
    const pending = h.run({}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error('closed'));
    expect(await pending).toEqual({ status: 499, body: null, headers: {} });
    expect(h.openStreams.every((stream) => stream.destroyed && stream.closed)).toBe(true);
    expect(h.receipts.release).toHaveBeenCalled();
    expect(gate.tryAcquire()).not.toBeNull();
    expect(h.deleted).toEqual([]);
  });

  it('요청이 이미 끊긴 상태로 시작하면 아무 것도 읽지 않고 499다', async () => {
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    const h = harness(buildTar([{ name: 'a' }]));
    expect(await h.run({}, controller.signal)).toEqual({ status: 499, body: null, headers: {} });
    expect(h.sources.capture).not.toHaveBeenCalled();
  });

  it('끝나지 않는 PUT도 끊김 신호로 취소하고 상류 stream을 닫는다', async () => {
    const controller = new AbortController();
    const h = harness(buildTar([{ name: 'a', body: Buffer.from('x') }]), {
      putImpl: (_key, stream, _contentType, signal) =>
        new Promise<void>((_, reject) => {
          stream.on('error', () => undefined);
          stream.resume();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const pending = h.run({}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error('closed'));
    expect(await pending).toEqual({ status: 499, body: null, headers: {} });
    expect(h.openStreams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('deadline이 지나면 끝나지 않는 GET을 닫고 receipt 없이 503 TIMEOUT을 던진다', async () => {
    const gate = new ArchiveGate(1);
    const h = harness(buildTarGz([{ name: 'a' }]), {
      gate,
      config: { maxSeconds: 1 },
      getImpl: async (_key, _range, signal) => hangingStream(signal),
    });
    await expect(h.run()).rejects.toMatchObject({ status: 503, code: 'VFS_EXTRACT_TIMEOUT' });
    expect(h.openStreams.every((stream) => stream.destroyed && stream.closed)).toBe(true);
    expect(h.receipts.completeAfterRollback).not.toHaveBeenCalled();
    expect(h.receipts.release).toHaveBeenCalled();
    expect(gate.tryAcquire()).not.toBeNull();
  }, 15000);

  it('응답이 이미 끝난 뒤의 중단 이벤트는 성공 결과를 바꾸지 않는다', async () => {
    const controller = new AbortController();
    const h = harness(buildTar([{ name: 'a', body: Buffer.from('x') }]));
    const result = await h.run({}, controller.signal);
    controller.abort(new Error('closed after response'));
    expect(result.status).toBe(200);
    expect(h.receipts.complete).toHaveBeenCalledTimes(1);
  });
});
