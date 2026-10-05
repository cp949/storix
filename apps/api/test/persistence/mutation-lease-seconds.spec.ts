import { MAX_TIMER_MS } from '../../src/common/env-parsing.js';
import {
  MUTATION_LEASE_SECONDS_LIMIT,
  VfsMutationReceiptRepository,
  mutationLeaseSeconds,
} from '../../src/persistence/vfs-mutation-receipt.repository.js';
import type { DataSource } from 'typeorm';

describe('mutationLeaseSeconds', () => {
  const original = process.env.STORIX_MUTATION_LEASE_SECONDS;

  afterEach(() => {
    if (original === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
    else process.env.STORIX_MUTATION_LEASE_SECONDS = original;
  });

  it('값이 없으면 60초다', () => {
    delete process.env.STORIX_MUTATION_LEASE_SECONDS;
    expect(mutationLeaseSeconds()).toBe(60);
  });

  // 갱신 간격은 lease의 1/3이다. 그 값이 setTimeout 한도를 넘으면 갱신이 1ms 간격으로 연속 실행된다.
  it('상한은 갱신 간격(lease의 1/3)이 setTimeout 한도에 들어가는 최댓값이다', () => {
    expect((MUTATION_LEASE_SECONDS_LIMIT * 1000) / 3).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(((MUTATION_LEASE_SECONDS_LIMIT + 1) * 1000) / 3).toBeGreaterThan(MAX_TIMER_MS);
  });

  it('상한을 넘는 값은 거부한다', () => {
    process.env.STORIX_MUTATION_LEASE_SECONDS = String(MUTATION_LEASE_SECONDS_LIMIT + 1);
    expect(() => mutationLeaseSeconds()).toThrow('잘못된 정수 환경변수 값');
  });

  it('상한과 같은 값은 받는다', () => {
    process.env.STORIX_MUTATION_LEASE_SECONDS = String(MUTATION_LEASE_SECONDS_LIMIT);
    expect(mutationLeaseSeconds()).toBe(MUTATION_LEASE_SECONDS_LIMIT);
  });

  // 요청 시점에만 읽으면 잘못된 값으로도 부팅이 성공하고 이후 모든 mutation이 500이 된다.
  it('잘못된 값이면 repository 생성 시점에 거부한다', () => {
    process.env.STORIX_MUTATION_LEASE_SECONDS = '30s';
    expect(() => new VfsMutationReceiptRepository({} as DataSource)).toThrow('잘못된 정수 환경변수 값');
  });
});
