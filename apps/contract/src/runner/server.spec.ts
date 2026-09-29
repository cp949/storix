import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refuseNewServers, startServer } from './server.ts';

// 프로세스 전역 상태를 바꾸므로 이 파일에는 이 검증만 둔다(테스트 파일마다 별도 프로세스로 실행된다).
describe('서버 기동 거부(refuseNewServers)', () => {
  it('중단 정리가 시작된 뒤에는 서버를 새로 기동하지 않고 프로세스를 만들지 않는다', async () => {
    refuseNewServers();
    await assert.rejects(
      () => startServer({ port: 1, env: {}, workDir: '/nonexistent', label: 'refused' }),
      /중단/,
    );
  });
});
