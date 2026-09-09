// Postgres(pg_dump/pg_restore CLI)와 SQLite(VACUUM INTO/파일 복사)가 공유하는
// 백업/복구 인터페이스. 연결 정보(호스트/포트/자격증명 또는 파일 경로)는 각
// 구현체가 생성자에서 ConfigService로부터 읽어 내부에 캡슐화한다 —
// BackupJob/RestoreJob은 드라이버별 연결 정보를 몰라도 된다.
export interface DbDumpTool {
  // 백업 디렉터리에 이 이름으로 dump 파일을 만든다(예: 'postgres.dump',
  // 'storix.sqlite'). BackupJob/RestoreJob이 파일 경로를 조립할 때 쓴다.
  readonly dumpFileName: string;
  dump(outFile: string): Promise<void>;
  restore(inFile: string): Promise<void>;
}

export const DB_DUMP_TOOL = Symbol('DB_DUMP_TOOL');
