import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitUntil } from './runner/wait.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

function containers(): string {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'name=storix-contract-'], {
    encoding: 'utf-8',
  }).trim();
}

// 실제 docker와 빌드된 apps/api/dist를 쓴다. CLI 프로세스를 직접 띄워 종료 신호를 보낸다.
describe('CLI 중단(SIGINT)', () => {
  it(
    'VersityGW가 준비되기를 기다리는 중에 중단해도 컨테이너가 남지 않는다',
    { timeout: 60_000 },
    async () => {
      const cli = spawn(process.execPath, [CLI], { stdio: 'ignore' });
      const exited = new Promise<number | null>((resolve) => cli.once('exit', (code) => resolve(code)));
      try {
        // 컨테이너가 생겼지만 health 대기가 끝나기 전이 Ctrl+C가 오는 순간이다.
        await waitUntil(async () => containers().length > 0, {
          timeoutMs: 30_000,
          intervalMs: 20,
          description: 'VersityGW 컨테이너 생성',
        });
        cli.kill('SIGINT');
        assert.equal(await exited, 130);
        assert.equal(containers(), '');
      } finally {
        cli.kill('SIGKILL');
        const leftover = containers().split('\n').filter(Boolean);
        if (leftover.length > 0) execFileSync('docker', ['rm', '-f', '-v', ...leftover]);
      }
    },
  );
});
