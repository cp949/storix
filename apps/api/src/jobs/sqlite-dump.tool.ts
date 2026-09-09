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
  // 있다(단일 프로세스 배포 모델).
  async restore(inFile: string): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fs.copyFile(inFile, this.dbPath);
    // 복사 대상에 이전 WAL/공유메모리/롤백 저널이 남아있으면 새로 복사된
    // 메인 파일과 어긋나 손상으로 이어질 수 있어 명시적으로 제거한다.
    await Promise.all(
      ['-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${this.dbPath}${suffix}`, { force: true })),
    );
  }
}
