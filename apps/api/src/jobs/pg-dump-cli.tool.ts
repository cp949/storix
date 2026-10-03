import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { DbDumpTool } from './db-dump.tool.js';

export interface PgConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

// libpq와 실행 파일 탐색에 필요한 변수만 넘긴다.
// - 허용 목록을 쓴다. STORIX_* 비밀값과 어댑터 자격증명을 자식에게 넘기지 않기 위해서다.
// - 차단 목록은 쓰지 않는다. 코어가 어댑터 자격증명 변수의 이름을 모르기 때문이다.
// - HOME은 libpq가 ~/.pgpass와 ~/.postgresql/ 인증서를 찾는 기준이다.
// - PG*는 운영자가 PGSSLMODE 등으로 libpq를 설정하는 경로다.
const PG_CHILD_ENV_NAMES = new Set(['PATH', 'HOME', 'TZ', 'LANG']);

/** `pg_dump`·`pg_restore` 자식 환경변수를 허용 목록으로 만든다. `PGPASSWORD`는 `password`로 덮어쓴다. */
export function buildPgChildEnv(source: NodeJS.ProcessEnv, password: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (PG_CHILD_ENV_NAMES.has(key) || key.startsWith('LC_') || key.startsWith('PG')) {
      env[key] = value;
    }
  }
  env.PGPASSWORD = password;
  return env;
}

function runProcess(command: string, args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // stdout은 읽지 않으므로 명시적으로 버린다 — 파이프로 열어 두면 나중에
    // verbose 플래그가 붙었을 때 64KB 파이프 버퍼가 차서 자식이 블록된다.
    // stderr만 파이프로 열고 아래에서 실제로 소비한다.
    const child = spawn(command, args, {
      env: buildPgChildEnv(process.env, password),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(new Error(`${command} 실행 실패: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} 종료 코드 ${code}: ${stderr}`));
      }
    });
  });
}

@Injectable()
export class PgDumpCliTool implements DbDumpTool {
  readonly dumpFileName = 'postgres.dump';
  private readonly conn: PgConnectionOptions;

  constructor(config: ConfigService) {
    this.conn = {
      host: config.getOrThrow<string>('STORIX_DB_HOST'),
      port: parsePositiveInt(config.get<string>('STORIX_DB_PORT'), 5432),
      username: config.getOrThrow<string>('STORIX_DB_USERNAME'),
      password: config.getOrThrow<string>('STORIX_DB_PASSWORD'),
      database: config.getOrThrow<string>('STORIX_DB_NAME'),
    };
  }

  async dump(outFile: string): Promise<void> {
    await runProcess(
      'pg_dump',
      [
        '-h',
        this.conn.host,
        '-p',
        String(this.conn.port),
        '-U',
        this.conn.username,
        '-Fc',
        '-f',
        outFile,
        this.conn.database,
      ],
      this.conn.password,
    );
  }

  // --clean --if-exists: 대상에 이미 스키마가 있어도(예: migrate가 먼저 실행돼
  // 빈 테이블이 존재) 실패하지 않고 지운 뒤 다시 만든다. 스키마가 아예 없는
  // 완전히 빈 Postgres에도 동일하게 동작한다(--if-exists가 DROP 대상 부재를
  // 무시함).
  async restore(inFile: string): Promise<void> {
    await runProcess(
      'pg_restore',
      [
        '-h',
        this.conn.host,
        '-p',
        String(this.conn.port),
        '-U',
        this.conn.username,
        '-d',
        this.conn.database,
        '--clean',
        '--if-exists',
        inFile,
      ],
      this.conn.password,
    );
  }
}
