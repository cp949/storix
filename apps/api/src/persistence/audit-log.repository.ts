import { Injectable } from '@nestjs/common';
import { DataSource, QueryDeepPartialEntity } from 'typeorm';
import { AuditLogEntity } from './entities/audit-log.entity.js';

export interface AuditLogEntry {
  readonly requestId: string;
  readonly namespaceId: string | null;
  readonly operation: string;
  readonly path: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly caller: string | null;
  readonly status: number;
}

@Injectable()
export class AuditLogRepository {
  constructor(private readonly dataSource: DataSource) {}

  async record(entry: AuditLogEntry): Promise<void> {
    const repo = this.dataSource.getRepository(AuditLogEntity);
    await repo.insert(repo.create(entry) as QueryDeepPartialEntity<AuditLogEntity>);
  }
}
