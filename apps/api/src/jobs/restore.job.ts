import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseBoolean } from '../common/env-parsing.js';
import { BackupRepository } from '../persistence/backup.repository.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { DB_DUMP_TOOL, type DbDumpTool } from './db-dump.tool.js';
import { RestoreTargetNotEmptyError, RestoreUnsupportedBackupError } from './restore.errors.js';

export interface RestoreResult {
  readonly sourceDir: string;
  readonly restoredObjectCount: number;
}

@Injectable()
export class RestoreJob {
  private readonly logger = new Logger(RestoreJob.name);
  private readonly sourceDir: string;
  private readonly force: boolean;

  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    private readonly backupRepository: BackupRepository,
    @Inject(DB_DUMP_TOOL) private readonly dumpTool: DbDumpTool,
    config: ConfigService,
  ) {
    // docker-compose는 STORIX_RESTORE_SOURCE_DIR를 `${STORIX_RESTORE_SOURCE_DIR:-}`로 넘기므로
    // 미설정 시 빈 문자열이 들어온다. ConfigService.getOrThrow는 undefined일 때만
    // 던지고 빈 문자열은 그대로 통과시키므로(빈 값이면 sourceDir이 ''가 되어
    // 상대경로를 보게 된다), 빈 값도 여기서 함께 막는다.
    this.sourceDir = config.getOrThrow<string>('STORIX_RESTORE_SOURCE_DIR');
    if (this.sourceDir.trim() === '') {
      throw new Error(
        'STORIX_RESTORE_SOURCE_DIR가 비어 있음 — 복구할 백업 디렉터리를 지정하십시오(예: /backups/2026-09-08T12-00-00-000Z)',
      );
    }
    this.force = parseBoolean(config.get<string>('STORIX_RESTORE_FORCE'), false);
  }

  async run(): Promise<RestoreResult> {
    // 파괴적 작업(clearExistingObjects/dump 복구)에 들어가기 전에 백업 실체부터
    // 확인한다. 경로 오타로 force 복구를 돌리면 대상 버킷만 비워 두고 복구가
    // 실패해, 복구 전보다 나쁜 상태로 끝난다. ENOENT를 그대로 올려보내 어떤
    // 파일이 없는지 스택에 남긴다.
    const dumpFilePath = path.join(this.sourceDir, this.dumpTool.dumpFileName);
    await fs.access(dumpFilePath);
    // 'blobs/' 대신 다른 미러 디렉터리가 있는 백업은 dump만 복구되고 blob 참조가 끊긴 채 성공으로
    // 끝난다. 파괴적 작업 전에 알려진 구조인지 확인한다.
    await this.assertSupportedLayout();

    const hasExistingData = await this.backupRepository.hasExistingNamespaces();
    if (hasExistingData && !this.force) {
      throw new RestoreTargetNotEmptyError();
    }

    // DB 복구가 먼저다. pg_restore가 실패(예: client·서버 major 불일치로 exit 1)했을 때
    // 스토리지 object를 이미 지워 두면 버킷이 빈 채로 남기 때문이다. 실패하면 object를
    // 건드리지 않은 채 던지고, 같은 백업으로 재실행하면 이어서 복구된다.
    await this.dumpTool.restore(dumpFilePath);

    const { restoredObjectCount, backupKeys } = await this.restoreObjectsFromLocalDir(this.sourceDir);

    if (this.force) {
      // force 복구는 "대상이 백업과 정확히 같아진다"는 보장을 주기 위해 백업에 없는
      // object를 지운다. 복원이 끝난 뒤에 지우므로 put 도중 실패해도 기존 object는
      // 남고, 이 단계가 실패해도 재실행하면 같은 결과로 이어진다.
      await this.deleteObjectsNotInBackup(backupKeys);
    }

    this.logger.log(`복구 완료: ${this.sourceDir} (object ${restoredObjectCount}건)`);
    return { sourceDir: this.sourceDir, restoredObjectCount };
  }

  private async assertSupportedLayout(): Promise<void> {
    const entries = await fs.readdir(this.sourceDir, { withFileTypes: true });
    const unknownDirectories = entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'blobs')
      .map((entry) => entry.name);
    if (unknownDirectories.length > 0) {
      throw new RestoreUnsupportedBackupError(unknownDirectories);
    }
  }

  private async deleteObjectsNotInBackup(backupKeys: ReadonlySet<string>): Promise<void> {
    for await (const item of this.storage.list()) {
      if (!backupKeys.has(item.key)) {
        await this.storage.delete(item.key);
      }
    }
  }

  private async restoreObjectsFromLocalDir(
    sourceDir: string,
  ): Promise<{ restoredObjectCount: number; backupKeys: ReadonlySet<string> }> {
    const blobDir = path.join(sourceDir, 'blobs');
    if (!(await this.pathExists(blobDir))) {
      // 백업 시점에 스토리지 object가 하나도 없었다면 BackupJob이 'blobs/'
      // 디렉터리 자체를 만들지 않는다(mirrorObjectsToLocalDir의 mkdir이
      // list() 루프 본문 안에서만 실행되므로). 이 경우는 정상적인
      // "object 0건짜리 백업"이지 오류가 아니다.
      return { restoredObjectCount: 0, backupKeys: new Set() };
    }

    const filePaths = await this.listFilesRecursively(blobDir);
    const backupKeys = new Set<string>();
    for (const filePath of filePaths) {
      const key = path.relative(blobDir, filePath).split(path.sep).join('/');
      await this.storage.put(key, createReadStream(filePath));
      backupKeys.add(key);
    }
    return { restoredObjectCount: backupKeys.size, backupKeys };
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
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
