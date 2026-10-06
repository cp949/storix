// 소비자 기대: 업로드 세션 완료와 조건부 콘텐츠 저장의 성공 응답은 저장된 파일 전체의 평문 SHA-256과 revision을 함께 알리고, 이 값이 이후 stat과 같으며, 파일이 바뀐 뒤 같은 요청을 재전송해도 최초 응답의 값을 그대로 돌려준다.
// 대응 요구사항: RQ-004(바이트 무손실 보존), RQ-008(revision 조건부 전체 교체), RQ-011(변경 요청의 멱등성).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';
import type { ContractContext } from '../../define-contract.ts';
import { assertReplayed } from '../../support/assert-replayed.ts';

interface Resource {
  revision: string;
  sha256?: string;
}

interface SessionCreated {
  sessionId: string;
  partSizeBytes: number;
  partCount: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** stat이 알리는 hash·revision이 성공 응답의 값과 같은지 확인한다. */
async function assertStatMatches(
  ctx: ContractContext,
  ns: string,
  path: string,
  resource: Resource,
  label: string,
): Promise<void> {
  const stat = await ctx.client.getStat(ns, path);
  assert.equal(stat.status, 200, `${label}: ${stat.text()}`);
  const body = stat.json<{ sha256: string; revision: string }>();
  assert.equal(body.sha256, resource.sha256, `${label}: stat의 sha256`);
  assert.equal(body.revision, resource.revision, `${label}: stat의 revision`);
}

export default defineContract({
  id: 'upload-session-result-sha256',
  title:
    '업로드 세션 완료와 조건부 콘텐츠 저장의 성공 응답은 전체 평문 SHA-256을 알리고 stat과 일치하며 재전송은 파일이 바뀐 뒤에도 최초 값을 재생한다',
  rq: ['RQ-004', 'RQ-008', 'RQ-011'],
  profile: 'resumable-upload',
  async run(ctx) {
    const ns = (await ctx.createNamespace()).id;
    // 0x00·0xff·비UTF-8을 섞어 본문을 문자열로 바꾸지 않고 바이트 기준으로 계산하는지 본다.
    const first = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xc3, 0x28, 0x01, 0xfe, 0x10]);
    const second = Buffer.from([0xfe, 0x00, 0xc3, 0x28, 0x7f]);

    // 조건부 저장: 생성은 201, revision 조건 교체는 200이고 둘 다 응답에 hash가 있다.
    const conditionalKey = randomUUID();
    const created = await ctx.client.putConditionalContent(
      ns,
      '/conditional.bin',
      first,
      { ifAbsent: true },
      {
        idempotencyKey: conditionalKey,
      },
    );
    assert.equal(created.status, 201, created.text());
    const createdResource = created.json<{ resource: Resource }>().resource;
    assert.equal(createdResource.sha256, sha256(first));
    await assertStatMatches(ctx, ns, '/conditional.bin', createdResource, '조건부 생성');

    const replaced = await ctx.client.putConditionalContent(ns, '/conditional.bin', second, {
      ifRevision: createdResource.revision,
    });
    assert.equal(replaced.status, 200, replaced.text());
    const replacedResource = replaced.json<{ resource: Resource }>().resource;
    assert.equal(replacedResource.sha256, sha256(second));
    await assertStatMatches(ctx, ns, '/conditional.bin', replacedResource, '조건부 교체');

    // 파일이 교체된 뒤 최초 요청을 같은 키로 다시 보내도 최초 응답(revision·hash 포함)을 그대로 재생한다.
    const replay = await ctx.client.putConditionalContent(
      ns,
      '/conditional.bin',
      first,
      { ifAbsent: true },
      {
        idempotencyKey: conditionalKey,
      },
    );
    assertReplayed(replay, created, '조건부 저장 재전송');
    assert.equal(replay.json<{ resource: Resource }>().resource.sha256, sha256(first));

    // 업로드 세션 완료: 생성 201과 교체 200 모두 hash를 알린다. 조각 크기는 세션 응답을 따른다.
    const upload = async (
      path: string,
      bytes: Buffer,
      condition: object,
    ): Promise<{
      sessionId: string;
      result: Awaited<ReturnType<typeof ctx.client.completeUploadSession>>;
    }> => {
      const session = await ctx.client.createUploadSession(ns, {
        path,
        sizeBytes: String(bytes.length),
        mimeType: 'application/octet-stream',
        ...condition,
      });
      assert.equal(session.status, 201, session.text());
      const { sessionId, partSizeBytes, partCount } = session.json<SessionCreated>();
      for (let index = 0; index < partCount; index += 1) {
        const piece = bytes.subarray(index * partSizeBytes, (index + 1) * partSizeBytes);
        const stored = await ctx.client.putUploadPart(ns, sessionId, index, piece);
        assert.equal(stored.status, 200, `조각 ${index}: ${stored.text()}`);
      }
      return { sessionId, result: await ctx.client.completeUploadSession(ns, sessionId) };
    };

    const sessionCreated = await upload('/session.bin', first, { ifAbsent: true });
    assert.equal(sessionCreated.result.status, 201, sessionCreated.result.text());
    const sessionResource = sessionCreated.result.json<{ resource: Resource }>().resource;
    assert.equal(sessionResource.sha256, sha256(first));
    await assertStatMatches(ctx, ns, '/session.bin', sessionResource, '세션 생성');

    const sessionReplaced = await upload('/session.bin', second, { ifRevision: sessionResource.revision });
    assert.equal(sessionReplaced.result.status, 200, sessionReplaced.result.text());
    const sessionReplacedResource = sessionReplaced.result.json<{ resource: Resource }>().resource;
    assert.equal(sessionReplacedResource.sha256, sha256(second));
    await assertStatMatches(ctx, ns, '/session.bin', sessionReplacedResource, '세션 교체');

    // 파일이 교체된 뒤 처음 세션의 완료를 다시 호출해도 최초 응답의 revision과 hash를 재생한다.
    const again = await ctx.client.completeUploadSession(ns, sessionCreated.sessionId);
    assertReplayed(again, sessionCreated.result, '세션 완료 재전송');
    assert.equal(again.json<{ resource: Resource }>().resource.sha256, sha256(first));

    // 조회 결과의 `result`도 같은 최초 응답이다.
    const status = await ctx.client.getUploadSession(ns, sessionCreated.sessionId);
    assert.equal(status.status, 200);
    assert.equal(status.json<{ result: { resource: Resource } }>().result.resource.sha256, sha256(first));
  },
});
