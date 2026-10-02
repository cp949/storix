import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 저장소 루트. 이 파일은 `apps/scale/src/`에 있다. */
export const REPO_ROOT = path.resolve(HERE, '../../..');

/**
 * 측정 대상 API 디렉터리(`dist/`가 빌드돼 있어야 한다). 기본은 이 저장소의 `apps/api`다.
 * 개선 전 기준선처럼 이전 커밋을 별도 위치에 빌드해 같은 하네스로 재려면 `STORIX_SCALE_API_DIR`로 바꾼다.
 */
export const API_DIR = process.env.STORIX_SCALE_API_DIR ?? path.join(REPO_ROOT, 'apps/api');

/** 빌드된 API 서버 진입점 */
export const API_MAIN = path.join(API_DIR, 'dist/main.js');

/** 빌드된 GC 진입점 */
export const GC_MAIN = path.join(API_DIR, 'dist/gc-main.js');

/** 결과·서버 로그 작업 디렉터리(git 제외) */
export const WORK_DIR = process.env.STORIX_SCALE_WORK_DIR ?? path.resolve(HERE, '../.work');

/** 측정 결과 JSON 위치 */
export const RESULTS_DIR = path.join(WORK_DIR, 'results');

/** `seed-objects`가 어떤 template용 object를 만들었는지 적는 파일 */
export const OBJECTS_MARKER = path.join(WORK_DIR, 'storage-objects.json');
