import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildApp(): void {
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: apiRoot, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`빌드 실패:\n${result.stdout}\n${result.stderr}`);
  }
}

export function runMigrations(sqlitePath: string): void {
  const result = spawnSync(
    'pnpm',
    ['exec', 'typeorm-ts-node-esm', 'migration:run', '-d', 'src/persistence/data-source.ts'],
    {
      cwd: apiRoot,
      env: { ...process.env, STORIX_DB_DRIVER: 'sqlite', STORIX_DB_SQLITE_PATH: sqlitePath },
      encoding: 'utf-8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`마이그레이션 준비 실패:\n${result.stdout}\n${result.stderr}`);
  }
}

interface RunProcessOptions {
  readonly cwd: string;
  readonly distFile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  // stdout/stderr에 이 문자열이 나오면 SIGTERM으로 정리하고 그 시점 출력을
  // 반환한다(main.ts처럼 계속 떠 있는 서버용). 생략하면 프로세스가 스스로
  // 종료할 때까지 기다린다(gc/backup/restore처럼 한 번 실행하고 끝나는 CLI용).
  readonly untilOutputIncludes?: string;
}

export function runProcess({
  cwd,
  distFile,
  env,
  timeoutMs = 20000,
  untilOutputIncludes,
}: RunProcessOptions): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(apiRoot, 'dist', distFile)], { cwd, env });
    let output = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`부팅 확인 타임아웃. 지금까지 출력:\n${output}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (untilOutputIncludes && output.includes(untilOutputIncludes)) {
        clearTimeout(timer);
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
