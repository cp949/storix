import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activeNamespaceId, md5Uuid, pickActiveNumbers } from '../../src/dataset/ids.ts';
import { applyOverrides, defaultSpec, expectedCounts, validateSpec } from '../../src/dataset/spec.ts';
import { activeChunkSql, chunkRanges, deletedChunkSql } from '../../src/dataset/sql.ts';

const REF = '2026-10-02T00:00:00.000Z';

describe('chunkRanges', () => {
  it('끝을 포함한 구간으로 나눈다', () => {
    assert.deepEqual(chunkRanges(5, 2), [
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 5 },
    ]);
  });

  it('0개는 빈 목록이다', () => {
    assert.deepEqual(chunkRanges(0, 10), []);
  });

  it('잘못된 인자를 거부한다', () => {
    assert.throws(() => chunkRanges(-1, 10), /total/);
    assert.throws(() => chunkRanges(10, 0), /size/);
  });
});

describe('expectedCounts', () => {
  it('1만 규모의 기대 행 수를 계산한다', () => {
    const counts = expectedCounts(defaultSpec(10_000, REF));
    assert.equal(counts.namespace, 11_000);
    assert.equal(counts.activeNamespaces, 10_000);
    assert.equal(counts.deletedNamespaces, 1_000);
    assert.equal(counts.vfsNode, 10_000 + 1_000 * 6);
    assert.equal(counts.blob, 1_000 * 5 + 20 * 2);
    assert.equal(counts.orphanBlobs, 40);
    assert.equal(counts.idempotencyKey, 11_000 + 1_000 * 3);
    assert.equal(counts.changeFeedState, 1_000);
    assert.equal(counts.changeEvent, 10_000);
    assert.equal(counts.dueNamespaces, 10);
    assert.equal(counts.expiredChangeEvents, 30);
  });

  it('100만 규모는 1만 규모의 100배다', () => {
    const small = expectedCounts(defaultSpec(10_000, REF));
    const large = expectedCounts(defaultSpec(1_000_000, REF));
    assert.equal(large.namespace, small.namespace * 100);
    assert.equal(large.changeEvent, small.changeEvent * 100);
    assert.equal(large.dueNamespaces, small.dueNamespaces * 100);
  });
});

describe('validateSpec', () => {
  it('기본 명세는 유효하다', () => {
    assert.deepEqual(validateSpec(defaultSpec(1000, REF)), []);
  });

  it('모순된 명세를 보고한다', () => {
    const bad = {
      ...defaultSpec(1000, REF),
      expiredEventsPerDue: 99,
      seed: "x'; DROP",
    };
    const errors = validateSpec(bad);
    assert.equal(errors.length, 2);
  });

  it('managementReceiptsPerActive는 0 이상의 정수만 허용한다', () => {
    for (const value of [1.5, Number.NaN, -1]) {
      const errors = validateSpec({ ...defaultSpec(1000, REF), managementReceiptsPerActive: value });
      assert.deepEqual(errors, ['managementReceiptsPerActive는 0 이상의 정수여야 한다'], String(value));
    }
    assert.deepEqual(validateSpec({ ...defaultSpec(1000, REF), managementReceiptsPerActive: 0 }), []);
  });

  it('blocked namespace는 유효한 선두 이벤트가 있어 이벤트 수가 만료 이벤트 수보다 커야 한다', () => {
    const base = { ...defaultSpec(1000, REF), blockedEvery: 5, eventsPerActive: 4, expiredEventsPerDue: 3 };
    assert.deepEqual(validateSpec(base), []);
    const errors = validateSpec({ ...base, expiredEventsPerDue: 4 });
    assert.deepEqual(errors, ['blockedEvery를 쓰면 eventsPerActive는 expiredEventsPerDue보다 커야 한다']);
    // blockedEvery가 0이면 선두 유효 이벤트가 필요 없다.
    assert.deepEqual(validateSpec({ ...base, blockedEvery: 0, expiredEventsPerDue: 4 }), []);
  });
});

describe('적재 SQL', () => {
  const spec = defaultSpec(1000, REF);

  it('구간 번호와 기준 시각을 SQL에 넣는다', () => {
    const sql = activeChunkSql(spec, { from: 1, to: 500 });
    assert.match(sql, /generate_series\(1, 500\)/);
    assert.match(sql, /2026-10-02T00:00:00.000Z/);
    assert.match(sql, /^BEGIN;/);
    assert.match(sql.trimEnd(), /COMMIT;$/);
  });

  it('seed가 위험하면 SQL을 만들지 않는다', () => {
    assert.throws(() => activeChunkSql({ ...spec, seed: "a'b" }, { from: 1, to: 1 }), /데이터셋 명세 오류/);
  });

  it('prefix ID 스타일은 namespace ID에만 scale_ 접두어를 붙인다', () => {
    const sql = activeChunkSql({ ...spec, namespaceIdStyle: 'prefixed' }, { from: 1, to: 1 });
    assert.match(sql, /'scale_' \|\| overlay\(overlay\(md5\('storix-scale-v1:ns'/);
    assert.match(sql, /INSERT INTO vfs_node/);
    assert.match(sql, /'scale_' \|\| overlay\(overlay\(md5\('storix-scale-v1:ns'/);
  });

  it('삭제 namespace SQL은 deleted- 이름과 COMPLETED 상태를 쓴다', () => {
    const sql = deletedChunkSql(spec, { from: 1, to: 10 });
    assert.match(sql, /'deleted-' \|\| i/);
    assert.match(sql, /'COMPLETED'/);
  });

  it('SQL에 생성 receipt 요청 해시 식과 change feed 식이 들어 있다', () => {
    const sql = activeChunkSql(spec, { from: 1, to: 10 });
    assert.match(sql, /accessPolicy/);
    assert.match(sql, /INSERT INTO vfs_change_event/);
    assert.match(sql, /INSERT INTO vfs_change_feed_state/);
  });
});

describe('ID', () => {
  it('md5 UUID는 version 4·variant 8 형식이다', () => {
    assert.match(md5Uuid('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(md5Uuid('a'), '0cc175b9-c0f1-46a8-81c3-99e269772661');
  });

  it('활동 namespace 번호는 activeEvery의 배수이고 중복이 없다', () => {
    const spec = defaultSpec(10_000, REF);
    const picked = pickActiveNumbers(spec, 50);
    assert.equal(picked.length, 50);
    assert.equal(new Set(picked).size, 50);
    assert.ok(picked.every((n) => n % spec.activeEvery === 0 && n <= spec.namespaces));
    assert.equal(activeNamespaceId(spec, 10), md5Uuid(`${spec.seed}:ns:10`));
  });

  it('활동 namespace보다 많이 요청하면 가능한 만큼만 고른다', () => {
    const spec = defaultSpec(100, REF);
    assert.equal(pickActiveNumbers(spec, 1000).length, 10);
  });
});

describe('명세 덮어쓰기와 막힌 namespace', () => {
  it('--set으로 숫자 필드를 바꾼다', () => {
    const spec = applyOverrides(defaultSpec(10_000, REF), ['blockedEvery=100', 'filesPerActive=2']);
    assert.equal(spec.blockedEvery, 100);
    assert.equal(spec.filesPerActive, 2);
  });

  it('숫자가 아닌 필드·값은 거부한다', () => {
    assert.throws(() => applyOverrides(defaultSpec(10_000, REF), ['seed=x']), /숫자 필드만/);
    assert.throws(() => applyOverrides(defaultSpec(10_000, REF), ['blockedEvery=-1']), /숫자 필드만/);
    assert.throws(() => applyOverrides(defaultSpec(10_000, REF), ['nope=1']), /숫자 필드만/);
  });

  it('막힌 namespace는 만료 namespace와 겹친 번호를 만료로 센다', () => {
    const spec = applyOverrides(defaultSpec(10_000, REF), ['blockedEvery=100']);
    const counts = expectedCounts(spec);
    // 100의 배수 100개 중 1000의 배수 10개는 만료로 취급한다.
    assert.equal(counts.blockedNamespaces, 90);
    assert.equal(counts.dueNamespaces, 10);
    assert.equal(counts.expiredChangeEvents, (10 + 90) * 3);
  });

  it('blockedEvery가 0이면 막힌 namespace가 없다', () => {
    assert.equal(expectedCounts(defaultSpec(10_000, REF)).blockedNamespaces, 0);
  });
});
