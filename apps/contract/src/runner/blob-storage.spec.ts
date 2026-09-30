/**
 * 잔여 컨테이너 정리를 가짜 docker 실행 파일로 검증한다.
 * 실제 Docker daemon과 컨테이너는 사용하지 않는다.
 * 규칙은 docs/design/12-contract-checks.md "중단과 정리".
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { removeStaleContainers } from './blob-storage.ts';

/** 명령 인자를 기록하고 ps·rm 결과를 통제하는 실행 파일을 준비한다. */
async function withDocker(
  ids: string,
  rmExitCode: number,
  run: (calls: string) => Promise<void>,
  delays: { psMs: number; rmMs: number } = { psMs: 0, rmMs: 0 },
) {
  const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-docker-unit-'));
  const calls = path.join(workDir, 'calls.jsonl');
  const previousPath = process.env.PATH;
  try {
    await writeFile(
      path.join(workDir, 'docker'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') setTimeout(() => process.stdout.write(${JSON.stringify(ids)}), ${delays.psMs});
else setTimeout(() => process.exit(${rmExitCode}), ${delays.rmMs});
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${workDir}:${previousPath ?? ''}`;
    await run(calls);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(workDir, { recursive: true, force: true });
  }
}

// ps 뒤 남은 제한 시간을 rm에 전달할 때 정수가 아니어서 제거를 누락하는 결함을 잡는다.
describe('잔여 컨테이너 정리', () => {
  it('조회한 컨테이너를 모두 제거하고 두 명령에 하나의 시간 예산을 적용한다', async () => {
    await withDocker('first\nsecond\n', 0, async (calls) => {
      await removeStaleContainers(1_000);
      assert.deepEqual(
        (await readFile(calls, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        [
          ['ps', '-aq', '--filter', 'name=storix-contract-'],
          ['rm', '-f', '-v', 'first', 'second'],
        ],
      );
    });
  });

  it('조회 결과가 비어 있으면 제거 명령을 실행하지 않는다', async () => {
    await withDocker('', 0, async (calls) => {
      await removeStaleContainers(1_000);
      assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
    });
  });

  it('제거 명령의 실패를 정리 오류로 전달한다', async () => {
    await withDocker('first\n', 7, async () => {
      await assert.rejects(removeStaleContainers(1_000), (error) => {
        assert.equal((error as { code: number }).code, 7);
        return true;
      });
    });
  });

  it('조회에 쓴 시간만큼 제거의 남은 예산을 줄인다', async () => {
    // rm의 300ms 지연은 전체 400ms보다 짧고 ps 이후 남은 250ms보다 길다.
    // rm에 전체 예산을 다시 전달하면 시간 초과 없이 성공해 이 테스트가 실패한다.
    await withDocker(
      'first\n',
      0,
      async (calls) => {
        const started = performance.now();
        await assert.rejects(removeStaleContainers(400), (error) => {
          assert.equal((error as { signal: string }).signal, 'SIGKILL');
          return true;
        });
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 150, `조회 지연보다 먼저 끝났다: ${elapsed}ms`);
        assert.ok(elapsed < 650, `공유 시간 예산을 초과했다: ${elapsed}ms`);
        assert.deepEqual(
          (await readFile(calls, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          [
            ['ps', '-aq', '--filter', 'name=storix-contract-'],
            ['rm', '-f', '-v', 'first'],
          ],
        );
      },
      { psMs: 150, rmMs: 300 },
    );
  });
});
