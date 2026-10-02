import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { GC_MAIN, WORK_DIR } from '../paths.ts';
import { trackPeakRss } from './proc.ts';

/** GC 프로세스 1회 실행 결과. */
export interface GcRun {
  readonly wallMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;

  /** 최소 실행 간격 게이트나 다른 인스턴스 때문에 GC가 실행되지 않고 건너뛰어졌는가 */
  readonly skipped: boolean;

  /** GC 프로세스의 `VmHWM` 최고값(바이트). 측정기 프로세스 RSS가 아니다. */
  readonly peakRssBytes: number;

  /** `GC job 종료: {...}` 로그에서 읽은 결과. 읽지 못하면 null이다. */
  readonly result: Record<string, unknown> | null;
  readonly logFile: string;
}

/** 빌드된 `gc-main.js`를 한 번 실행하고 시간·최고 RSS·결과를 기록한다. */
export async function runGc(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
  readonly timeoutMs: number;
}): Promise<GcRun> {
  const logFile = path.join(WORK_DIR, `${options.label}.gc.log`);
  // 같은 label로 GC를 이어 실행하면 로그에 이전 실행이 쌓이므로 이번 실행이 쓴 부분만 읽는다.
  const logOffset = existsSync(logFile) ? statSync(logFile).size : 0;
  const logFd = openSync(logFile, 'a');
  const started = performance.now();
  const proc = spawn(process.execPath, [GC_MAIN], {
    cwd: WORK_DIR,
    env: options.env,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  const tracker = trackPeakRss(proc.pid!);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, options.timeoutMs);
  const exitCode = await new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  clearTimeout(timer);
  const peakRssBytes = tracker.stop();
  const log = readFileSync(logFile).subarray(logOffset).toString('utf-8');
  const match = /GC job 종료: (\{.*\})/.exec(log);
  return {
    wallMs: performance.now() - started,
    exitCode,
    timedOut,
    skipped: match === null && log.includes('건너뜀'),
    peakRssBytes,
    result: match === null ? null : (JSON.parse(match[1]) as Record<string, unknown>),
    logFile,
  };
}

/** GC 실행 결과에 예산이 소진된 단계가 남았는지 판정한다. 결과를 읽지 못하면 남은 것으로 본다. */
export function hasExhaustedStages(run: GcRun): boolean {
  return exhaustedStages(run).length > 0 || run.result === null;
}

/** GC 실행 결과에서 예산이 소진된 단계 이름을 읽는다. */
export function exhaustedStages(run: GcRun): readonly string[] {
  const stages = run.result?.budgetExhaustedStages;
  return Array.isArray(stages) ? (stages as string[]) : [];
}
