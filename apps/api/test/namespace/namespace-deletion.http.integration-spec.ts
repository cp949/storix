/**
 * 실제 PostgreSQL에서 삭제 중 namespace의 HTTP 데이터 차단을 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "접근과 이름 재사용". 결정은 api ADR-0032.
 */
import { namespaceDeletionAccessSuite } from './namespace-deletion.http.test-support.js';
namespaceDeletionAccessSuite(false);
