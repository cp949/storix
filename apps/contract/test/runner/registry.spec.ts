import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineContract } from '../../src/define-contract.ts';
import {
  discoverContracts,
  findUncoveredRqs,
  groupByProfile,
  selectContracts,
  shuffle,
  validateContracts,
} from '../../src/runner/registry.ts';

const DEFINE_CONTRACT_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/define-contract.ts'),
).href;

function contractSource(id: string, rq: string): string {
  return [
    `import { defineContract } from '${DEFINE_CONTRACT_URL}';`,
    `export default defineContract({ id: '${id}', title: '${id} 제목', rq: ['${rq}'], async run() {} });`,
  ].join('\n');
}

function sample(id: string, rq = 'RQ-005') {
  return defineContract({ id, title: `${id} 제목`, rq: [rq], async run() {} });
}

describe('계약 레지스트리', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'storix-contract-registry-'));
    await mkdir(path.join(dir, 'file'));
    await writeFile(path.join(dir, 'file', 'b-contract.ts'), contractSource('b-contract', 'RQ-005'));
    await writeFile(path.join(dir, 'a-contract.ts'), contractSource('a-contract', 'RQ-001'));
    await writeFile(path.join(dir, 'README.md'), '계약이 아닌 파일');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('하위 디렉터리까지 .ts 계약을 파일 이름 순서로 찾는다', async () => {
    const discovered = await discoverContracts(dir);
    assert.deepEqual(
      discovered.map((item) => item.contract.id),
      ['a-contract', 'b-contract'],
    );
  });

  it('default export가 계약이 아니면 파일 경로가 담긴 오류를 던진다', async () => {
    const badDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-bad-'));
    try {
      await writeFile(path.join(badDir, 'bad.ts'), 'export default { id: "x" };');
      await assert.rejects(discoverContracts(badDir), /bad\.ts.*defineContract/);
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  it('id가 중복되면 두 파일을 알려 준다', () => {
    const errors = validateContracts(
      [
        { contract: sample('same'), file: '/x/one.ts' },
        { contract: sample('same'), file: '/x/two.ts' },
      ],
      new Set(['RQ-005']),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /same.*one\.ts.*two\.ts/);
  });

  it('요구사항 문서에 없는 RQ를 오류로 낸다', () => {
    const errors = validateContracts(
      [{ contract: sample('unknown-rq', 'RQ-777'), file: '/x/u.ts' }],
      new Set(['RQ-005']),
    );
    assert.match(errors[0]!, /unknown-rq.*RQ-777/);
  });

  it('문제가 없으면 오류 목록이 비어 있다', () => {
    assert.deepEqual(
      validateContracts([{ contract: sample('ok'), file: '/x/ok.ts' }], new Set(['RQ-005'])),
      [],
    );
  });

  it('프로필별로 묶고 입력 순서를 유지한다', () => {
    const groups = groupByProfile([sample('one'), sample('two')]);
    assert.deepEqual(
      [...groups.get('default')!].map((contract) => contract.id),
      ['one', 'two'],
    );
  });

  it('id로 계약을 고르고 없는 id는 거부한다', () => {
    const all = [sample('one'), sample('two')];
    assert.deepEqual(
      selectContracts(all, ['two']).map((contract) => contract.id),
      ['two'],
    );
    assert.deepEqual(selectContracts(all, []), all);
    assert.throws(() => selectContracts(all, ['missing']), /missing/);
  });

  it('계약이 없는 RQ만 문서 순서로 돌려준다', () => {
    assert.deepEqual(findUncoveredRqs(['RQ-001', 'RQ-005', 'RQ-006'], [sample('one', 'RQ-005')]), [
      'RQ-001',
      'RQ-006',
    ]);
  });

  it('섞기는 원소를 잃지 않고 주입한 난수로 결정된다', () => {
    const items = [1, 2, 3, 4];
    const shuffled = shuffle(items, () => 0);
    assert.deepEqual([...shuffled].sort(), items);
    assert.deepEqual(
      shuffled,
      shuffle(items, () => 0),
    );
    assert.deepEqual(items, [1, 2, 3, 4]);
  });

  it('기본 난수원으로 섞어도 원소를 잃지 않는다', () => {
    const items = [1, 2, 3, 4, 5, 6];
    assert.deepEqual([...shuffle(items)].sort(), items);
  });
});
