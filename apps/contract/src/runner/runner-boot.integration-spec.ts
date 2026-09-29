import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { removeStaleContainers, startBlobStorage } from './blob-storage.ts';
import { prepareSqliteDatabase } from './database.ts';
import { PROFILE_ENV } from './profiles.ts';
import { buildServerEnv } from './server-env.ts';
import { findFreePort, startServer, stopAllServers } from './server.ts';

// 실제 docker(VersityGW)와 빌드된 apps/api/dist를 쓴다.
// 실행 전 `pnpm turbo run build --filter=@cp949/storix-api`로 dist를 최신으로 만든다.
describe('러너 기동(SQLite + VersityGW)', () => {
  it('서버가 준비 상태가 되고 재시작 뒤에도 응답한다', { timeout: 180_000 }, async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-boot-'));
    const blob = await startBlobStorage(`boot-${process.pid}`);
    try {
      const database = prepareSqliteDatabase(workDir, 'boot');
      const port = await findFreePort();
      const server = await startServer({
        port,
        workDir,
        label: 'boot',
        env: buildServerEnv({
          port,
          apiKey: 'boot-api-key',
          adminKey: 'boot-admin-key',
          profileEnv: PROFILE_ENV.default,
          databaseEnv: database.env,
          storageEnv: blob.env,
        }),
      });
      try {
        assert.equal((await fetch(`${server.baseUrl}/health/ready`)).status, 200);
        await server.restart();
        assert.equal((await fetch(`${server.baseUrl}/health/ready`)).status, 200);
      } finally {
        await server.stop();
      }
    } finally {
      await blob.stop();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('기동을 기다리는 중에 중단해도 서버 프로세스가 남지 않는다', { timeout: 180_000 }, async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-abort-'));
    const blob = await startBlobStorage(`abort-${process.pid}`);
    try {
      const database = prepareSqliteDatabase(workDir, 'abort');
      const port = await findFreePort();
      // startServer는 프로세스를 띄운 직후 준비 상태를 기다린다. 이 시점이 Ctrl+C가 오는 순간이다.
      const starting = startServer({
        port,
        workDir,
        label: 'abort',
        env: buildServerEnv({
          port,
          apiKey: 'abort-api-key',
          adminKey: 'abort-admin-key',
          profileEnv: PROFILE_ENV.default,
          databaseEnv: database.env,
          storageEnv: blob.env,
        }),
      });
      const outcome = assert.rejects(starting, /기동 중 종료/);
      const stoppedPids = await stopAllServers();
      await outcome;
      assert.equal(stoppedPids.length, 1);
      assert.throws(() => process.kill(stoppedPids[0]!, 0), { code: 'ESRCH' });
    } finally {
      await blob.stop();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it(
    '서버가 기동 중 종료하면 대기하지 않고 로그 끝부분이 담긴 오류를 낸다',
    { timeout: 60_000 },
    async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), 'storix-contract-bad-'));
      try {
        const port = await findFreePort();
        // STORIX_API_KEY와 저장소·DB 설정이 없어 부팅에 실패한다.
        await assert.rejects(
          startServer({
            port,
            workDir,
            label: 'bad',
            env: { PATH: process.env.PATH ?? '', STORIX_PORT: String(port) },
          }),
          /기동 중 종료/,
        );
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );

  it('시작할 때 이전 실행이 남긴 storix-contract 컨테이너를 제거한다', { timeout: 60_000 }, () => {
    const name = 'storix-contract-stale-test';
    execFileSync('docker', ['create', '--name', name, 'versity/versitygw:v1.8.0']);
    removeStaleContainers();
    const remaining = execFileSync('docker', ['ps', '-aq', '--filter', `name=${name}`], {
      encoding: 'utf-8',
    }).trim();
    assert.equal(remaining, '');
  });
});
