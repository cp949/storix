import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 저장소 루트. 이 파일은 `apps/scale/src/`에 있다. */
export const REPO_ROOT = path.resolve(HERE, '../../..');

/** 빌드된 API 서버 진입점 */
export const API_MAIN = path.join(REPO_ROOT, 'apps/api/dist/main.js');

/** 빌드된 GC 진입점 */
export const GC_MAIN = path.join(REPO_ROOT, 'apps/api/dist/gc-main.js');

/** 결과·서버 로그 작업 디렉터리(git 제외) */
export const WORK_DIR = process.env.STORIX_SCALE_WORK_DIR ?? path.resolve(HERE, '../.work');

/** 측정 결과 JSON 위치 */
export const RESULTS_DIR = path.join(WORK_DIR, 'results');
