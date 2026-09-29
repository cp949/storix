import { execFileSync } from 'node:child_process';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { findFreePort } from './server.ts';
import { waitUntil } from './wait.ts';

const IMAGE = 'versity/versitygw:v1.8.0';
/** 러너가 띄우는 컨테이너 이름 접두어. 시작 시 이 접두어의 잔여 컨테이너를 모두 제거한다. */
export const CONTAINER_PREFIX = 'storix-contract-';
const ACCESS_KEY = 'storix';
const SECRET_KEY = 'storix-secret';
const BUCKET = 'storix';

/** 기동한 blob 저장소. */
export interface BlobStorageHandle {
  /** API 서버에 전달할 `STORIX_STORAGE_*` */
  readonly env: Readonly<Record<string, string>>;

  /** 컨테이너를 제거한다. */
  stop(): Promise<void>;

  /** 컨테이너를 멈춘다(`docker stop`). 멈춘 동안 저장소 접근은 연결 거부로 실패한다. */
  interrupt(): Promise<void>;

  /** 멈춘 컨테이너를 같은 포트·같은 데이터로 다시 시작하고 준비될 때까지 기다린다. */
  resume(): Promise<void>;

  /** 멈춘 상태면 다시 시작한다. 러너가 계약이 끝날 때마다 호출해 실패한 계약이 저장소를 멈춘 채 두지 않게 한다. */
  ensureRunning(): Promise<void>;

  /** 버킷의 객체를 모두 지운다. 메타데이터가 가리키는 객체를 저장소가 잃은 상태를 만든다. */
  deleteAllObjects(): Promise<void>;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8' }).trim();
}

/**
 * 이전 실행이 남긴 `storix-contract-` 컨테이너를 모두 제거한다.
 * `pnpm contract`를 동시에 두 번 실행하지 않는다는 전제에서만 안전하다.
 */
export function removeStaleContainers(): void {
  const ids = docker(['ps', '-aq', '--filter', `name=${CONTAINER_PREFIX}`]);
  if (ids.length > 0) {
    docker(['rm', '-f', '-v', ...ids.split('\n')]);
  }
}

/**
 * VersityGW(posix 백엔드) 컨테이너를 기동하고 버킷을 만든다.
 * 호스트 포트는 `127.0.0.1`의 비어 있는 포트를 고정해 쓴다. 임의 포트(`-p 127.0.0.1::7070`)는
 * `docker stop` 뒤 `docker start`에서 바뀌어 저장 장애 계약이 같은 주소로 저장소를 되살릴 수 없다.
 * 설정은 `docker-compose.versitygw.yml`과 같다.
 */
export async function startBlobStorage(runId: string): Promise<BlobStorageHandle> {
  removeStaleContainers();
  const name = `${CONTAINER_PREFIX}vgw-${runId}`;
  const port = await findFreePort();
  docker([
    'run',
    '-d',
    '--name',
    name,
    // posix 백엔드는 /data가 있어야 기동한다. compose의 볼륨에 해당하며, 컨테이너를 지울 때 함께 지운다.
    '-v',
    '/data',
    '-p',
    `127.0.0.1:${port}:7070`,
    '-e',
    `ROOT_ACCESS_KEY=${ACCESS_KEY}`,
    '-e',
    `ROOT_SECRET_KEY=${SECRET_KEY}`,
    '-e',
    'VGW_BACKEND=posix',
    '-e',
    'VGW_BACKEND_ARGS=/data',
    '-e',
    'VGW_ARGS=--health /health',
    IMAGE,
  ]);
  const stop = async (): Promise<void> => {
    docker(['rm', '-f', '-v', name]);
  };
  try {
    const waitHealthy = (): Promise<void> =>
      waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 200, {
        timeoutMs: 30_000,
        description: 'VersityGW 준비',
      });
    await waitHealthy();
    const s3 = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    let interrupted = false;
    const resume = async (): Promise<void> => {
      docker(['start', name]);
      await waitHealthy();
      interrupted = false;
    };
    return {
      env: {
        STORIX_STORAGE_ENDPOINT: '127.0.0.1',
        STORIX_STORAGE_PORT: String(port),
        STORIX_STORAGE_USE_SSL: 'false',
        STORIX_STORAGE_ACCESS_KEY: ACCESS_KEY,
        STORIX_STORAGE_SECRET_KEY: SECRET_KEY,
        STORIX_STORAGE_BUCKET: BUCKET,
        STORIX_STORAGE_PATH_STYLE: 'true',
      },
      stop,
      async interrupt(): Promise<void> {
        docker(['stop', '-t', '2', name]);
        interrupted = true;
      },
      resume,
      async ensureRunning(): Promise<void> {
        if (interrupted) await resume();
      },
      async deleteAllObjects(): Promise<void> {
        for (;;) {
          const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }));
          const keys = (listed.Contents ?? []).map((item) => ({ Key: item.Key! }));
          if (keys.length === 0) return;
          await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
        }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
