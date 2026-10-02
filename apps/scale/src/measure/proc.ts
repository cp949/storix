import { readFileSync } from 'node:fs';

/** `/proc/<pid>/status`의 RSS(VmRSS)와 최고치(VmHWM)를 바이트로 읽는다. 프로세스가 없으면 null이다. */
export function readMemory(pid: number): { rssBytes: number; peakRssBytes: number } | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const kb = (key: string): number => {
      const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status);
      return match === null ? 0 : Number(match[1]) * 1024;
    };
    return { rssBytes: kb('VmRSS'), peakRssBytes: kb('VmHWM') };
  } catch {
    return null;
  }
}

/** `VmHWM` 최고값을 추적한다. `peak()`는 지금까지 읽은 최고값, `stop()`은 추적을 멈추고 마지막으로 읽은 최고값을 돌려준다. */
export function trackPeakRss(pid: number, intervalMs = 100): { peak(): number; stop(): number } {
  let peak = 0;
  const sample = (): void => {
    const memory = readMemory(pid);
    if (memory !== null) peak = Math.max(peak, memory.peakRssBytes);
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  return {
    peak(): number {
      sample();
      return peak;
    },
    stop(): number {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}
