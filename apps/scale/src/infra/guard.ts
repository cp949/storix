import { createHash } from 'node:crypto';

/**
 * 실험 대상 보호 장치. 대량 적재·reset은 이 하네스가 만든 전용 컨테이너·database에만 허용한다.
 * 운영 접속값은 받지 않는다. 호스트는 항상 127.0.0.1이고 database 이름은 `storix_scale_` 접두어다.
 */

/** 하네스가 만드는 컨테이너 이름 접두어 */
export const CONTAINER_PREFIX = 'storix-scale-';

/** 하네스가 만드는 database 이름 접두어 */
export const DATABASE_PREFIX = 'storix_scale_';

/** 하네스가 쓰는 PostgreSQL 컨테이너 이름 */
export const POSTGRES_CONTAINER = `${CONTAINER_PREFIX}pg`;

/** 하네스가 쓰는 VersityGW 컨테이너 이름 */
export const STORAGE_CONTAINER = `${CONTAINER_PREFIX}vgw`;

/** database 이름이 실험 대상인지 확인한다. 아니면 던진다. */
export function assertExperimentDatabase(name: string): void {
  if (!/^storix_scale_[a-z0-9_]{1,40}$/.test(name))
    throw new Error(`실험 대상 database가 아니다: ${name} (접두어 ${DATABASE_PREFIX}, 소문자·숫자·밑줄만)`);
}

/** 컨테이너 이름이 실험 대상인지 확인한다. 아니면 던진다. */
export function assertExperimentContainer(name: string): void {
  if (!name.startsWith(CONTAINER_PREFIX)) throw new Error(`실험 대상 컨테이너가 아니다: ${name}`);
}

/** 접속 호스트가 루프백인지 확인한다. 아니면 던진다. */
export function assertLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost')
    throw new Error(`루프백이 아닌 호스트는 거부한다: ${host}`);
}

/** 규모와 seed로 기준(template) database 이름을 만든다. */
export function templateDatabaseName(namespaces: number, seed: string): string {
  const tag = seed.toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = `${DATABASE_PREFIX}t_${namespaces}_${tag}`.slice(0, 63);
  assertExperimentDatabase(name);
  return name;
}

/** 측정 실행용 작업 database 이름을 만든다. 긴 runId는 해시로 줄여 `kind`(api·gc 등) 구분이 잘리지 않게 한다. */
export function runDatabaseName(runId: string, kind: string): string {
  const id = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const name = `${DATABASE_PREFIX}r_${kind.toLowerCase().replace(/[^a-z0-9]/g, '')}_${id}`;
  assertExperimentDatabase(name);
  return name;
}
