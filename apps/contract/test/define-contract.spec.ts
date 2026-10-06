import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineContract } from '../src/define-contract.ts';

const validDefinition = {
  id: 'conditional-create',
  title: '존재하지 않는 경로에만 파일을 생성한다',
  rq: ['RQ-005'],
  async run() {},
};

describe('계약 정의(defineContract)', () => {
  it('profile을 생략하면 default를 쓴다', () => {
    assert.equal(defineContract(validDefinition).profile, 'default');
  });

  it('id는 소문자 kebab-case여야 한다', () => {
    assert.throws(() => defineContract({ ...validDefinition, id: 'Conditional_Create' }), /id/);
  });

  it('title이 비어 있으면 거부한다', () => {
    assert.throws(() => defineContract({ ...validDefinition, title: '  ' }), /title/);
  });

  it('rq가 비어 있으면 거부한다', () => {
    assert.throws(() => defineContract({ ...validDefinition, rq: [] }), /rq/);
  });

  it('RQ-NNN 형식이 아닌 rq를 거부한다', () => {
    assert.throws(() => defineContract({ ...validDefinition, rq: ['RQ-5'] }), /RQ-5/);
  });

  it('skip·only 옵션은 받지 않는다', () => {
    assert.throws(() => defineContract({ ...validDefinition, skip: true } as never), /skip/);
    assert.throws(() => defineContract({ ...validDefinition, only: true } as never), /only/);
  });
});
