/**
 * 데이터셋의 blob 행에 대응하는 실제 storage object 계획과 생성.
 * VersityGW posix 백엔드의 bucket 디렉터리에 파일을 직접 만든다(bind mount). 파일 수정 시각이 object의
 * `LastModified`가 된다. DB 행과 짝이 있는 object(known·orphan)와 DB가 모르는 object(stale)를 구분한다.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { open, utimes } from 'node:fs/promises';
import path from 'node:path';
import { md5Uuid } from './ids.ts';
import type { DatasetSpec } from './spec.ts';

/** 계획한 object 하나. */
export interface PlannedObject {
  readonly key: string;
  readonly kind: 'known' | 'orphan' | 'stale' | 'stale-staging';

  /** 수정 시각을 기준 시각에서 얼마나 앞당길지(일) */
  readonly ageDays: number;
}

function blobKey(id: string): string {
  return `blobs/${id.slice(0, 2)}/${id}`;
}

/** 규모와 무관하게 일정한 메모리로 object 계획을 순회한다. */
export function* planObjects(spec: DatasetSpec): Generator<PlannedObject> {
  const active = Math.floor(spec.namespaces / spec.activeEvery);
  for (let a = 1; a <= active; a++) {
    const i = a * spec.activeEvery;
    for (let k = 1; k <= spec.filesPerActive; k++) {
      yield { key: blobKey(md5Uuid(`${spec.seed}:blob:${i}:${k}`)), kind: 'known', ageDays: 40 };
    }
  }
  for (let o = 1; o <= Math.floor(spec.namespaces / spec.orphanEvery); o++) {
    const i = o * spec.orphanEvery;
    for (let k = 1; k <= spec.orphanBlobsPerDue; k++) {
      yield { key: blobKey(md5Uuid(`${spec.seed}:orphan:${i}:${k}`)), kind: 'orphan', ageDays: 40 };
    }
  }
  for (let n = 1; n <= spec.staleObjects; n++) {
    yield { key: blobKey(md5Uuid(`${spec.seed}:stale:${n}`)), kind: 'stale', ageDays: 60 };
  }
  for (let n = 1; n <= spec.staleStagingObjects; n++) {
    yield {
      key: `upload-staging/${md5Uuid(`${spec.seed}:stale-staging:${n}`)}`,
      kind: 'stale-staging',
      ageDays: 60,
    };
  }
}

/** 계획한 object 수. */
export function expectedObjectCounts(spec: DatasetSpec): Record<PlannedObject['kind'], number> {
  return {
    known: Math.floor(spec.namespaces / spec.activeEvery) * spec.filesPerActive,
    orphan: Math.floor(spec.namespaces / spec.orphanEvery) * spec.orphanBlobsPerDue,
    stale: spec.staleObjects,
    'stale-staging': spec.staleStagingObjects,
  };
}

/** 내용 체크섬. 같은 key는 같은 내용이다(재생성 검증용). */
export function objectContent(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * bucket 디렉터리에 계획한 object를 만든다. 이미 있는 파일은 그대로 두고 없는 것만 만든다.
 * GC가 지운 object를 복원하는 데도 쓴다. 만든 파일 수를 돌려준다.
 */
export async function ensureObjects(
  spec: DatasetSpec,
  bucketDir: string,
  progress: (message: string) => void = () => undefined,
): Promise<{ created: number; total: number }> {
  const mtimeBase = Date.parse(spec.refTime);
  let created = 0;
  let total = 0;
  const made = new Set<string>();
  const pending: Array<Promise<void>> = [];
  const flush = async (): Promise<void> => {
    await Promise.all(pending.splice(0));
  };
  for (const object of planObjects(spec)) {
    total++;
    pending.push(
      (async () => {
        const file = path.join(bucketDir, object.key);
        const dir = path.dirname(file);
        if (!made.has(dir)) {
          mkdirSync(dir, { recursive: true });
          made.add(dir);
        }
        let handle;
        try {
          handle = await open(file, 'wx');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
          throw error;
        }
        try {
          await handle.writeFile(objectContent(object.key));
        } finally {
          await handle.close();
        }
        const mtime = new Date(mtimeBase - object.ageDays * 86_400_000);
        await utimes(file, mtime, mtime);
        created++;
      })(),
    );
    if (pending.length >= 256) {
      await flush();
      if (total % 100_000 === 0) progress(`object ${total}개 확인 (새로 만든 ${created}개)`);
    }
  }
  await flush();
  return { created, total };
}

/** 하네스가 만든 object(`blobs/`·`upload-staging/`)를 모두 지운다. bucket 디렉터리 밖은 건드리지 않는다. */
export function removeAllObjects(bucketDir: string): void {
  for (const prefix of ['blobs', 'upload-staging']) {
    const dir = path.join(bucketDir, prefix);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
