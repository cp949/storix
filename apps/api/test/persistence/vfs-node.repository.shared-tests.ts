import {
  createVfsNodeRepositoryTestHelpers,
  type VfsNodeRepositoryTestContext,
} from './vfs-node.repository.shared-test-context.js';
import { runMutationRevisionsTests } from './vfs-node.repository.shared-tests/mutation-revisions.js';
import { runConditionalMutationsTests } from './vfs-node.repository.shared-tests/conditional-mutations.js';
import { runRepositoryBasicsTests } from './vfs-node.repository.shared-tests/repository-basics.js';
import { runRepositoryReadsTests } from './vfs-node.repository.shared-tests/repository-reads.js';
import { runFileMutationsTests } from './vfs-node.repository.shared-tests/file-mutations.js';
import { runTreeMutationsTests } from './vfs-node.repository.shared-tests/tree-mutations.js';
import { runFileExpiryTests } from './vfs-node.repository.shared-tests/file-expiry.js';

// Postgres/SQLite 공용 테스트 진입점. 드라이버별 실행 파일이 동일한 suite들을 등록한다.
export function runVfsNodeRepositorySharedTests(getContext: () => VfsNodeRepositoryTestContext): void {
  const helpers = createVfsNodeRepositoryTestHelpers(getContext);
  runMutationRevisionsTests(helpers);
  runConditionalMutationsTests(helpers);
  runRepositoryBasicsTests(helpers);
  runRepositoryReadsTests(helpers);
  runFileMutationsTests(helpers);
  runTreeMutationsTests(helpers);
  runFileExpiryTests(helpers);
}
