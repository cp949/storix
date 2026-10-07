// 소비자 기대: 재개 업로드는 조각을 순서와 무관하게 저장·재전송할 수 있고, 모든 조각이 모인 뒤 완료할 때만 파일이 한 번에 공개되며, 같은 요청의 반복은 최초 결과를 재생하고 생성·완료 시점의 조건이 지켜진다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ApiResponse } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';

interface SessionCreated {
  sessionId: string;
  state: string;
  partSizeBytes: number;
  partCount: number;
}

interface Resource {
  id: string;
  revision: string;
  size: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export default defineContract({
  id: 'upload-session-complete',
  title:
    '재개 업로드는 조각 저장·재전송과 완료로만 파일을 공개하고, 생성·완료의 같은 요청은 최초 결과를 재생하며, 생성·완료 시점의 조건 불일치는 412로 거부한다',
  rq: ['RQ-004', 'RQ-005', 'RQ-008', 'RQ-009', 'RQ-011'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    // 0x00·0xff·비UTF-8을 섞어 본문이 바이트 그대로 보존되는지 본다. 조각 크기에 나누어떨어지지 않게 한다.
    const data = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28, 0x01, 0xfe, 0x10, 0x20]);
    const createBody = {
      path: '/big.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    };

    // 생성: 응답을 못 받았다고 가정하고 같은 키로 다시 보내면 최초 응답을 돌려주고, 다른 요청은 거부한다.
    const key = randomUUID();
    const created = await ctx.client.createUploadSession(ns, createBody, { idempotencyKey: key });
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    assert.equal(session.state, 'OPEN');
    const partSize = session.partSizeBytes;
    assert.ok(partSize > 0 && partSize < data.length, '여러 조각이 되는 정책이어야 한다');
    assert.equal(session.partCount, Math.ceil(data.length / partSize));
    assertReplayed(
      await ctx.client.createUploadSession(ns, createBody, { idempotencyKey: key }),
      created,
      '생성 재전송',
    );
    const reused = await ctx.client.createUploadSession(
      ns,
      { ...createBody, sizeBytes: '11' },
      { idempotencyKey: key },
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.json<{ code: string }>().code, 'MUTATION_KEY_REUSED');

    const piece = (index: number): Buffer => data.subarray(index * partSize, (index + 1) * partSize);
    const complete = async (): Promise<ApiResponse> =>
      ctx.client.completeUploadSession(ns, session.sessionId);

    // 조각이 없거나 모자라면 완료할 수 없고 경로에 파일이 생기지 않는다.
    const noParts = await complete();
    assert.equal(noParts.status, 409);
    assert.equal(noParts.json<{ code: string }>().code, 'VFS_UPLOAD_PARTS_INCOMPLETE');

    // 조각은 순서와 무관하게 저장한다. 같은 조각의 재전송은 replayed, 다른 내용은 409다.
    const last = session.partCount - 1;
    const storedLast = await ctx.client.putUploadPart(ns, session.sessionId, last, piece(last));
    assert.equal(storedLast.status, 200, storedLast.text());
    const { expiresAt, ...partResult } = storedLast.json<Record<string, unknown>>();
    assert.deepEqual(partResult, {
      index: last,
      sizeBytes: String(piece(last).length),
      sha256: sha256(piece(last)),
      replayed: false,
    });
    // 선택 필드: 갱신된 세션 비활동 만료 시각. 최대 수명을 넘지 않는다.
    assert.equal(typeof expiresAt, 'string');
    assert.ok(Number.isFinite(Date.parse(expiresAt as string)));
    assert.ok(
      Date.parse(expiresAt as string) <= Date.parse(created.json<{ maxExpiresAt: string }>().maxExpiresAt),
    );
    const replayedLast = await ctx.client.putUploadPart(ns, session.sessionId, last, piece(last));
    assert.equal(replayedLast.status, 200);
    assert.equal(replayedLast.json<{ replayed: boolean }>().replayed, true);
    const conflicting = await ctx.client.putUploadPart(
      ns,
      session.sessionId,
      last,
      Buffer.alloc(piece(last).length, 0x7a),
    );
    assert.equal(conflicting.status, 409);
    assert.equal(conflicting.json<{ code: string }>().code, 'VFS_UPLOAD_PART_CONFLICT');

    // 마지막이 아닌 조각의 크기가 다르거나 index가 범위를 넘으면 400이고 저장하지 않는다.
    for (const [index, bytes] of [
      [0, piece(0).subarray(0, partSize - 1)],
      [session.partCount, Buffer.alloc(partSize, 0x61)],
    ] as const) {
      const rejected = await ctx.client.putUploadPart(ns, session.sessionId, index, bytes);
      assert.equal(rejected.status, 400, `조각 ${index}: ${rejected.text()}`);
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_UPLOAD_PART', `조각 ${index}`);
    }
    const partial = await complete();
    assert.equal(partial.status, 409);
    assert.equal(partial.json<{ code: string }>().code, 'VFS_UPLOAD_PARTS_INCOMPLETE');
    assert.equal((await ctx.client.getStat(ns, '/big.bin')).status, 404, '완료 전에는 파일이 보이지 않는다');

    for (let index = 0; index < last; index += 1) {
      const stored = await ctx.client.putUploadPart(ns, session.sessionId, index, piece(index));
      assert.equal(stored.status, 200, `조각 ${index}`);
    }
    // 상태는 저장된 조각의 index와 크기만 알리고 내부 저장 정보를 노출하지 않는다.
    const status = await ctx.client.getUploadSession(ns, session.sessionId);
    assert.equal(status.status, 200);
    const state = status.json<{
      state: string;
      path: string;
      sizeBytes: string;
      condition: unknown;
      parts: Array<Record<string, unknown>>;
      staging: { maxStagedBytes: string; status: string };
    }>();
    assert.equal(state.state, 'OPEN');
    assert.equal(state.path, '/big.bin');
    assert.equal(state.sizeBytes, String(data.length));
    assert.deepEqual(state.condition, { ifAbsent: true });
    assert.deepEqual(state.staging, { maxStagedBytes: '1048576', status: 'PARTS_STORED' });
    // 조각 배열의 정렬 순서는 명세에 없어 index로 정렬해 비교한다.
    assert.deepEqual(
      [...state.parts].sort((a, b) => Number(a.index) - Number(b.index)),
      Array.from({ length: session.partCount }, (_, index) => ({
        index,
        sizeBytes: String(piece(index).length),
      })),
    );
    // OPEN 세션 상태는 명세가 정의한 필드만 가진다(`result`·`failure`는 종결 상태에서만 존재한다).
    assert.deepEqual(
      Object.keys(state).sort(),
      [
        'condition',
        'expiresAt',
        'maxExpiresAt',
        'mimeType',
        'partCount',
        'partSizeBytes',
        'parts',
        'path',
        'sessionId',
        'sizeBytes',
        'staging',
        'state',
      ],
      '내부 저장 정보를 노출했다',
    );

    // 완료하면 파일이 한 번에 공개되고 바이트·크기·해시·revision이 맞는다. 반복 완료는 최초 응답을 재생한다.
    const completed = await complete();
    assert.equal(completed.status, 201, completed.text());
    const resource = completed.json<{ resource: Resource }>().resource;
    assert.equal(resource.size, data.length);
    const read = await ctx.client.getContent(ns, '/big.bin');
    assert.deepEqual(read.bytes, data);
    assert.equal(read.headers.get('x-storix-sha256'), sha256(data));
    assert.equal(read.headers.get('x-storix-file-id'), resource.id);
    assert.equal(read.headers.get('x-storix-revision'), resource.revision);
    assertReplayed(await complete(), completed, '완료 재전송');

    // 완료된 세션은 닫혀 있어 조각 추가와 취소가 409다. 생성 재전송은 완료 뒤에도 최초 응답이다.
    const closedPart = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0));
    assert.equal(closedPart.status, 409);
    assert.equal(closedPart.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    const closedCancel = await ctx.client.cancelUploadSession(ns, session.sessionId);
    assert.equal(closedCancel.status, 409);
    assert.equal(closedCancel.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    assertReplayed(
      await ctx.client.createUploadSession(ns, createBody, { idempotencyKey: key }),
      created,
      '완료 뒤 생성 재전송',
    );

    // 0바이트 파일은 조각 없이 완료한다.
    const emptySession = await ctx.client.createUploadSession(ns, {
      path: '/empty.bin',
      sizeBytes: '0',
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    assert.equal(emptySession.status, 201, emptySession.text());
    assert.equal(emptySession.json<SessionCreated>().partCount, 0);
    const emptyDone = await ctx.client.completeUploadSession(
      ns,
      emptySession.json<SessionCreated>().sessionId,
    );
    assert.equal(emptyDone.status, 201, emptyDone.text());
    const emptyRead = await ctx.client.getContent(ns, '/empty.bin');
    assert.equal(emptyRead.bytes.length, 0);
    assert.equal(emptyRead.headers.get('x-storix-sha256'), sha256(Buffer.alloc(0)));

    // 완료 시점의 부재 조건: 세션을 만든 뒤 같은 경로에 다른 파일이 생기면 완료는 412이고 그 파일이 그대로다.
    const lateData = Buffer.from('완료 전에 생긴 파일을 덮으면 안 된다', 'utf-8');
    const raced = await ctx.client.createUploadSession(ns, {
      path: '/raced.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ifAbsent: true,
    });
    const racedId = raced.json<SessionCreated>().sessionId;
    const winner = await ctx.client.putConditionalContent(ns, '/raced.bin', lateData, { ifAbsent: true });
    assert.equal(winner.status, 201);
    for (let index = 0; index < session.partCount; index += 1) {
      assert.equal((await ctx.client.putUploadPart(ns, racedId, index, piece(index))).status, 200);
    }
    const lost = await ctx.client.completeUploadSession(ns, racedId);
    assert.equal(lost.status, 412, lost.text());
    assert.equal(lost.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');
    assert.deepEqual((await ctx.client.getContent(ns, '/raced.bin')).bytes, lateData);

    // revision 조건: 세션을 만든 뒤 파일이 바뀌면 옛 revision 조건의 완료는 412이고, 현재 revision으로 만든 세션은 교체한다.
    const base = await ctx.client.putConditionalContent(ns, '/doc.bin', Buffer.from('v1'), {
      ifAbsent: true,
    });
    const v1 = base.json<{ resource: Resource }>().resource;
    const stale = await ctx.client.createUploadSession(ns, {
      path: '/doc.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ifRevision: v1.revision,
    });
    assert.equal(stale.status, 201, stale.text());
    const staleId = stale.json<SessionCreated>().sessionId;
    const v2Bytes = Buffer.from('v2');
    const v2 = (
      await ctx.client.putConditionalContent(ns, '/doc.bin', v2Bytes, { ifRevision: v1.revision })
    ).json<{ resource: Resource }>().resource;
    for (let index = 0; index < session.partCount; index += 1) {
      assert.equal((await ctx.client.putUploadPart(ns, staleId, index, piece(index))).status, 200);
    }
    const staleDone = await ctx.client.completeUploadSession(ns, staleId);
    assert.equal(staleDone.status, 412, staleDone.text());
    assert.equal(staleDone.json<{ code: string }>().code, 'VFS_PRECONDITION_FAILED');
    const unchanged = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(unchanged.bytes, v2Bytes);
    assert.equal(unchanged.headers.get('x-storix-revision'), v2.revision);

    const fresh = await ctx.client.createUploadSession(ns, {
      path: '/doc.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ifRevision: v2.revision,
    });
    const freshId = fresh.json<SessionCreated>().sessionId;
    for (let index = 0; index < session.partCount; index += 1) {
      assert.equal((await ctx.client.putUploadPart(ns, freshId, index, piece(index))).status, 200);
    }
    const replaced = await ctx.client.completeUploadSession(ns, freshId);
    assert.equal(replaced.status, 200, replaced.text());
    const after = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(after.bytes, data);
    assert.notEqual(after.headers.get('x-storix-revision'), v2.revision);
    assert.equal(after.headers.get('x-storix-file-id'), v1.id, '교체해도 파일 ID는 유지된다');
  },
});
