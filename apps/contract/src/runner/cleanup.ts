/**
 * 정리 작업의 시간 상한과 실행 오류·정리 오류의 동시 전달을 관리한다.
 * 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 정리 작업 하나의 기본 제한 시간이다. */
export const CLEANUP_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

/** 실행 오류와 정리 오류가 함께 발생했을 때 원래 실행 값을 보존한다. */
export class ExecutionCleanupError extends Error {
  /** 정리 전에 발생한 실행 오류의 원래 값이다. */
  readonly executionError: unknown;

  /** 원래 오류를 처리하는 동안 발생한 정리 오류다. */
  readonly cleanupErrors: readonly Error[];

  /** 원래 실행 오류를 cause로 연결하고 정리 오류를 별도로 보존한다. */
  constructor(executionError: unknown, cleanupErrors: readonly Error[]) {
    super('실행 오류와 정리 오류가 함께 발생했다.', { cause: executionError });
    this.executionError = executionError;
    this.cleanupErrors = cleanupErrors;
  }
}

/** Error가 아닌 정리 실패 값을 출력 가능한 오류로 바꾼다. */
export function cleanupError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 정리 명령을 비동기로 실행한다. 제한 시간이 지나면 SIGKILL로 명령 프로세스를 종료한다. */
export async function runCleanupCommand(
  command: string,
  args: readonly string[],
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  return stdout.trim();
}

/** 끝나지 않는 정리를 제한 시간 뒤 거부한다. 뒤늦은 reject도 소비한다. */
export async function withCleanupTimeout<T>(
  label: string,
  cleanup: () => Promise<T>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 정리가 ${timeoutMs}ms 제한을 넘었다.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
