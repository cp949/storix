// 조각 SHA-256 헤더가 본문과 다르면 저장 전에 422로 거부한다.
// 같은 index를 올바른 내용으로 재전송할 수 있다. 재전송에서도 헤더 불일치를 먼저 판정한다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

interface SessionCreated {
  /** 발급된 업로드 세션 ID. */
  sessionId: string;

  /** 새 세션에 고정된 조각 크기. */
  partSizeBytes: number;

  /** 세션을 구성하는 조각 수. */
  partCount: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export default defineContract({
  id: 'upload-session-part-checksum',
  title:
    '재개 업로드 조각의 X-Content-Sha256은 본문 해시가 다르면 422로 거부해 저장하지 않고, 재전송에서도 헤더 불일치를 조각 충돌보다 먼저 판정한다',
  rq: ['RQ-028'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    const data = Buffer.from('조각 checksum 계약 검증용 본문', 'utf-8');
    const created = await ctx.client.createUploadSession(
      ns,
      {
        path: '/part.bin',
        sizeBytes: String(data.length),
        mimeType: 'application/octet-stream',
        ifAbsent: true,
      },
      { idempotencyKey: randomUUID() },
    );
    assert.equal(created.status, 201, created.text());
    const session = created.json<SessionCreated>();
    const piece = (index: number): Buffer =>
      data.subarray(index * session.partSizeBytes, (index + 1) * session.partSizeBytes);
    // 첫 조각과 같은 길이이면서 내용이 다른 본문
    const other = Buffer.from(piece(0));
    other[0] ^= 0xff;
    const good = sha256(piece(0));
    const wrong = sha256(other);

    // 형식 오류는 본문을 저장하기 전에 400이다. 대문자·짧은 값·비hex·긴 값이 모두 거부된다.
    for (const value of [good.toUpperCase(), 'abc', 'g'.repeat(64), 'a'.repeat(65)]) {
      const rejected = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0), { sha256: value });
      assert.equal(rejected.status, 400, `${value.slice(0, 8)}: ${rejected.text()}`);
      assert.equal(rejected.json<{ code: string }>().code, 'VFS_INVALID_CHECKSUM', value.slice(0, 8));
    }

    // 헤더가 본문 해시와 다르면 422이고 오류 본문이 기대값·계산값을 노출하지 않는다.
    const mismatch = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0), { sha256: wrong });
    assert.equal(mismatch.status, 422, mismatch.text());
    assert.equal(mismatch.json<{ code: string }>().code, 'VFS_PART_CHECKSUM_MISMATCH');
    for (const hidden of [good, wrong]) {
      assert.ok(!mismatch.text().includes(hidden), '오류 본문이 기대값 또는 계산값을 노출했다');
    }

    // 거부된 조각은 저장되지 않는다.
    const afterReject = await ctx.client.getUploadSession(ns, session.sessionId);
    assert.deepEqual(afterReject.json<{ parts: unknown[] }>().parts, []);

    // 같은 index를 올바른 내용과 일치하는 헤더로 다시 보내면 저장된다.
    const stored = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0), { sha256: good });
    assert.equal(stored.status, 200, stored.text());
    assert.deepEqual(
      {
        sha256: stored.json<{ sha256: string }>().sha256,
        replayed: stored.json<{ replayed: boolean }>().replayed,
      },
      { sha256: good, replayed: false },
    );

    // 재전송 판정 순서: 헤더 불일치(422) → 저장된 조각과 불일치(409) → 모두 일치(replayed).
    const sameBodyWrongHeader = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0), {
      sha256: wrong,
    });
    assert.equal(sameBodyWrongHeader.status, 422, sameBodyWrongHeader.text());
    assert.equal(sameBodyWrongHeader.json<{ code: string }>().code, 'VFS_PART_CHECKSUM_MISMATCH');
    const otherBodyMatchingHeader = await ctx.client.putUploadPart(ns, session.sessionId, 0, other, {
      sha256: wrong,
    });
    assert.equal(otherBodyMatchingHeader.status, 409, otherBodyMatchingHeader.text());
    assert.equal(otherBodyMatchingHeader.json<{ code: string }>().code, 'VFS_UPLOAD_PART_CONFLICT');
    const otherBodyStoredHeader = await ctx.client.putUploadPart(ns, session.sessionId, 0, other, {
      sha256: good,
    });
    assert.equal(otherBodyStoredHeader.status, 422, otherBodyStoredHeader.text());
    assert.equal(otherBodyStoredHeader.json<{ code: string }>().code, 'VFS_PART_CHECKSUM_MISMATCH');
    const replay = await ctx.client.putUploadPart(ns, session.sessionId, 0, piece(0), { sha256: good });
    assert.equal(replay.status, 200, replay.text());
    assert.equal(replay.json<{ replayed: boolean }>().replayed, true);

    // 헤더가 없는 요청은 지금과 같이 동작한다. 나머지 조각을 헤더 없이 올려 완료하면 원본 바이트로 공개된다.
    for (let index = 1; index < session.partCount; index += 1) {
      const rest = await ctx.client.putUploadPart(ns, session.sessionId, index, piece(index));
      assert.equal(rest.status, 200, `조각 ${index}: ${rest.text()}`);
    }
    const done = await ctx.client.completeUploadSession(ns, session.sessionId);
    assert.equal(done.status, 201, done.text());
    const content = await ctx.client.getContent(ns, '/part.bin');
    assert.deepEqual(content.bytes, data);
  },
});
