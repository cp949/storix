import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbDumpTool } from './db-dump.tool.js';

@Injectable()
export class SqliteDumpTool implements DbDumpTool {
  readonly dumpFileName = 'storix.sqlite';
  private readonly dbPath: string;

  constructor(config: ConfigService) {
    this.dbPath = config.getOrThrow<string>('STORIX_DB_SQLITE_PATH');
  }

  // VACUUM INTO: 다른 연결이 읽기/쓰기 중이어도 일관된 스냅샷을 원자적으로 한
  // 파일에 만드는 SQLite 표준 기능. better-sqlite3는 이 문에 파라미터 바인딩을
  // 지원한다(직접 실증 완료) — 경로를 문자열 결합하지 않아 인젝션 위험이 없다.
  async dump(outFile: string): Promise<void> {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const db = new Database(this.dbPath, { readonly: true });
    try {
      db.prepare('VACUUM INTO ?').run(outFile);
    } finally {
      db.close();
    }
  }

  // 복구는 restore-main.ts가 API와 별도 프로세스로 도는 것을 전제(현재 구조
  // 그대로)하므로, 복사 시점에 대상 파일을 쓰는 다른 연결이 없다고 가정할 수
  // 있다(단일 프로세스 배포 모델). 같은 디렉터리의 임시 파일에 복사한 뒤 rename으로
  // 교체해, 복사가 중간에 끊겨도 기존 DB가 손상된 채 남지 않게 한다. rename은 대상 파일
  // 자리를 바꾸므로 dbPath가 파일 단위 bind mount이면 EBUSY로 실패한다(디렉터리 볼륨만 지원).
  // 교체 전에 열려 있던 연결은 이전 파일을 계속 보므로 복구 뒤에는 새로 연결해야 한다.
  async restore(inFile: string): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    const tmpPath = `${this.dbPath}.restore-tmp`;
    try {
      await fs.copyFile(inFile, tmpPath);
      // 이전 WAL/공유메모리/롤백 저널이 남아있으면 새로 복사된 메인 파일과 어긋나
      // 손상으로 이어질 수 있어 교체 전에 명시적으로 제거한다.
      await Promise.all(
        ['-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${this.dbPath}${suffix}`, { force: true })),
      );
      await fs.rename(tmpPath, this.dbPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      throw error;
    }
  }
}
