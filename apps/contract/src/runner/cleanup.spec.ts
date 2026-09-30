/** 외부 프로세스의 정리 성공·실패·시간 제한을 짧은 Node 프로세스로 검증한다. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLEANUP_TIMEOUT_MS, runCleanupCommand, withCleanupTimeout } from './cleanup.ts';

// 동기 명령으로 event loop가 막히거나 실패를 삼키는 변경을 잡는다.
describe('제한 시간이 있는 정리', () => {
  it('정리 명령 기본 제한은 30초이고 성공 출력은 반환한다', async () => {
    // 운영 기본 제한을 바꾸면 계획의 정리 상한 검증이 실패해야 한다.
    assert.equal(CLEANUP_TIMEOUT_MS, 30_000);
    assert.equal(await runCleanupCommand(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  });

  it('정리 명령의 실패를 전달한다', async () => {
    await assert.rejects(runCleanupCommand(process.execPath, ['-e', 'process.exit(7)']), (error) => {
      assert.equal((error as { code: number }).code, 7);
      return true;
    });
  });

  it('정리 명령 시간이 초과되면 프로세스를 종료하고 오류를 반환한다', async () => {
    await assert.rejects(
      runCleanupCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 20),
      (error) => {
        assert.equal((error as { signal: string }).signal, 'SIGKILL');
        return true;
      },
    );
  });

  it('끝나지 않는 정리를 제한 시간 뒤 거부한다', async () => {
    await assert.rejects(
      withCleanupTimeout('서버', () => new Promise(() => {}), 5),
      /서버.*5ms/,
    );
  });
});
