import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseBoolean, parsePositiveInt } from '../common/env-parsing.js';
import { BackupRepository } from '../persistence/backup.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { PgConnectionOptions, PgDumpCliTool } from './pg-dump-cli.tool.js';
import { RestoreTargetNotEmptyError } from './restore.errors.js';

export interface RestoreResult {
  readonly sourceDir: string;
  readonly restoredObjectCount: number;
}

@Injectable()
export class RestoreJob {
  private readonly logger = new Logger(RestoreJob.name);
  private readonly sourceDir: string;
  private readonly force: boolean;
  private readonly connectionOptions: PgConnectionOptions;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly backupRepository: BackupRepository,
    private readonly pgTool: PgDumpCliTool,
    config: ConfigService,
  ) {
    this.sourceDir = config.getOrThrow<string>('RESTORE_SOURCE_DIR');
    this.force = parseBoolean(config.get<string>('RESTORE_FORCE'), false);
    this.connectionOptions = {
      host: config.getOrThrow<string>('DB_HOST'),
      port: parsePositiveInt(config.get<string>('DB_PORT'), 5432),
      username: config.getOrThrow<string>('DB_USERNAME'),
      password: config.getOrThrow<string>('DB_PASSWORD'),
      database: config.getOrThrow<string>('DB_NAME'),
    };
  }

  async run(): Promise<RestoreResult> {
    const hasExistingData = await this.backupRepository.hasExistingNamespaces();
    if (hasExistingData && !this.force) {
      throw new RestoreTargetNotEmptyError();
    }

    if (this.force) {
      // pg_restore --clean --if-exists와 대칭 — force 복구는 "대상이 백업과
      // 정확히 같아진다"는 보장을 즉시 주기 위해 기존 object를 먼저 지운다.
      // (지우지 않아도 언젠가 GC job의 orphan-object 경로가 정리하지만,
      // force 복구의 의도는 즉시·확정적인 교체다.)
      await this.clearExistingObjects();
    }

    await this.pgTool.restore(this.connectionOptions, path.join(this.sourceDir, 'postgres.dump'));

    const restoredObjectCount = await this.restoreObjectsFromLocalDir(this.sourceDir);

    this.logger.log(`복구 완료: ${this.sourceDir} (object ${restoredObjectCount}건)`);
    return { sourceDir: this.sourceDir, restoredObjectCount };
  }

  private async clearExistingObjects(): Promise<void> {
    for await (const item of this.storage.list()) {
      await this.storage.delete(item.key);
    }
  }

  private async restoreObjectsFromLocalDir(sourceDir: string): Promise<number> {
    const minioDir = path.join(sourceDir, 'minio');
    const filePaths = await this.listFilesRecursively(minioDir);
    let count = 0;
    for (const filePath of filePaths) {
      const key = path.relative(minioDir, filePath).split(path.sep).join('/');
      await this.storage.put(key, createReadStream(filePath));
      count += 1;
    }
    return count;
  }

  private async listFilesRecursively(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursively(fullPath)));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }
}
