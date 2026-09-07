import { createWriteStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { BackupRepository } from '../persistence/backup.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { PgConnectionOptions, PgDumpCliTool } from './pg-dump-cli.tool.js';

export interface BackupResult {
  readonly backupDir: string;
  readonly encryptedNamespaceCount: number;
  readonly copiedObjectCount: number;
}

// 콜론이 포함된 ISO 문자열은 디렉터리명으로 그대로 못 쓰는 파일시스템이 있어
// 대시로 바꾼다. 정렬 순서와 가독성은 그대로 유지된다.
function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

@Injectable()
export class BackupJob {
  private readonly logger = new Logger(BackupJob.name);
  private readonly backupRootDir: string;
  private readonly connectionOptions: PgConnectionOptions;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly backupRepository: BackupRepository,
    private readonly pgTool: PgDumpCliTool,
    config: ConfigService,
  ) {
    this.backupRootDir = config.getOrThrow<string>('BACKUP_DIR');
    this.connectionOptions = {
      host: config.getOrThrow<string>('DB_HOST'),
      port: parsePositiveInt(config.get<string>('DB_PORT'), 5432),
      username: config.getOrThrow<string>('DB_USERNAME'),
      password: config.getOrThrow<string>('DB_PASSWORD'),
      database: config.getOrThrow<string>('DB_NAME'),
    };
  }

  async run(): Promise<BackupResult> {
    const backupDir = path.join(this.backupRootDir, formatBackupTimestamp(new Date()));
    await fs.mkdir(backupDir, { recursive: true });

    const encryptedNamespaceCount = await this.backupRepository.countEncryptedNamespaces();
    if (encryptedNamespaceCount > 0) {
      this.logger.warn(
        `ENCRYPTED namespace ${encryptedNamespaceCount}건 발견 — ENCRYPTION_MASTER_KEY를 이 백업과 별도 채널에 백업했는지 확인하십시오. 마스터 키는 이 백업에 포함되지 않습니다.`,
      );
    }

    // Postgres 스냅샷을 MinIO보다 먼저 뜬다 — 업로드가 object-먼저-metadata-나중
    // 순서이므로(content.service.ts), 이 순서에서만 Postgres 스냅샷이 참조하는
    // 모든 blob이 이미 MinIO에 존재함이 보장된다(ADR-0015).
    await this.pgTool.dump(this.connectionOptions, path.join(backupDir, 'postgres.dump'));

    const copiedObjectCount = await this.mirrorObjectsToLocalDir(backupDir);

    this.logger.log(`백업 완료: ${backupDir} (object ${copiedObjectCount}건)`);
    return { backupDir, encryptedNamespaceCount, copiedObjectCount };
  }

  private async mirrorObjectsToLocalDir(backupDir: string): Promise<number> {
    const minioDir = path.join(backupDir, 'minio');
    let count = 0;
    for await (const item of this.storage.list()) {
      const destPath = path.join(minioDir, item.key);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const stream = await this.storage.get(item.key);
      await pipeline(stream, createWriteStream(destPath));
      count += 1;
    }
    return count;
  }
}
