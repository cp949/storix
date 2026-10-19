// PostgreSQL·S3 Testcontainers에서 extract HTTP 계약을 실행한다. 시나리오 본문은 extract-http.test-support.ts다.
// 실제 body parser, controller, receipt, VFS 트랜잭션, S3 PUT·range GET을 거친다.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { ArchiveGate } from '../../src/vfs/archive-gate.js';
import { EXTRACT_GATE } from '../../src/vfs/extract-config.js';
import { registerExtractHttpScenarios } from './extract-http.test-support.js';
import { createFsHttpFixture } from './fs-http-fixture.test-support.js';

describe('extract HTTP PostgreSQL 계약 검증', () => {
  const ctx = createFsHttpFixture({ enableExtract: true, useDomainErrorFilter: true });

  registerExtractHttpScenarios({
    server: () => ctx.httpServer,
    headers: () => ({}),
    createNamespace: async (options = {}) => {
      const response = await request(ctx.httpServer)
        .post('/api/v2/namespaces')
        .set('Idempotency-Key', randomUUID())
        .send({
          name: `extract-${randomUUID()}`,
          ...(options.encrypted ? { encryptionPolicy: 'ENCRYPTED' } : {}),
        })
        .expect(201);
      const id = response.body.id as string;
      if (options.trashEnabled)
        await ctx.migrationDataSource.getRepository(NamespaceEntity).update({ id }, { trashEnabled: true });
      return id;
    },
    dataSource: () => ctx.migrationDataSource,
    storage: () => ctx.app.get<BlobStorage>(BLOB_STORAGE),
    storageKeys: async () => {
      const keys: string[] = [];
      for await (const item of ctx.app.get<BlobStorage>(BLOB_STORAGE).list('')) keys.push(item.key);
      return keys;
    },
    capabilities: () => ctx.app.get(CapabilityService),
    gate: () => ctx.app.get<ArchiveGate>(EXTRACT_GATE),
  });
});
