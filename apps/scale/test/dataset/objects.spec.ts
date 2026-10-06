import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { defaultSpec } from '../../src/dataset/spec.ts';
import { ensureObjects, expectedObjectCounts, planObjects, removeAllObjects } from '../../src/dataset/objects.ts';

const REF = '2026-10-02T00:00:00.000Z';

describe('object 계획', () => {
  const spec = { ...defaultSpec(1000, REF), staleObjects: 7, staleStagingObjects: 2 };

  it('종류별 개수가 기대값과 같고 key가 중복되지 않는다', () => {
    const counts: Record<string, number> = {};
    const keys = new Set<string>();
    for (const object of planObjects(spec)) {
      counts[object.kind] = (counts[object.kind] ?? 0) + 1;
      keys.add(object.key);
    }
    assert.deepEqual(counts, expectedObjectCounts(spec));
    assert.equal(
      keys.size,
      Object.values(counts).reduce((a, b) => a + b, 0),
    );
  });

  it('key는 StorageKeyGenerator 형식(blobs/<shard>/<uuid>)이거나 upload-staging/ 아래다', () => {
    for (const object of planObjects(spec)) {
      assert.match(object.key, /^(blobs\/[0-9a-f]{2}\/[0-9a-f-]{36}|upload-staging\/[0-9a-f-]{36})$/);
    }
  });
});

describe('ensureObjects', () => {
  it('없는 파일만 만들고 지운 파일을 복원하며 수정 시각을 과거로 둔다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scale-objects-'));
    try {
      const spec = { ...defaultSpec(100, REF), staleObjects: 3, staleStagingObjects: 1 };
      const first = await ensureObjects(spec, dir);
      assert.equal(first.created, first.total);
      const second = await ensureObjects(spec, dir);
      assert.equal(second.created, 0);

      const stale = [...planObjects(spec)].find((o) => o.kind === 'stale')!;
      const age = Date.parse(REF) - statSync(path.join(dir, stale.key)).mtimeMs;
      assert.ok(Math.abs(age - 60 * 86_400_000) < 2000);

      rmSync(path.join(dir, stale.key));
      assert.equal((await ensureObjects(spec, dir)).created, 1);

      removeAllObjects(dir);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
