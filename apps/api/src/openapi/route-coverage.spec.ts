import { VfsSnapshotController } from '../vfs/vfs-snapshot.controller.js';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parse } from 'yaml';
import { FsController } from '../vfs/fs.controller.js';
import { PublicFsController } from '../vfs/public-fs.controller.js';
import { NamespaceController } from '../namespace/namespace.controller.js';
import { NamespaceQuotaController } from '../namespace/namespace-quota.controller.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

// openapi.yaml은 수기 작성이라 컨트롤러 라우트와 조용히 어긋날 수 있다(ADR-0019).
// 여기서는 "엔드포인트 존재 여부"만 검증하고 파라미터/스키마 정합성은 리뷰에 맡긴다.

type ControllerClass = new (...args: never[]) => object;

function normalize(path: string): string {
  const collapsed = `/${path}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  // Express 스타일(:id)과 OpenAPI 스타일({id}) 경로 파라미터 표기를 통일한다.
  return collapsed.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function controllerRoutes(controller: ControllerClass): string[] {
  const basePath = (Reflect.getMetadata(PATH_METADATA, controller) as string) ?? '';
  const prototype = controller.prototype as Record<string, unknown>;
  const routes: string[] = [];

  for (const propertyName of Object.getOwnPropertyNames(prototype)) {
    const handler = prototype[propertyName];
    if (propertyName === 'constructor' || typeof handler !== 'function') {
      continue;
    }

    const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (methodPath === undefined || method === undefined) {
      continue;
    }

    const fullPath = normalize([basePath, methodPath === '/' ? '' : methodPath].filter(Boolean).join('/'));
    routes.push(`${RequestMethod[method]} ${fullPath}`);
  }

  return routes;
}

function specRoutes(): string[] {
  const specPath = join(currentDir, '../../openapi.yaml');
  const spec = parse(readFileSync(specPath, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const routes: string[] = [];

  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const httpMethod of Object.keys(operations)) {
      routes.push(`${httpMethod.toUpperCase()} ${normalize(path)}`);
    }
  }

  return routes;
}

describe('openapi.yaml ↔ 컨트롤러 라우트 정합성', () => {
  it('스펙의 엔드포인트 집합이 namespace/fs/public-fs 컨트롤러 라우트 집합과 정확히 일치한다', () => {
    const codeRoutes = [
      ...controllerRoutes(NamespaceController),
      ...controllerRoutes(NamespaceQuotaController),
      ...controllerRoutes(FsController),
      ...controllerRoutes(VfsSnapshotController),
      ...controllerRoutes(PublicFsController),
    ].sort();

    expect(specRoutes().sort()).toEqual(codeRoutes);
  });

  it('조건부 변경과 revision 조회의 필수 입력 및 응답을 명시한다', () => {
    const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters: Array<{ name?: string; in?: string; required?: boolean; $ref?: string }>;
            responses: Record<string, unknown>;
          }
        >
      >;
    };
    const base = '/api/v1/namespaces/{namespaceId}/fs';
    for (const suffix of ['/mutations', '/content/conditional']) {
      const operation = spec.paths[`${base}${suffix}`].post;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
          expect.objectContaining({ name: 'X-Mutation-Scope', in: 'header', required: true }),
        ]),
      );
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(['200', '201', '400', '404', '409', '412', '413', '428']),
      );
      expect(operation.responses['409']).toHaveProperty('headers.Retry-After.schema.type', 'integer');
    }
    expect(spec.paths[`${base}/revision`].get.responses).toHaveProperty('200');
    expect(spec.paths[`${base}/ls`].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'consistency', in: 'query', required: false }),
      ]),
    );
    expect(spec.paths[`${base}/ls`].get.responses).toHaveProperty('412');
  });
});

it('snapshot mutation과 content의 계약을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, { parameters: unknown[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, { required: string[] }> };
  };
  const base = '/api/v1/namespaces/{namespaceId}/fs/snapshots';
  for (const path of [base, `${base}/{snapshotId}/delete`]) {
    expect(spec.paths[path].post.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
        expect.objectContaining({ name: 'X-Mutation-Scope', in: 'header', required: true }),
      ]),
    );
    expect(spec.paths[path].post.responses).toHaveProperty('409.headers.Retry-After.schema.type', 'integer');
    expect(Object.keys(spec.paths[path].post.responses)).toEqual(
      expect.arrayContaining(['400', '404', '409', '413']),
    );
  }
  expect(spec.paths[base].post.responses).toHaveProperty('201');
  expect(spec.paths[`${base}/{snapshotId}/content`].get.responses).toHaveProperty('206');
  expect(spec.components.schemas.SnapshotMetadata.required).toEqual(
    expect.arrayContaining([
      'snapshotId',
      'kind',
      'sourcePath',
      'sourceRevision',
      'nodeCount',
      'logicalBytes',
      'createdAt',
    ]),
  );
});

it('FILE restore는 조건과 생성/교체/충돌 응답을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const operation = spec.paths['/api/v1/namespaces/{namespaceId}/fs/snapshots/{snapshotId}/restore']?.post;
  expect(operation).toBeDefined();
  expect(Object.keys(operation.responses)).toEqual(
    expect.arrayContaining(['200', '201', '400', '404', '409', '412', '428']),
  );
  expect(spec.components.schemas.SnapshotRestoreRequest.oneOf).toHaveLength(2);
});

it('TREE entries는 snapshot cursor와 공개 manifest page를 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const base = '/api/v1/namespaces/{namespaceId}/fs/snapshots';
  const entries = spec.paths[`${base}/{snapshotId}/entries`]?.get;
  expect(entries).toBeDefined();
  expect(entries.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'cursor', in: 'query' }),
      expect.objectContaining({
        name: 'limit',
        in: 'query',
        schema: expect.objectContaining({ default: 100, maximum: 1000 }),
      }),
    ]),
  );
  expect(spec.components.schemas.SnapshotEntryPage.required).toEqual(['items', 'nextCursor']);
  expect(spec.paths[`${base}/{snapshotId}/content`].get.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'path', in: 'query' })]),
  );
});

it('412 응답은 current를 포함하는 전용 스키마를 참조한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const base = '/api/v1/namespaces/{namespaceId}/fs';
  const operations = [
    spec.paths[`${base}/mutations`].post,
    spec.paths[`${base}/content/conditional`].post,
    spec.paths[`${base}/ls`].get,
    spec.paths[`${base}/snapshots`].post,
    spec.paths[`${base}/snapshots/{snapshotId}/restore`].post,
  ];
  for (const operation of operations) {
    expect(operation.responses['412'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/PreconditionFailedResponse',
    });
  }
  const schema = spec.components.schemas.PreconditionFailedResponse;
  expect(schema.allOf).toContainEqual({ $ref: '#/components/schemas/ErrorResponse' });
  expect(schema.allOf).toContainEqual(
    expect.objectContaining({
      required: ['current'],
      properties: { current: { $ref: '#/components/schemas/PreconditionFailedCurrent' } },
    }),
  );
});

it('412 current 스키마는 VfsNode 필드에 revision을 더하고 null을 허용한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const current = spec.components.schemas.PreconditionFailedCurrent;
  const node = spec.components.schemas.VfsNode;
  // OAS 3.0.3에서 nullable은 같은 객체에 type이 있어야 유효하다.
  expect(current.type).toBe('object');
  expect(current.nullable).toBe(true);
  expect(current.allOf).toBeUndefined();
  expect(current.required).toEqual([...node.required, 'revision']);
  expect(Object.keys(current.properties)).toEqual([...Object.keys(node.properties), 'revision']);
  const withoutDescription = (property: Record<string, unknown>) => {
    const copy = { ...property };
    delete copy.description;
    return copy;
  };
  for (const key of Object.keys(node.properties)) {
    expect(withoutDescription(current.properties[key])).toEqual(withoutDescription(node.properties[key]));
  }
  expect(current.properties.revision).toEqual(expect.objectContaining({ type: 'string', pattern: '^r1\\.' }));
  // 다른 응답의 VfsNode에는 revision을 넣지 않는다.
  expect(node.properties.revision).toBeUndefined();
  expect(node.required).not.toContain('revision');
});

it('FILE snapshot 생성은 선택 sourceRevision을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const create = spec.paths['/api/v1/namespaces/{namespaceId}/fs/snapshots'].post;
  const body = create.requestBody.content['application/json'].schema;
  expect(body.required).toEqual(['kind', 'path']);
  expect(body.properties.sourceRevision).toEqual(
    expect.objectContaining({ type: 'string', pattern: '^r1\\.' }),
  );
  expect(Object.keys(create.responses)).toEqual(
    expect.arrayContaining(['201', '400', '404', '409', '412', '413']),
  );
});
