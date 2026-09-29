// 소비자 기대: 파일 교체가 진행되는 동안 만든 snapshot은 지정한 revision의 바이트만 보존하거나 거부된다.
// 대응 요구사항: RQ-012(스냅샷 생성, 변경과의 경합).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { defineContract } from '../../define-contract.ts';

const ROUNDS = 4;
const REPLACEMENT_BYTES = 2 * 1024 * 1024;

interface ConditionalResult {
  resource: { revision: string };
}

interface SnapshotMetadata {
  snapshotId: string;
  sourceRevision: string;
  sha256: string;
}

export default defineContract({
  id: 'snapshot-create-race',
  title: '교체가 진행되는 동안 만든 snapshot은 지정한 revision의 바이트만 보존하거나 412로 거부된다',
  rq: ['RQ-012'],
  async run(ctx) {
    const namespace = await ctx.createNamespace();
    const ns = namespace.id;

    let bytes = randomBytes(REPLACEMENT_BYTES);
    const created = await ctx.client.putConditionalContent(ns, '/race.bin', bytes, { ifAbsent: true });
    let revision = created.json<ConditionalResult>().resource.revision;
    let captured = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      // 교체를 시작해 두고, 끝날 때까지 같은 revision을 조건으로 snapshot을 연속해서 요청한다.
      // 요청들은 교체가 커밋되기 전과 커밋되는 시점에 걸친다.
      const next = randomBytes(REPLACEMENT_BYTES);
      let replaced = false;
      const replacing = ctx.client
        .putConditionalContent(ns, '/race.bin', next, { ifRevision: revision })
        .finally(() => {
          replaced = true;
        });
      const attempts = [];
      do {
        attempts.push(
          await ctx.client.createSnapshot(ns, { kind: 'file', path: '/race.bin', sourceRevision: revision }),
        );
      } while (!replaced);
      const replace = await replacing;
      assert.equal(replace.status, 200, `라운드 ${round}: 교체는 유일한 쓰기라 성공해야 한다`);

      for (const attempt of attempts) {
        if (attempt.status === 201) {
          // 성공했다면 지정한 revision의 바이트만 보존한다. 교체된 바이트가 섞이면 안 된다.
          captured += 1;
          const metadata = attempt.json<SnapshotMetadata>();
          assert.equal(metadata.sourceRevision, revision);
          assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
          const saved = await ctx.client.getSnapshotContent(ns, metadata.snapshotId);
          assert.deepEqual(saved.bytes, bytes, `라운드 ${round}: snapshot 바이트가 지정한 revision과 다르다`);
        } else {
          assert.equal(attempt.status, 412, `라운드 ${round}: 성공이 아니면 412여야 한다: ${attempt.status}`);
        }
      }

      bytes = next;
      revision = replace.json<ConditionalResult>().resource.revision;
    }

    // 교체가 끝나기 전에 요청한 snapshot이 실제로 존재해야 경합 구간을 검증한 것이다.
    assert.ok(captured > 0, '교체 진행 중에 성공한 snapshot이 하나도 없다');
    assert.deepEqual((await ctx.client.getContent(ns, '/race.bin')).bytes, bytes);
  },
});
