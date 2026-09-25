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
      ...controllerRoutes(FsController),
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
