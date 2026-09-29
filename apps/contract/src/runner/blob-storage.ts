import { execFileSync } from 'node:child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { waitUntil } from './wait.ts';

const IMAGE = 'versity/versitygw:v1.8.0';
const CONTAINER_PREFIX = 'storix-contract-';
const ACCESS_KEY = 'storix';
const SECRET_KEY = 'storix-secret';
const BUCKET = 'storix';

/** 기동한 blob 저장소. */
export interface BlobStorageHandle {
  /** API 서버에 전달할 `STORIX_STORAGE_*` */
  readonly env: Readonly<Record<string, string>>;

  /** 컨테이너를 제거한다. */
  stop(): Promise<void>;
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
 * 호스트 포트는 `127.0.0.1`의 임의 포트다. 설정은 `docker-compose.versitygw.yml`과 같다.
 */
export async function startBlobStorage(runId: string): Promise<BlobStorageHandle> {
  removeStaleContainers();
  const name = `${CONTAINER_PREFIX}vgw-${runId}`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    // posix 백엔드는 /data가 있어야 기동한다. compose의 볼륨에 해당하며, 컨테이너를 지울 때 함께 지운다.
    '-v',
    '/data',
    '-p',
    '127.0.0.1::7070',
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
    const port = Number(/:(\d+)$/m.exec(docker(['port', name, '7070/tcp']))![1]);
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/health`)).status === 200, {
      timeoutMs: 30_000,
      description: 'VersityGW 준비',
    });
    const s3 = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true,
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
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
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
