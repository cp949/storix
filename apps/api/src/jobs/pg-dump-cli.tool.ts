import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

export interface PgConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

function runProcess(command: string, args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // stdout은 읽지 않으므로 명시적으로 버린다 — 파이프로 열어 두면 나중에
    // verbose 플래그가 붙었을 때 64KB 파이프 버퍼가 차서 자식이 블록된다.
    // stderr만 파이프로 열고 아래에서 실제로 소비한다.
    const child = spawn(command, args, {
      env: { ...process.env, PGPASSWORD: password },
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
export class PgDumpCliTool {
  async dump(conn: PgConnectionOptions, outFile: string): Promise<void> {
    await runProcess(
      'pg_dump',
      ['-h', conn.host, '-p', String(conn.port), '-U', conn.username, '-Fc', '-f', outFile, conn.database],
      conn.password,
    );
  }

  // --clean --if-exists: 대상에 이미 스키마가 있어도(예: migrate가 먼저 실행돼
  // 빈 테이블이 존재) 실패하지 않고 지운 뒤 다시 만든다. 스키마가 아예 없는
  // 완전히 빈 Postgres에도 동일하게 동작한다(--if-exists가 DROP 대상 부재를
  // 무시함).
  async restore(conn: PgConnectionOptions, inFile: string): Promise<void> {
    await runProcess(
      'pg_restore',
      ['-h', conn.host, '-p', String(conn.port), '-U', conn.username, '-d', conn.database, '--clean', '--if-exists', inFile],
      conn.password,
    );
  }
}
