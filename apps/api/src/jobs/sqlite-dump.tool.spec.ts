import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { SqliteDumpTool } from './sqlite-dump.tool.js';

describe('SqliteDumpTool', () => {
  let tmpDir: string;
  let dbPath: string;

  function makeConfig(values: Record<string, string>): ConfigService {
    return {
      getOrThrow: (key: string) => {
        const value = values[key];
        if (value === undefined) {
          throw new Error(`설정값 없음: ${key}`);
        }
        return value;
      },
    } as unknown as ConfigService;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-sqlite-dump-tool-'));
    dbPath = path.join(tmpDir, 'storix.sqlite');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('restore', () => {
    it('inFile 내용을 dbPath로 복사한다', async () => {
      const inFile = path.join(tmpDir, 'backup.sqlite');
      const content = 'dump-content-for-copy-check';
      await fs.writeFile(inFile, content);
      const tool = new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: dbPath }));

      await tool.restore(inFile);

      await expect(fs.readFile(dbPath, 'utf8')).resolves.toBe(content);
    });

    it('복구 후 이전 -wal/-shm/-journal 사이드카 파일을 제거한다', async () => {
      const inFile = path.join(tmpDir, 'backup.sqlite');
      await fs.writeFile(inFile, 'dump-content');
      await fs.writeFile(`${dbPath}-wal`, 'stale-wal');
      await fs.writeFile(`${dbPath}-shm`, 'stale-shm');
      await fs.writeFile(`${dbPath}-journal`, 'stale-journal');
      const tool = new SqliteDumpTool(makeConfig({ STORIX_DB_SQLITE_PATH: dbPath }));

      await tool.restore(inFile);

      await expect(fs.access(`${dbPath}-wal`)).rejects.toThrow();
      await expect(fs.access(`${dbPath}-shm`)).rejects.toThrow();
      await expect(fs.access(`${dbPath}-journal`)).rejects.toThrow();
    });
  });
});
