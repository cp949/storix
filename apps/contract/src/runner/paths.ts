import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 저장소 루트. 이 파일은 `apps/contract/src/runner/`에 있다. */
export const REPO_ROOT = path.resolve(RUNNER_DIR, '../../../..');

/** 빌드된 API 서버 진입점 */
export const API_MAIN = path.join(REPO_ROOT, 'apps/api/dist/main.js');

/** 계약이 참조하는 요구사항 문서 */
export const REQUIREMENTS_PATH = path.join(REPO_ROOT, 'docs/requirements/file-storage.md');

/** 계약 파일 기본 위치 */
export const CONTRACTS_DIR = path.resolve(RUNNER_DIR, '../contracts');
