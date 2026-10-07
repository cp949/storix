/**
 * 운영 CLI의 stdout에는 manifest만 출력한다.
 * - 종료 확인은 관리자의 외부 확인이다.
 * - 규칙은 api ADR-0045다.
 */
import { NestFactory } from '@nestjs/core';
import { readFile } from 'node:fs/promises';
import { bootstrapWithEnv } from '../common/bootstrap-with-env.js';

interface Arguments {
  /** 실행할 운영 명령이다. */
  readonly command: string;

  /** 명령에 전달할 인자다. */
  readonly values: readonly string[];
}

/** pnpm이 전달한 선행 구분자를 제거한 뒤 운영 명령을 읽는다. */
function parseArguments(args: readonly string[]): Arguments {
  const [command, ...values] = args[0] === '--' ? args.slice(1) : args;
  if (!command) throw new Error(usage());
  return { command, values };
}

/** 운영자의 writer 종료 확인과 manifest 승인에 필요한 명령 형식을 반환한다. */
function usage(): string {
  return [
    '사용법:',
    '  confirm-stopped <execution-id> --writer-stopped --evidence <text>',
    '  list-legacy',
    '  abort-legacy --manifest <file> --sha256 <digest> --all-writers-and-gc-stopped',
  ].join('\n');
}

/** 설정·DB를 초기화하고 운영 명령을 실행한다. 진단과 완료 결과는 stderr에 출력한다. */
async function bootstrap(): Promise<void> {
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    const parsed = parseArguments(process.argv.slice(2));
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
    if (parsed.command === 'confirm-stopped') {
      if (
        parsed.values.length !== 4 ||
        parsed.values[1] !== '--writer-stopped' ||
        parsed.values[2] !== '--evidence' ||
        !parsed.values[3]?.trim()
      ) {
        throw new Error(usage());
      }
      const confirmed = await app
        .get(StoragePutOwnershipRepository)
        .confirmExecutionStopped(parsed.values[0], parsed.values[3]);
      if (!confirmed) throw new Error(`등록되지 않은 실행 식별자: ${parsed.values[0]}`);
      process.stderr.write(
        `관리자 writer 종료 확인을 기록함: ${parsed.values[0]}. CLI는 종료를 자동 증명하지 않으며 gateway worker 종료나 예약량 해제를 뜻하지 않는다.\n`,
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
      process.stderr.write(`승인 manifest multipart abort 완료: ${aborted}건\n`);
    } else {
      throw new Error(usage());
    }
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `storage PUT 운영 명령 실패: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await app?.close();
  }
}

bootstrap();
