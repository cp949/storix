import { afterEach, describe, expect, it } from '@jest/globals';
import type { DataSource } from 'typeorm';
import type { BlobRepository } from '../../src/persistence/blob.repository.js';
import { VfsSnapshotRepository } from '../../src/persistence/vfs-snapshot.repository.js';

const NAMES = [
  'STORIX_MAX_SYNC_SNAPSHOT_NODES',
  'STORIX_MAX_RETAINED_SNAPSHOT_NODES',
  'STORIX_MAX_SNAPSHOT_BYTES',
  'STORIX_MAX_RETAINED_SNAPSHOT_BYTES',
] as const;

describe('snapshot 상한 환경변수', () => {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  const create = () => new VfsSnapshotRepository({} as DataSource, {} as BlobRepository);

  it('값이 없거나 올바르면 repository를 만든다', () => {
    for (const name of NAMES) delete process.env[name];
    expect(create).not.toThrow();
    for (const name of NAMES) process.env[name] = '5';
    expect(create).not.toThrow();
  });

  for (const name of NAMES) {
    it(`${name}가 잘못되면 요청이 아니라 생성 시점에 변수 이름과 함께 거부한다`, () => {
      for (const invalid of ['0', '-1', '1.5', '1e3', ' 5', 'abc']) {
        process.env[name] = invalid;
        expect(create).toThrow(name);
      }
    });
  }
});
