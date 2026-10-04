import { NamespaceDeletionController } from '../../src/namespace/namespace-deletion.controller.js';
import { VfsSnapshotController } from '../../src/vfs/vfs-snapshot.controller.js';
import { VfsTrashController } from '../../src/vfs/vfs-trash.controller.js';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { parse } from 'yaml';
import { FsController } from '../../src/vfs/fs.controller.js';
import { ChangeFeedController } from '../../src/vfs/change-feed.controller.js';
import { PublicFsController } from '../../src/vfs/public-fs.controller.js';
import { UploadSessionController } from '../../src/vfs/upload-session.controller.js';
import { NamespaceController } from '../../src/namespace/namespace.controller.js';
import { NamespaceQuotaController } from '../../src/namespace/namespace-quota.controller.js';
import { NamespaceTrashPolicyController } from '../../src/namespace/namespace-trash-policy.controller.js';
import { NamespaceSettingsController } from '../../src/namespace/namespace-settings.controller.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

// openapi.yaml은 수기 작성이라 컨트롤러 라우트와 조용히 어긋날 수 있다(ADR-0019).
// 라우트 집합과 일부 공개 API의 필수 파라미터·응답 계약을 검증한다.

type ControllerClass = new (...args: never[]) => object;

type OpenApiSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean;
};

type OpenApiOperation = {
  security?: unknown;
  parameters?: unknown[];
  requestBody?: { content: Record<string, { schema?: OpenApiSchema }> };
  responses: Record<string, { description?: string; headers?: Record<string, { description?: string }> }>;
};

type OpenApiDocument = {
  paths: Record<string, { patch?: OpenApiOperation; post?: OpenApiOperation }>;
  components: {
    parameters: Record<string, { name?: string; in?: string; required?: boolean }>;
    schemas: Record<string, OpenApiSchema>;
  };
};

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
      ...controllerRoutes(NamespaceTrashPolicyController),
      ...controllerRoutes(NamespaceSettingsController),
      ...controllerRoutes(NamespaceDeletionController),
      ...controllerRoutes(FsController),
      ...controllerRoutes(ChangeFeedController),
      ...controllerRoutes(VfsSnapshotController),
      ...controllerRoutes(VfsTrashController),
      ...controllerRoutes(PublicFsController),
      ...controllerRoutes(UploadSessionController),
    ].sort();

    expect(specRoutes().sort()).toEqual(codeRoutes);
  });

  it('namespace 삭제 접수와 상태 조회는 일시 DB 장애의 503을 공개한다', () => {
    const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
    for (const [path, method] of [
      ['/api/v2/admin/namespaces/{namespaceId}/delete', 'post'],
      ['/api/v2/admin/namespaces/{namespaceId}/deletion', 'get'],
    ]) {
      const response = spec.paths[path][method].responses['503'];
      expect(response).toMatchObject({
        description: expect.stringContaining('STORAGE_UNAVAILABLE'),
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      });
    }
  });

  it('namespace 휴지통 정책 변경 경로의 관리자 인증·body·응답 계약을 명시한다', () => {
    const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as OpenApiDocument;
    const operation = spec.paths['/api/v2/admin/namespaces/{namespaceId}/trash'].patch!;
    expect(operation.security).toEqual([{ AdminApiKeyAuth: [] }]);
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'namespaceId', in: 'path', required: true }),
        expect.objectContaining({ $ref: '#/components/parameters/IdempotencyKeyHeader' }),
      ]),
    );
    expect(spec.components.parameters.IdempotencyKeyHeader).toMatchObject({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
    });
    expect(operation.requestBody!.content['application/json'].schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['enabled'],
      properties: { enabled: { type: 'boolean' } },
    });
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '422']),
    );
    expect(operation.responses['400'].description).toContain('NAMESPACE_INVALID_TRASH_POLICY');
    expect(operation.responses['404'].description).toContain('NAMESPACE_NOT_FOUND');
    expect(operation.responses['422'].description).toContain('IDEMPOTENCY_KEY_REUSED');
    const namespace = spec.components.schemas.Namespace;
    expect(namespace.properties!.quota.properties!.trash.required).toContain('enabled');
    expect(namespace.properties!.quota.properties!.trash.properties!.enabled.type).toBe('boolean');
  });

  it('legacy 삭제의 X-Trash-Id는 휴지통 활성 namespace 응답에만 존재할 수 있다고 명시한다', () => {
    const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as OpenApiDocument;
    const base = '/api/v2/namespaces/{namespaceId}/fs';
    for (const path of ['/rm', '/rmdir']) {
      const response = spec.paths[`${base}${path}`].post!.responses['204'];
      expect(response.description).toContain('비활성 namespace에서는 즉시 영구 삭제');
      expect(response.headers!['X-Trash-Id'].description).toContain('OFF 삭제에는 없다');
    }
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
    const base = '/api/v2/namespaces/{namespaceId}/fs';
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

it('재개 업로드의 다섯 operation과 필수 헤더·응답 스키마를 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const base = '/api/v2/namespaces/{namespaceId}/fs/upload-sessions';
  const operations = [
    spec.paths[base]?.post,
    spec.paths[`${base}/{sessionId}`]?.get,
    spec.paths[`${base}/{sessionId}`]?.delete,
    spec.paths[`${base}/{sessionId}/parts/{index}`]?.put,
    spec.paths[`${base}/{sessionId}/complete`]?.post,
  ];
  expect(operations.every(Boolean)).toBe(true);
  expect(operations.map((operation: { operationId: string }) => operation.operationId)).toEqual([
    'createUploadSession',
    'getUploadSession',
    'cancelUploadSession',
    'putUploadSessionPart',
    'completeUploadSession',
  ]);
  expect(spec.paths[base].post.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      expect.objectContaining({ name: 'X-Mutation-Scope', in: 'header', required: true }),
    ]),
  );
  expect(spec.paths[base].post.requestBody.content['application/json'].schema).toEqual({
    $ref: '#/components/schemas/UploadSessionCreateRequest',
  });
  expect(spec.components.schemas.UploadSessionCreateRequest.oneOf).toHaveLength(2);
  for (const variant of spec.components.schemas.UploadSessionCreateRequest.oneOf) {
    const mime = variant.properties.mimeType;
    expect(mime.maxLength).toBe(255);
    const pattern = new RegExp(mime.pattern);
    expect(pattern.test('application/octet-stream')).toBe(true);
    expect(pattern.test('invalid mime')).toBe(false);
  }
  expect(spec.paths[`${base}/{sessionId}/parts/{index}`].put.requestBody.content).toHaveProperty(
    'application/octet-stream',
  );
  expect(spec.paths[`${base}/{sessionId}/parts/{index}`].put.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'Content-Length', required: true })]),
  );
  expect(spec.components.schemas.UploadSessionStatus.required).toEqual(
    expect.arrayContaining(['state', 'expiresAt', 'parts']),
  );
  expect(spec.components.schemas.UploadPartResult.required).toEqual(
    expect.arrayContaining(['sha256', 'replayed']),
  );
  const created = spec.paths[base].post.responses['201'].content['application/json'].example;
  const part = spec.paths[`${base}/{sessionId}/parts/{index}`].put;
  const status = spec.paths[`${base}/{sessionId}`].get.responses['200'].content['application/json'].example;
  const complete = spec.paths[`${base}/{sessionId}/complete`].post;
  expect(part.requestBody.content['application/octet-stream'].example).toBe('test');
  expect(part.responses['200'].content['application/json'].example).toEqual(
    expect.objectContaining({
      index: 0,
      sizeBytes: '4',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      replayed: false,
    }),
  );
  expect(status).toEqual(
    expect.objectContaining({
      sessionId: created.sessionId,
      path: '/large.bin',
      parts: [{ index: 0, sizeBytes: '4' }],
    }),
  );
  expect(complete.responses['201'].content['application/json'].example).toEqual(
    expect.objectContaining({
      resource: expect.objectContaining({ path: status.path, size: 4 }),
      affectedRevisions: [expect.objectContaining({ path: status.path })],
    }),
  );
  expect(complete.responses['409'].description).not.toMatch(/quota/);
  expect(complete.responses['413'].description).toMatch(/VFS_QUOTA_EXCEEDED/);
  expect(Object.keys(spec.paths[base].post.responses)).toEqual(
    expect.arrayContaining(['201', '400', '401', '404', '409', '412', '413', '428', '429', '500']),
  );
  expect(spec.paths[base].post.responses['429']).toHaveProperty('headers.Retry-After.schema.type', 'integer');
  expect(Object.keys(spec.paths[`${base}/{sessionId}/complete`].post.responses)).toEqual(
    expect.arrayContaining(['200', '201', '401', '404', '409', '412', '413', '500']),
  );
  for (const operation of operations) {
    expect(operation.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' });
  }
});

it('파일 만료 입력·확정·공개 읽기 계약을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const fs = '/api/v2/namespaces/{namespaceId}/fs';
  const node = spec.components.schemas.VfsNode;
  expect(node.required).toContain('expiresAt');
  expect(node.properties.expiresAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });

  const conditional = spec.paths[`${fs}/content/conditional`].post;
  expect(conditional.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'X-Expires-In', in: 'header', required: false }),
    ]),
  );
  expect(conditional.responses['400'].description).toContain('VFS_INVALID_EXPIRY');
  expect(spec.paths[`${fs}/content`].post.description).toContain('VFS_INVALID_EXPIRY');
  expect(spec.paths[`${fs}/cp`].post.description).toContain('VFS_INVALID_EXPIRY');

  const mutations = spec.paths[`${fs}/mutations`].post;
  const variants = mutations.requestBody.content['application/json'].schema.oneOf;
  expect(variants).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        required: ['kind', 'path', 'ifRevision'],
        properties: expect.objectContaining({ kind: { type: 'string', enum: ['persist'] } }),
      }),
    ]),
  );
  expect(
    variants.find((variant: { properties: { kind: { enum: string[] } } }) =>
      variant.properties.kind.enum.includes('copy'),
    ).properties.expiresInSeconds,
  ).toMatchObject({ type: 'integer', minimum: 1 });
  const move = variants.find((variant: { properties: { kind: { enum: string[] } } }) =>
    variant.properties.kind.enum.includes('move'),
  );
  expect(move.properties.kind.enum).toEqual(['move']);
  expect(move.additionalProperties).toBe(false);
  expect(move.properties).not.toHaveProperty('expiresInSeconds');
  expect(mutations.responses['400'].description).toContain('VFS_INVALID_EXPIRY');
  expect(mutations.description).toContain('current.expiresAt');

  const upload = spec.components.schemas.UploadSessionCreateRequest.oneOf[0];
  expect(upload.properties.expiresInSeconds).toMatchObject({ type: 'integer', minimum: 1 });
  expect(
    spec.components.schemas.UploadSessionStatus.properties.condition.oneOf[0].properties.expiresInSeconds,
  ).toMatchObject({ type: 'integer', minimum: 1 });
  expect(spec.paths[`${fs}/upload-sessions`].post.responses['400'].description).toContain(
    'VFS_INVALID_EXPIRY',
  );
  for (const endpoint of ['content', 'download']) {
    expect(
      spec.paths[`/api/v2/public/{namespaceId}/fs/${endpoint}`].get.responses['404'].description,
    ).toContain('만료 예정 파일');
  }
});

it('snapshot mutation과 content의 계약을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, { parameters: unknown[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, { required: string[] }> };
  };
  const base = '/api/v2/namespaces/{namespaceId}/fs/snapshots';
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
      'rootNodeId',
      'sha256',
      'nodeCount',
      'logicalBytes',
      'createdAt',
    ]),
  );
});

it('FILE restore는 조건과 생성/교체/충돌 응답을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const operation = spec.paths['/api/v2/namespaces/{namespaceId}/fs/snapshots/{snapshotId}/restore']?.post;
  expect(operation).toBeDefined();
  expect(Object.keys(operation.responses)).toEqual(
    expect.arrayContaining(['200', '201', '400', '404', '409', '412', '428']),
  );
  expect(spec.components.schemas.SnapshotRestoreRequest.oneOf).toHaveLength(2);
});

it('TREE entries는 snapshot cursor와 공개 manifest page를 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const base = '/api/v2/namespaces/{namespaceId}/fs/snapshots';
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
  const base = '/api/v2/namespaces/{namespaceId}/fs';
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
  const create = spec.paths['/api/v2/namespaces/{namespaceId}/fs/snapshots'].post;
  const body = create.requestBody.content['application/json'].schema;
  expect(body.required).toEqual(['kind', 'path']);
  expect(body.properties.sourceRevision).toEqual(
    expect.objectContaining({ type: 'string', pattern: '^r1\\.' }),
  );
  expect(Object.keys(create.responses)).toEqual(
    expect.arrayContaining(['201', '400', '404', '409', '412', '413']),
  );
});

it('namespace capability 조회는 활성 ID, 인증, 오류 및 캐시 계약을 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const operation = spec.paths['/api/v2/namespaces/{id}/capabilities']?.get;
  expect(operation).toBeDefined();
  expect(operation.security).toEqual([{ ApiKeyAuth: [] }]);
  expect(operation.parameters).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]),
  );
  expect(operation.responses['200']).toEqual(
    expect.objectContaining({
      headers: expect.objectContaining({
        'Cache-Control': expect.objectContaining({
          schema: expect.objectContaining({ enum: ['no-store'] }),
        }),
      }),
      content: {
        'application/json': {
          schema: expect.objectContaining({
            type: 'object',
            required: ['capabilities'],
            properties: {
              capabilities: expect.objectContaining({
                type: 'array',
                minItems: 0,
                items: expect.objectContaining({ type: 'string' }),
              }),
            },
          }),
        },
      },
    }),
  );
  expect(operation.responses['200'].description).toMatch(/사전순/);
  expect(operation.responses['200'].description).toMatch(/의존/);
  expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '404', '500']));
  expect(operation.responses['401']).toEqual({ $ref: '#/components/responses/Unauthorized' });
  expect(operation.responses['404'].description).toMatch(/Namespace ID 형식 오류.*namespace 부재.*ACTIVE/);
  expect(operation.responses['404'].content['application/json'].schema).toEqual({
    $ref: '#/components/schemas/ErrorResponse',
  });
  expect(operation.responses['500']).toEqual({ $ref: '#/components/responses/InternalError' });
});

it('change feed는 checkpoint, 이벤트, cursor 오류와 보존 만료를 명시한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const operation = spec.paths['/api/v2/namespaces/{namespaceId}/fs/changes'].get;
  expect(operation.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'cursor', in: 'query', required: false }),
      expect.objectContaining({ $ref: '#/components/parameters/Limit' }),
    ]),
  );
  expect(Object.keys(operation.responses)).toEqual(
    expect.arrayContaining(['200', '400', '401', '404', '409', '410']),
  );
  expect(operation.responses['200'].content['application/json'].schema).toEqual({
    $ref: '#/components/schemas/ChangeFeedPage',
  });
  expect(spec.components.schemas.ChangeFeedPage.required).toEqual(['changes', 'nextCursor', 'hasMore']);
  expect(spec.components.schemas.ChangeFeedEvent.required).toEqual(
    expect.arrayContaining([
      'sequence',
      'operationId',
      'operationIndex',
      'operationCount',
      'kind',
      'nodeId',
      'nodeType',
      'path',
      'occurredAt',
    ]),
  );
  expect(spec.components.schemas.ChangeFeedEvent.properties.previousPath).toBeDefined();
  expect(spec.components.schemas.ChangeFeedEvent.properties.revision).toBeDefined();
});

it('다섯 Range 조회의 206 식별·구간 헤더와 416 오류 헤더를 공개한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const base = '/api/v2/namespaces/{namespaceId}/fs';
  const publicBase = '/api/v2/public/{namespaceId}/fs';
  const paths = [
    `${base}/content`,
    `${base}/download`,
    `${publicBase}/content`,
    `${publicBase}/download`,
    `${base}/snapshots/{snapshotId}/content`,
  ];
  for (const path of paths) {
    const operation = spec.paths[path].get;
    const partial = operation.responses['206'];
    const unsatisfiable = operation.responses['416'];
    expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/RangeHeader' });
    expect(partial.headers['Content-Range'].schema).toEqual({ type: 'string' });
    expect(partial.headers['Content-Length'].schema).toEqual({ type: 'integer' });
    expect(partial.headers['Accept-Ranges'].schema).toEqual({ type: 'string', enum: ['bytes'] });
    expect(partial.headers['X-Storix-File-Id'].schema).toEqual({ type: 'string', format: 'uuid' });
    expect(partial.headers['X-Storix-Revision'].schema).toEqual({
      type: 'string',
      pattern: '^r1\\.[A-Za-z0-9_-]{32}$',
    });
    expect(partial.headers['X-Storix-Sha256']).toBeUndefined();
    expect(unsatisfiable.headers['Content-Range'].schema).toEqual({ type: 'string' });
    expect(unsatisfiable.headers['Content-Range'].description).toMatch(/bytes \*\/<전체 길이>/);
    expect(unsatisfiable.description).toMatch(/VFS_RANGE_NOT_SATISFIABLE/);
    expect(unsatisfiable.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ErrorResponse',
    });
  }
  const snapshot = spec.paths[paths[4]].get.responses['206'];
  expect(snapshot.headers['X-Storix-Snapshot-Id'].schema).toEqual({ type: 'string', format: 'uuid' });
});

it('Range 요청 설명은 단일 범위 문법과 경계·거부·해시 정책을 공개한다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8'));
  const description = spec.components.parameters.RangeHeader.description as string;
  for (const example of ['bytes=0-1023', 'bytes=500-', 'bytes=-500']) {
    expect(description).toContain(example);
  }
  expect(description).toMatch(/단일/);
  expect(description).toMatch(/clipping/);
  expect(description).toMatch(/suffix.*전체/);
  expect(description).toMatch(/문법.*복수.*충족 불가.*416/s);
  expect(description).toMatch(/206.*X-Storix-Sha256.*제공하지/s);
  expect(description).toMatch(/If-Range.*미지원/);
});

it('노드·폴더·quota 상한 413 코드를 던질 수 있는 operation은 413 응답에 해당 코드를 적는다', () => {
  const spec = parse(readFileSync(join(currentDir, '../../openapi.yaml'), 'utf8')) as {
    info: { description: string };
    paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>>;
  };
  const node = 'VFS_NAMESPACE_NODE_LIMIT_EXCEEDED';
  const folder = 'VFS_FOLDER_FILE_LIMIT_EXCEEDED';
  const quota = 'VFS_QUOTA_EXCEEDED';

  // 오류 표가 세 코드를 413으로 정의한다.
  const errorRow = spec.info.description.split('\n').find((line) => line.includes(`\`${node}\``));
  expect(errorRow).toBeDefined();
  expect(errorRow).toContain('| 413 |');
  for (const code of [node, folder, quota]) expect(errorRow).toContain(`\`${code}\``);

  // 코드는 mutation 트랜잭션의 카운터 반영 단계(applyNodeCounters·applyLogicalByteQuota)가 던진다.
  // operation마다 던질 수 있는 코드를 코드 읽기로 확정한 목록이다. 새 mutation을 추가하면 여기에 더한다.
  const base = '/api/v2/namespaces/{namespaceId}/fs';
  const expected: Array<[string, string[]]> = [
    ['/mkdir', [node]],
    ['/touch', [node, folder]],
    ['/mv', [node, folder]],
    ['/cp', ['VFS_COPY_LIMIT_EXCEEDED', node, folder, quota]],
    ['/content', ['VFS_FILE_TOO_LARGE', node, folder, quota]],
    ['/content/conditional', [node, folder, quota]],
    ['/mutations', [node, folder, quota]],
    ['/upload-sessions/{sessionId}/complete', [node, folder, quota]],
    ['/trash/{trashId}/restore', [node, folder, quota]],
    ['/snapshots', ['VFS_SNAPSHOT_LIMIT_EXCEEDED', quota]],
    ['/snapshots/{snapshotId}/restore', [node, folder, quota]],
  ];
  for (const [suffix, codes] of expected) {
    const description = spec.paths[`${base}${suffix}`].post.responses['413']?.description;
    expect({ suffix, description }).toEqual({ suffix, description: expect.any(String) });
    for (const code of codes)
      expect({ suffix, code, found: description!.includes(code) }).toEqual({ suffix, code, found: true });
  }
});
