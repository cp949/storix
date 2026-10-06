import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertExperimentContainer,
  assertExperimentDatabase,
  assertLoopbackHost,
  runDatabaseName,
  templateDatabaseName,
} from '../../src/infra/guard.ts';

describe('실험 대상 보호', () => {
  it('긴 runId에서도 api·gc database 이름이 서로 다르다', () => {
    const runId = '20261001T172349-baseline-s1-blocked-100000-very-long-label-suffix';
    assert.notEqual(runDatabaseName(runId, 'api'), runDatabaseName(runId, 'gc'));
  });

  it('접두어가 없는 database는 거부한다', () => {
    assert.throws(() => assertExperimentDatabase('storix'), /실험 대상 database가 아니다/);
    assert.throws(() => assertExperimentDatabase('postgres'), /실험 대상/);
    assert.throws(() => assertExperimentDatabase('storix_scale_x; drop'), /실험 대상/);
  });

  it('접두어가 있는 database는 허용한다', () => {
    assert.doesNotThrow(() => assertExperimentDatabase('storix_scale_t_1000000_v1'));
  });

  it('접두어가 없는 컨테이너는 거부한다', () => {
    assert.throws(() => assertExperimentContainer('storix-contract-pg'), /실험 대상 컨테이너가 아니다/);
    assert.doesNotThrow(() => assertExperimentContainer('storix-scale-pg'));
  });

  it('루프백이 아닌 호스트는 거부한다', () => {
    assert.throws(() => assertLoopbackHost('db.internal'), /루프백/);
    assert.doesNotThrow(() => assertLoopbackHost('127.0.0.1'));
  });

  it('template·run database 이름은 보호 규칙을 만족한다', () => {
    assert.equal(templateDatabaseName(1_000_000, 'storix-scale-v1'), 'storix_scale_t_1000000_storixscalev1');
    assert.match(runDatabaseName('20261002T010203-baseline', 'api'), /^storix_scale_r_api_[0-9a-f]{12}$/);
  });
});
