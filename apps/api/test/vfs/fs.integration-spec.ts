import { treeSnapshotContract } from './vfs-snapshot-tree.test-support.js';
import { createFsHttpFixture } from './fs-http-fixture.test-support.js';
import { registerFsPrerequisiteContract } from './fs-prerequisite.test-support.js';
import { registerFsFileSnapshotContract } from './fs-file-snapshot.test-support.js';
import { registerFsMutationReceiptContract } from './fs-mutation-receipt.test-support.js';
import { registerFsConditionalContentContract } from './fs-conditional-content.test-support.js';
import { registerFsErrorReceiptContract } from './fs-error-receipt.test-support.js';
import { registerFsRevisionReadContract } from './fs-revision-read.test-support.js';
import { registerFsBasicOperationsContract } from './fs-basic-operations.test-support.js';
import { registerFsContentHttpContract } from './fs-content-http.test-support.js';
import { registerFsMoveCopyDeleteContract } from './fs-move-copy-delete.test-support.js';
import { registerVfsTrashHttpContract } from './vfs-trash.http.shared-tests.js';

describe('Fs HTTP contract', () => {
  const ctx = createFsHttpFixture();
  treeSnapshotContract(() => ctx.app);
  registerFsPrerequisiteContract(ctx);
  registerFsFileSnapshotContract(ctx);
  registerFsMutationReceiptContract(ctx);
  registerFsConditionalContentContract(ctx);
  registerFsErrorReceiptContract(ctx);
  registerFsRevisionReadContract(ctx);
  registerFsBasicOperationsContract(ctx);
  registerFsContentHttpContract(ctx);
  registerFsMoveCopyDeleteContract(ctx);
  registerVfsTrashHttpContract(() => ctx.app, ctx.createNamespace);
});
