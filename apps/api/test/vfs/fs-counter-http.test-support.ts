import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { expectCountersMatchRows } from '../persistence/vfs-counter-invariants.js';

/** counter 행렬의 receipt replay·마지막 slot 경쟁 행을 HTTP 경계에서 확인하는 공용 계약 입력이다. */
export interface FsCounterHttpContext {
  /** 호출 시점의 HTTP 서버를 돌려준다. 앱이 재기동될 수 있어 값이 아닌 함수로 받는다. */
  server(): Server;

  dataSource(): DataSource;

  createNamespace(name: string): Promise<string>;
}

/** 생성 receipt 재생과 마지막 slot 경쟁이 counter를 한 번만 바꾸는지 확인한다. */
export function registerFsCounterHttpContract(ctx: FsCounterHttpContext): void {
  describe('counter receipt 재생과 마지막 slot 경쟁', () => {
    const mkdir = (namespaceId: string, path: string, key: string, scope: string) =>
      request(ctx.server())
        .post(`/api/v2/namespaces/${namespaceId}/fs/mutations`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .send(JSON.stringify({ kind: 'mkdir', path, ifAbsent: true }));

    const liveNodeCount = async (namespaceId: string) =>
      String(
        (await ctx.dataSource().getRepository(NamespaceEntity).findOneByOrFail({ id: namespaceId }))
          .liveNodeCount,
      );

    it('같은 key의 성공 요청과 상한 초과 거부를 재생해도 counter를 다시 올리지 않는다', async () => {
      const namespaceId = await ctx.createNamespace(`counter-replay-${randomUUID()}`);
      await ctx
        .dataSource()
        .getRepository(NamespaceEntity)
        .update({ id: namespaceId }, { maxLiveNodes: '1' });
      const okKey = randomUUID();
      const rejectedKey = randomUUID();

      const first = await mkdir(namespaceId, '/a', okKey, 'counter-replay').expect(201);
      const replay = await mkdir(namespaceId, '/a', okKey, 'counter-replay').expect(201);
      expect(replay.body).toEqual(first.body);
      expect(await liveNodeCount(namespaceId)).toBe('1');

      const rejected = await mkdir(namespaceId, '/b', rejectedKey, 'counter-replay').expect(413);
      expect(rejected.body.code).toBe('VFS_NAMESPACE_NODE_LIMIT_EXCEEDED');
      const rejectedReplay = await mkdir(namespaceId, '/b', rejectedKey, 'counter-replay').expect(413);
      expect(rejectedReplay.body).toEqual(rejected.body);

      expect(await liveNodeCount(namespaceId)).toBe('1');
      await expectCountersMatchRows(ctx.dataSource(), namespaceId);
    });

    it('마지막 live node slot을 서로 다른 요청이 동시에 다투면 하나만 성공한다', async () => {
      const namespaceId = await ctx.createNamespace(`counter-race-${randomUUID()}`);
      await ctx
        .dataSource()
        .getRepository(NamespaceEntity)
        .update({ id: namespaceId }, { maxLiveNodes: '1' });

      const responses = await Promise.all(
        ['/one', '/two'].map((path) => mkdir(namespaceId, path, randomUUID(), 'counter-race')),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([201, 413]);
      expect(responses.find((response) => response.status === 413)?.body.code).toBe(
        'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED',
      );
      expect(await liveNodeCount(namespaceId)).toBe('1');
      await expectCountersMatchRows(ctx.dataSource(), namespaceId);
    });
  });
}
