// 소비자 기대: 재개 업로드에 전체 SHA-256을 지정하면 일치할 때만 파일이 바뀌고, 불일치는 기존 파일과 revision을 그대로 둔 채 422로 종결해 같은 결과를 재생하며 기대값·계산값을 노출하지 않는다.
// 대응 요구사항: RQ-009(원자적 저장), RQ-011(변경 요청의 멱등성), RQ-028(업로드 전체 checksum 검증).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';

interface SessionCreated {
  sessionId: string;
  partSizeBytes: number;
  partCount: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export default defineContract({
  id: 'upload-session-checksum',
  title:
    '재개 업로드의 전체 checksum은 일치할 때만 파일을 바꾸고, 불일치는 기존 파일을 유지한 채 422로 종결해 같은 결과를 재생하며 값을 노출하지 않는다',
  rq: ['RQ-009', 'RQ-011', 'RQ-028'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const data = Buffer.from('전체 checksum으로 검증하는 재개 업로드 내용', 'utf-8');
    const wrong = sha256(Buffer.from('다른 바이트', 'utf-8'));
    const base = (extra: object = {}): object => ({
      path: '/doc.bin',
      sizeBytes: String(data.length),
      mimeType: 'application/octet-stream',
      ...extra,
    });

    const existingBytes = Buffer.from('기존 파일', 'utf-8');
    const existing = await ctx.client.putConditionalContent(ns, '/doc.bin', existingBytes, {
      ifAbsent: true,
    });
    const v1 = existing.json<{ resource: { revision: string } }>().resource;

    // 모든 조각을 올리는 도우미. 조각 크기는 세션 응답을 따른다.
    const upload = async (created: SessionCreated): Promise<void> => {
      for (let index = 0; index < created.partCount; index += 1) {
        const piece = data.subarray(index * created.partSizeBytes, (index + 1) * created.partSizeBytes);
        const stored = await ctx.client.putUploadPart(ns, created.sessionId, index, piece);
        assert.equal(stored.status, 200, `조각 ${index}: ${stored.text()}`);
      }
    };

    // 불일치: 기존 파일을 교체하는 세션에 틀린 checksum을 주면 완료는 422이고 파일·revision이 그대로다.
    const key = randomUUID();
    const createBody = base({ ifRevision: v1.revision, sha256: wrong });
    const created = await ctx.client.createUploadSession(ns, createBody, { idempotencyKey: key });
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    await upload(session);
    const mismatch = await ctx.client.completeUploadSession(ns, session.sessionId);
    assert.equal(mismatch.status, 422, mismatch.text());
    assert.equal(mismatch.json<{ code: string }>().code, 'VFS_CHECKSUM_MISMATCH');
    for (const hidden of [wrong, sha256(data)]) {
      assert.ok(!mismatch.text().includes(hidden), '오류 본문이 기대값 또는 계산값을 노출했다');
    }
    const unchanged = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(unchanged.bytes, existingBytes);
    assert.equal(unchanged.headers.get('x-storix-revision'), v1.revision);

    // 반복 완료는 최초 422 본문과 요청 ID를 재생한다.
    const again = await ctx.client.completeUploadSession(ns, session.sessionId);
    assert.equal(again.status, 422);
    assertReplayed(again, mismatch, '완료 재전송');

    // 상태는 FAILED와 실패 코드만 공개한다.
    const status = await ctx.client.getUploadSession(ns, session.sessionId);
    assert.equal(status.status, 200);
    const state = status.json<{ state: string; failure: unknown }>();
    assert.equal(state.state, 'FAILED');
    assert.deepEqual(state.failure, { code: 'VFS_CHECKSUM_MISMATCH' });
    for (const hidden of [wrong, sha256(data)]) {
      assert.ok(!status.text().includes(hidden), '상태가 기대값 또는 계산값을 노출했다');
    }

    // 종결된 세션은 조각 추가·취소가 409다. 같은 생성 key의 재전송은 최초 201(state OPEN)을 재생한다.
    const closedPart = await ctx.client.putUploadPart(ns, session.sessionId, 0, data.subarray(0, 1));
    assert.equal(closedPart.status, 409);
    assert.equal(closedPart.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    const closedCancel = await ctx.client.cancelUploadSession(ns, session.sessionId);
    assert.equal(closedCancel.status, 409);
    assert.equal(closedCancel.json<{ code: string }>().code, 'VFS_UPLOAD_SESSION_CLOSED');
    const createReplay = await ctx.client.createUploadSession(ns, createBody, { idempotencyKey: key });
    assert.equal(createReplay.status, 201);
    assertReplayed(createReplay, created, '생성 재전송');

    // 같은 key에 checksum만 바꾸면 다른 요청이라 409다. 새 key와 새 세션으로 바이트를 맞춰 다시 올려야 한다.
    const reused = await ctx.client.createUploadSession(
      ns,
      base({ ifRevision: v1.revision, sha256: sha256(data) }),
      { idempotencyKey: key },
    );
    assert.equal(reused.status, 409);
    assert.equal(reused.json<{ code: string }>().code, 'MUTATION_KEY_REUSED');

    // 새 경로에 틀린 checksum으로 올려도 부분 파일이 생기지 않는다.
    const fresh = await ctx.client.createUploadSession(
      ns,
      base({ path: '/new.bin', ifAbsent: true, sha256: wrong }),
    );
    const freshSession = fresh.json<SessionCreated>();
    await upload(freshSession);
    assert.equal((await ctx.client.completeUploadSession(ns, freshSession.sessionId)).status, 422);
    assert.equal((await ctx.client.getStat(ns, '/new.bin')).status, 404);

    // 일치: 바른 checksum의 새 세션은 기존 파일을 교체하고 revision이 바뀐다. checksum을 생략한 세션도 처리된다.
    const good = await ctx.client.createUploadSession(
      ns,
      base({ ifRevision: v1.revision, sha256: sha256(data) }),
    );
    assert.equal(good.status, 201, good.text());
    const goodSession = good.json<SessionCreated>();
    await upload(goodSession);
    const done = await ctx.client.completeUploadSession(ns, goodSession.sessionId);
    assert.equal(done.status, 200, done.text());
    const replaced = await ctx.client.getContent(ns, '/doc.bin');
    assert.deepEqual(replaced.bytes, data);
    assert.equal(replaced.headers.get('x-storix-sha256'), sha256(data));
    assert.notEqual(replaced.headers.get('x-storix-revision'), v1.revision);

    const plain = await ctx.client.createUploadSession(ns, base({ path: '/plain.bin', ifAbsent: true }));
    const plainSession = plain.json<SessionCreated>();
    await upload(plainSession);
    assert.equal((await ctx.client.completeUploadSession(ns, plainSession.sessionId)).status, 201);

    // 형식이 잘못된 checksum은 세션을 만들기 전에 400이다. 대문자·짧은 값·비hex·긴 값이 모두 거부된다.
    const malformed = ['A'.repeat(64), 'abc', 'g'.repeat(64), 'a'.repeat(65)];
    for (const value of malformed) {
      const rejected = await ctx.client.createUploadSession(
        ns,
        base({ path: '/bad.bin', ifAbsent: true, sha256: value }),
      );
      assert.equal(rejected.status, 400, `${value.slice(0, 8)}: ${rejected.text()}`);
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_CHECKSUM', value.slice(0, 8));
    }
    assert.equal((await ctx.client.getStat(ns, '/bad.bin')).status, 404);
  },
});
