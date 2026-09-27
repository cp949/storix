import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { encodeChangeFeedCursor } from '../../src/vfs/change-feed-cursor.js';

interface Context {
  readonly app: INestApplication;
  readonly enabledId: string;
  readonly otherId: string;
  readonly disabledId: string;
  readonly apiKey: string;
}

interface Change {
  sequence: string;
  operationId: string;
  operationIndex: number;
  operationCount: number;
  kind: string;
  nodeId: string;
  nodeType: string;
  path: string;
  occurredAt: string;
  previousPath?: string;
  revision?: string;
}

export function registerChangeFeedHttpContract(get: () => Context): void {
  it('인증, capability 비활성, 기존 파일 API 접근과 ACTIVE namespace 경계를 지킨다', async () => {
    const { app, enabledId, otherId, disabledId, apiKey } = get();
    const http = () => request(app.getHttpServer());
    const disabled = `/api/v2/namespaces/${disabledId}/fs`;
    await http().get(`/api/v2/namespaces/${enabledId}/fs/changes`).expect(401);
    expect(
      (await http().get(`${disabled}/changes`).set('Authorization', `Bearer ${apiKey}`).expect(409)).body
        .code,
    ).toBe('VFS_FEATURE_DISABLED');
    await http()
      .post(`${disabled}/mkdir`)
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ path: '/still-available' })
      .expect(201);
    const repo = app.get(DataSource).getRepository(VfsChangeFeedStateEntity);
    expect(await repo.findOneBy({ namespaceId: disabledId })).toBeNull();
    const namespaces = app.get(DataSource).getRepository(NamespaceEntity);
    await namespaces.update({ id: otherId }, { status: 'DELETING' });
    try {
      expect(
        (
          await http()
            .get(`/api/v2/namespaces/${otherId}/fs/changes`)
            .set('Authorization', `Bearer ${apiKey}`)
            .expect(404)
        ).body.code,
      ).toBe('NAMESPACE_NOT_FOUND');
    } finally {
      await namespaces.update({ id: otherId }, { status: 'ACTIVE' });
    }
  });

  it('checkpoint 이후 변경을 순서대로 재생하고 페이지·polling·고시퀀스를 보존한다', async () => {
    const { app, enabledId, apiKey } = get();
    const http = () => request(app.getHttpServer());
    const base = `/api/v2/namespaces/${enabledId}/fs`;
    const auth = { Authorization: `Bearer ${apiKey}` };
    await http().post(`${base}/mkdir`).set(auth).send({ path: '/before' }).expect(201);
    const checkpoint = (await http().get(`${base}/changes`).set(auth).expect(200)).body;
    expect(checkpoint).toEqual({ changes: [], nextCursor: expect.stringMatching(/^cf1\./), hasMore: false });
    await http().post(`${base}/mkdir`).set(auth).send({ path: '/a' }).expect(201);
    await http().post(`${base}/mkdir`).set(auth).send({ path: '/b' }).expect(201);
    const first = (
      await http()
        .get(`${base}/changes`)
        .set(auth)
        .query({ cursor: checkpoint.nextCursor, limit: 1 })
        .expect(200)
    ).body;
    expect(first.changes).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(
      (
        await http()
          .get(`${base}/changes`)
          .set(auth)
          .query({ cursor: checkpoint.nextCursor, limit: 1 })
          .expect(200)
      ).body,
    ).toEqual(first);
    const changes: Change[] = [...first.changes];
    let cursor = first.nextCursor as string;
    for (;;) {
      const page = (await http().get(`${base}/changes`).set(auth).query({ cursor, limit: 1 }).expect(200))
        .body;
      changes.push(...page.changes);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(changes.some((event) => event.path === '/before')).toBe(false);
    expect(changes.map((event) => BigInt(event.sequence))).toEqual(
      [...changes.map((event) => BigInt(event.sequence))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(changes.map((event) => event.path)).toEqual(expect.arrayContaining(['/a', '/b']));
    for (const event of changes) {
      expect(event).toEqual(
        expect.objectContaining({
          sequence: expect.any(String),
          operationId: expect.any(String),
          operationIndex: expect.any(Number),
          operationCount: expect.any(Number),
          kind: expect.any(String),
          nodeId: expect.any(String),
          nodeType: expect.any(String),
          path: expect.any(String),
          occurredAt: expect.any(String),
        }),
      );
    }
    const empty = (await http().get(`${base}/changes`).set(auth).query({ cursor }).expect(200)).body;
    expect(empty).toEqual({ changes: [], nextCursor: cursor, hasMore: false });
    const reader = jest.spyOn(app.get(VfsNodeRepository), 'readChangeFeedPage');
    try {
      await http().get(`${base}/changes`).set(auth).query({ cursor }).expect(200);
      expect(reader).toHaveBeenLastCalledWith(enabledId, 101, expect.any(Function));
      await http().get(`${base}/changes`).set(auth).query({ cursor, limit: 5000 }).expect(200);
      expect(reader).toHaveBeenLastCalledWith(enabledId, 1001, expect.any(Function));
    } finally {
      reader.mockRestore();
    }

    const capabilities = app.get(CapabilityService);
    const original = capabilities.isEnabled.bind(capabilities);
    const disabled = jest
      .spyOn(capabilities, 'isEnabled')
      .mockImplementation((id, feature) =>
        id === enabledId && feature === 'change-feed' ? false : original(id, feature),
      );
    try {
      expect((await http().get(`${base}/changes`).set(auth).query({ cursor }).expect(409)).body.code).toBe(
        'VFS_FEATURE_DISABLED',
      );
      await http().post(`${base}/mkdir`).set(auth).send({ path: '/during-disabled' }).expect(201);
    } finally {
      disabled.mockRestore();
    }
    const resumed = (await http().get(`${base}/changes`).set(auth).query({ cursor }).expect(200)).body;
    expect(resumed.changes.some((event: Change) => event.path === '/during-disabled')).toBe(true);

    const states = app.get(DataSource).getRepository(VfsChangeFeedStateEntity);
    await states.update({ namespaceId: enabledId }, { lastSequence: '9007199254740992' });
    const highCheckpoint = (await http().get(`${base}/changes`).set(auth).expect(200)).body.nextCursor;
    await http().post(`${base}/mkdir`).set(auth).send({ path: '/high' }).expect(201);
    const high = (
      await http().get(`${base}/changes`).set(auth).query({ cursor: highCheckpoint, limit: 1000 }).expect(200)
    ).body;
    expect(BigInt(high.changes[0].sequence)).toBeGreaterThan(9007199254740992n);
    expect(high.changes.some((event: Change) => event.path === '/high')).toBe(true);
    expect(high.hasMore).toBe(false);
    await states.update({ namespaceId: enabledId }, { prunedThrough: high.changes[0].sequence });
    expect(
      (await http().get(`${base}/changes`).set(auth).query({ cursor: highCheckpoint }).expect(410)).body.code,
    ).toBe('VFS_CHANGE_CURSOR_EXPIRED');
  });

  it('변조·타 namespace·미래 sequence cursor를 400으로 거부한다', async () => {
    const { app, enabledId, otherId, apiKey } = get();
    const http = () => request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${apiKey}` };
    const base = `/api/v2/namespaces/${enabledId}/fs/changes`;
    const state = await app
      .get(DataSource)
      .getRepository(VfsChangeFeedStateEntity)
      .findOneByOrFail({ namespaceId: enabledId });
    const other = encodeChangeFeedCursor(otherId, '0', state.signingSecret);
    const valid = (await http().get(base).set(auth).expect(200)).body.nextCursor as string;
    const tampered = `${valid.slice(0, -1)}${valid.at(-1) === 'x' ? 'y' : 'x'}`;
    const forgedPayload = Buffer.from(JSON.stringify({ namespaceId: enabledId, sequence: '0' })).toString(
      'base64url',
    );
    const forgedPublicDigest = createHash('sha256')
      .update(`storix-vfs-change-feed-v1:${forgedPayload}`)
      .digest('base64url');
    for (const cursor of [
      other,
      tampered,
      `cf1.${forgedPayload}.${forgedPublicDigest}`,
      encodeChangeFeedCursor(enabledId, '1', '1'.repeat(64)),
      'cf1.bad',
      encodeChangeFeedCursor(enabledId, '9223372036854775807', state.signingSecret),
    ]) {
      expect((await http().get(base).set(auth).query({ cursor }).expect(400)).body.code).toBe(
        'VFS_INVALID_CURSOR',
      );
    }
    expect((await http().get(base).set(auth).query({ cursor: '' }).expect(400)).body.code).toBe(
      'VFS_INVALID_CURSOR',
    );
  });

  it('checkpoint 발급 뒤 초기 열거와 겹친 mutation은 feed에 반드시 남는다', async () => {
    const { app, otherId, apiKey } = get();
    const http = () => request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${apiKey}` };
    const base = `/api/v2/namespaces/${otherId}/fs`;
    const checkpoint = await http().get(`${base}/changes`).set(auth).expect(200);
    const [listed, mutation] = await Promise.all([
      http().get(`${base}/ls`).set(auth).query({ path: '/' }).expect(200),
      http().post(`${base}/mkdir`).set(auth).send({ path: '/race' }).expect(201),
    ]);
    expect(mutation.body.path).toBe('/race');
    const page = (
      await http().get(`${base}/changes`).set(auth).query({ cursor: checkpoint.body.nextCursor }).expect(200)
    ).body;
    expect(Array.isArray(listed.body.items)).toBe(true);
    expect(page.changes.some((event: Change) => event.path === '/race')).toBe(true);
  });
}
