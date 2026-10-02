import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

interface ListedNamespace {
  readonly id: string;
  readonly name: string | null;
  readonly quota: { readonly limitBytes: string; readonly usedBytes: string };
}

interface ListPage {
  readonly items: ListedNamespace[];
  readonly nextCursor: string | null;
}

export function registerNamespaceListPageTests(options: {
  app: () => INestApplication;
  createNamespace: (name: string | null, key: string) => Promise<string>;
  /** 테스트가 DB를 직접 바꾼다(큰 bigint·삭제). */
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}): void {
  describe('namespace 목록 page 모드', () => {
    const prefix = 'pg-list-';
    const names = Array.from({ length: 7 }, (_, i) => `${prefix}${String.fromCharCode(97 + i)}`);
    const unnamedIds: string[] = [];
    const http = () => request(options.app().getHttpServer());
    const get = (query: string) => http().get(`/api/v2/namespaces${query}`);

    async function walk(limit: number): Promise<ListedNamespace[]> {
      const seen: ListedNamespace[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 1000; guard++) {
        const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = (await get(query).expect(200)).body as ListPage;
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items);
        if (page.nextCursor === null) return seen;
        cursor = page.nextCursor;
      }
      throw new Error('cursor가 끝나지 않는다');
    }

    beforeAll(async () => {
      for (const name of names) await options.createNamespace(name, `key-${name}`);
      unnamedIds.push(await options.createNamespace(null, 'key-unnamed-1'));
      unnamedIds.push(await options.createNamespace(null, 'key-unnamed-2'));
    });

    it('limit·cursor가 없으면 기존처럼 ACTIVE 전체 배열이다', async () => {
      const body = (await get('').expect(200)).body as ListedNamespace[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.filter((item) => item.name?.startsWith(prefix)).map((item) => item.name)).toEqual(names);
      expect(body.slice(-2).map((item) => item.name)).toEqual([null, null]);
    });

    it('limit을 주면 페이지 객체를 (name, id) 순서로 돌려주고 끝 page의 nextCursor는 null이다', async () => {
      const first = (await get('?limit=3').expect(200)).body as ListPage;
      expect(Object.keys(first).sort()).toEqual(['items', 'nextCursor']);
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).toEqual(expect.stringMatching(/^nl1\./));
      const all = await walk(3);
      const mine = all.filter((item) => item.name?.startsWith(prefix));
      expect(mine.map((item) => item.name)).toEqual(names);
      expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
      const sorted = [...all].sort((a, b) => {
        if (a.name === null) return b.name === null ? a.id.localeCompare(b.id) : 1;
        if (b.name === null) return -1;
        return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
      });
      expect(all.map((item) => item.id)).toEqual(sorted.map((item) => item.id));
      expect(all.slice(-2).map((item) => item.id)).toEqual([...unnamedIds].sort());
    });

    it('page 경계: 항목 수와 같은 limit의 마지막 page는 nextCursor가 null이다', async () => {
      const total = (await walk(1000)).length;
      const exact = (await get(`?limit=${Math.min(total, 1000)}`).expect(200)).body as ListPage;
      if (total <= 1000) expect(exact.nextCursor).toBeNull();
      expect(exact.items.length).toBe(Math.min(total, 1000));
    });

    it('cursor만 주면 기본 limit(100) page다', async () => {
      const first = (await get('?limit=2').expect(200)).body as ListPage;
      const page = (await get(`?cursor=${encodeURIComponent(first.nextCursor!)}`).expect(200))
        .body as ListPage;
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.items.length).toBeLessThanOrEqual(100);
    });

    it('유효하지 않은 limit은 기본값으로, 최대값 초과는 최대값으로 대체한다', async () => {
      for (const limit of ['0', '-1', 'abc', '1.5']) {
        const page = (await get(`?limit=${limit}`).expect(200)).body as ListPage;
        expect(page.items.length).toBeLessThanOrEqual(100);
      }
      const big = (await get('?limit=100000').expect(200)).body as ListPage;
      expect(big.items.length).toBeLessThanOrEqual(1000);
    });

    it('잘못되거나 변조된 cursor는 400 VFS_INVALID_CURSOR다', async () => {
      for (const cursor of ['garbage', 'nl1.', `nl1.${Buffer.from('{}').toString('base64url')}`]) {
        const response = await get(`?limit=2&cursor=${encodeURIComponent(cursor)}`).expect(400);
        expect(response.body.code).toBe('VFS_INVALID_CURSOR');
      }
    });

    it('순회 중 이미 지나간 행의 삭제·cursor 뒤의 생성은 중복 없이 반영한다', async () => {
      const first = (await get('?limit=2').expect(200)).body as ListPage;
      await options.createNamespace(`${prefix}zz-new`, 'key-zz-new');
      const rest: ListedNamespace[] = [];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = (await get(`?limit=2&cursor=${encodeURIComponent(cursor)}`).expect(200))
          .body as ListPage;
        rest.push(...page.items);
        cursor = page.nextCursor;
      }
      const ids = [...first.items, ...rest].map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(rest.map((item) => item.name)).toContain(`${prefix}zz-new`);
    });

    it('page 항목의 큰 bigint 사용량을 정확히 보존한다', async () => {
      const id = await options.createNamespace(`${prefix}big`, 'key-big');
      await options.query('UPDATE namespace SET live_file_byte_count = $1 WHERE id = $2', [
        '9007199254740993',
        id,
      ]);
      const all = await walk(5);
      expect(all.find((item) => item.id === id)?.quota.usedBytes).toBe('9007199254740993');
    });
  });
}
