/** 실제 SQLite에서 삭제 중 namespace의 HTTP 데이터 차단을 검증한다. */
import { namespaceDeletionAccessSuite } from './namespace-deletion.http.test-support.js';
namespaceDeletionAccessSuite(true);
