import type { DataSource } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import { BackupRepository } from '../../src/persistence/backup.repository.js';

// count()가 던지는 드라이버 오류만 바꿔 hasExistingNamespaces의 분기를 확인한다.
function repositoryFailingWith(driverError: Error & { code?: string }): BackupRepository {
  const dataSource = {
    getRepository: () => ({
      count: async () => {
        throw new QueryFailedError('SELECT COUNT(*) FROM namespace', [], driverError);
      },
    }),
  } as unknown as DataSource;
  return new BackupRepository(dataSource);
}

describe('BackupRepository.hasExistingNamespaces 오류 분류', () => {
  it('Postgres 테이블 없음(42P01)은 비어 있는 대상으로 본다', async () => {
    const repository = repositoryFailingWith(
      Object.assign(new Error('relation "namespace" does not exist'), { code: '42P01' }),
    );

    await expect(repository.hasExistingNamespaces()).resolves.toBe(false);
  });

  it('SQLite namespace 테이블 없음은 비어 있는 대상으로 본다', async () => {
    const repository = repositoryFailingWith(
      Object.assign(new Error('SqliteError: no such table: namespace'), { code: 'SQLITE_ERROR' }),
    );

    await expect(repository.hasExistingNamespaces()).resolves.toBe(false);
  });

  it.each([
    ['다른 테이블 없음', 'SQLITE_ERROR', 'no such table: vfs_node'],
    ['구문 오류', 'SQLITE_ERROR', 'near "SELEC": syntax error'],
    ['손상', 'SQLITE_CORRUPT', 'database disk image is malformed'],
    ['DB 파일 아님', 'SQLITE_NOTADB', 'file is not a database'],
  ])('SQLite %s 오류는 비어 있다고 보지 않고 그대로 던진다', async (_name, code, message) => {
    const repository = repositoryFailingWith(Object.assign(new Error(`SqliteError: ${message}`), { code }));

    await expect(repository.hasExistingNamespaces()).rejects.toMatchObject({ driverError: { code } });
  });
});
