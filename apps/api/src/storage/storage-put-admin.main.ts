import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import { bootstrapWithEnv } from '../common/bootstrap-with-env.js';

interface Arguments {
  readonly command: string;
  readonly values: readonly string[];
}

function parseArguments(args: readonly string[]): Arguments {
  const [command, ...values] = args;
  if (!command) throw new Error(usage());
  return { command, values };
}

function usage(): string {
  return [
    '사용법:',
    '  confirm-stopped <execution-id> --writer-and-storage-worker-stopped',
    '  list-legacy',
    '  abort-legacy --manifest <file> --sha256 <digest> --all-writers-and-gc-stopped',
  ].join('\n');
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('StoragePutAdmin');
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    const [{ StoragePutAdminModule }, { StoragePutAdminService }, { StoragePutOwnershipRepository }] =
      await bootstrapWithEnv(async () =>
        Promise.all([
          import('./storage-put-admin.module.js'),
          import('./storage-put-admin.service.js'),
          import('../persistence/storage-put-ownership.repository.js'),
        ]),
      );
    app = await NestFactory.createApplicationContext(StoragePutAdminModule, {
      abortOnError: false,
      logger: false,
    });
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.command === 'confirm-stopped') {
      if (parsed.values.length !== 2 || parsed.values[1] !== '--writer-and-storage-worker-stopped') {
        throw new Error(usage());
      }
      const confirmed = await app
        .get(StoragePutOwnershipRepository)
        .confirmExecutionStopped(parsed.values[0]);
      if (!confirmed) throw new Error(`등록되지 않은 실행 식별자: ${parsed.values[0]}`);
      logger.warn(
        `관리자 종료 확인을 기록함: ${parsed.values[0]}. 실제 writer와 storage worker 종료를 외부에서 확인했음을 뜻하며 CLI가 종료를 자동 증명하지 않는다.`,
      );
    } else if (parsed.command === 'list-legacy') {
      if (parsed.values.length !== 0) throw new Error(usage());
      process.stdout.write(
        `${JSON.stringify(await app.get(StoragePutAdminService).createLegacyManifest(), null, 2)}\n`,
      );
    } else if (parsed.command === 'abort-legacy') {
      const manifestIndex = parsed.values.indexOf('--manifest');
      const hashIndex = parsed.values.indexOf('--sha256');
      if (
        manifestIndex < 0 ||
        hashIndex < 0 ||
        parsed.values[manifestIndex + 1] === undefined ||
        parsed.values[hashIndex + 1] === undefined ||
        !parsed.values.includes('--all-writers-and-gc-stopped') ||
        parsed.values.length !== 5
      ) {
        throw new Error(usage());
      }
      const manifest = JSON.parse(await readFile(parsed.values[manifestIndex + 1], 'utf8')) as {
        uploads: readonly { key: string; uploadId: string; initiated: string }[];
      };
      const aborted = await app
        .get(StoragePutAdminService)
        .abortLegacyManifest(manifest, parsed.values[hashIndex + 1]);
      logger.log(`승인 manifest multipart abort 완료: ${aborted}건`);
    } else {
      throw new Error(usage());
    }
    process.exitCode = 0;
  } catch (error) {
    logger.error('storage PUT 운영 명령 실패', error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

bootstrap();
