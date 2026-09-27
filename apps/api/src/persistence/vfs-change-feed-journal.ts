import { randomUUID } from 'node:crypto';
import { EntityManager, In } from 'typeorm';
import { encodeRevision } from '../vfs/revision.js';
import { VfsChangeEventEntity, type VfsChangeKind } from './entities/vfs-change-event.entity.js';
import { VfsChangeFeedStateEntity } from './entities/vfs-change-feed-state.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { compareSegments, joinSegments } from './vfs-node.repository.helpers.js';

import type { MutationTx } from './vfs-node.repository.types.js';
import { DialectPlaceholders } from './dialect-placeholders.js';

export interface ChangeFeedState {
  readonly namespaceId: string;
  readonly lastSequence: string;
  readonly prunedThrough: string;
  readonly hasCheckpoint: boolean;
  readonly signingSecret: string;
}

// SQLite bigint은 JS number로 읽으면 2^53 이상에서 손실된다. 양 dialect 모두
// SQL에서 TEXT로 변환하고 이후에는 decimal string/BigInt만 사용한다.
export async function readChangeFeedState(
  manager: EntityManager,
  namespaceId: string,
  sqlite: boolean,
): Promise<ChangeFeedState | null> {
  const ph = new DialectPlaceholders(sqlite);
  const rows = await manager.query(
    `SELECT namespace_id, CAST(last_sequence AS TEXT) AS last_sequence,
      CAST(pruned_through AS TEXT) AS pruned_through, has_checkpoint, signing_secret
     FROM vfs_change_feed_state WHERE namespace_id = ${ph.bind(namespaceId)}`,
    ph.params,
  ) as Array<{ namespace_id: string; last_sequence: string; pruned_through: string;
    has_checkpoint: boolean | number; signing_secret: string }>;
  const row = rows[0];
  return row ? {
    namespaceId: row.namespace_id,
    lastSequence: row.last_sequence,
    prunedThrough: row.pruned_through,
    hasCheckpoint: Boolean(row.has_checkpoint),
    signingSecret: row.signing_secret,
  } : null;
}

export interface ChangeFeedEvent {
  readonly namespaceId: string;
  readonly sequence: string;
  readonly operationId: string;
  readonly operationIndex: number;
  readonly operationCount: number;
  readonly kind: VfsChangeKind;
  readonly nodeId: string;
  readonly nodeType: VfsNodeEntity['type'];
  readonly path: string;
  readonly previousPath: string | null;
  readonly revision: string | null;
  readonly occurredAt: Date;
}

// DELTA-03의 cursor page도 이 조회를 사용해야 bigint sequence가 손실되지 않는다.
export async function readChangeFeedEvents(
  manager: EntityManager,
  namespaceId: string,
  afterSequence: string,
  limit: number,
  sqlite: boolean,
): Promise<ChangeFeedEvent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001) throw new Error('Invalid change feed limit');
  const ph = new DialectPlaceholders(sqlite);
  const rows = await manager.query(
    `SELECT namespace_id, CAST(e.sequence AS TEXT) AS sequence, operation_id, operation_index,
      operation_count, kind, node_id, node_type, path, previous_path, revision, occurred_at
     FROM vfs_change_event e WHERE e.namespace_id = ${ph.bind(namespaceId)}
       AND e.sequence > ${ph.bind(afterSequence)} ORDER BY e.sequence ASC LIMIT ${ph.bind(limit)}`,
    ph.params,
  ) as Array<{
    namespace_id: string; sequence: string; operation_id: string; operation_index: number;
    operation_count: number; kind: VfsChangeKind; node_id: string;
    node_type: VfsNodeEntity['type']; path: string; previous_path: string | null;
    revision: string | null; occurred_at: Date | string;
  }>;
  return rows.map((row) => ({
    namespaceId: row.namespace_id,
    sequence: row.sequence,
    operationId: row.operation_id,
    operationIndex: row.operation_index,
    operationCount: row.operation_count,
    kind: row.kind,
    nodeId: row.node_id,
    nodeType: row.node_type,
    path: row.path,
    previousPath: row.previous_path,
    revision: row.revision,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at :
      new Date(row.occurred_at.replace(' ', 'T') + 'Z'),
  }));
}

export interface ChangeFeedNodeState {
  readonly node: VfsNodeEntity;
  readonly segments: string[];
  readonly path: string;
}

// root lock / SQLite query gate를 획득한 caller의 transaction에서만 호출한다.
export async function captureChangeFeedNodes(
  manager: EntityManager,
  namespaceId: string,
  ids: string[],
): Promise<Map<string, ChangeFeedNodeState>> {
  if (ids.length === 0) return new Map();
  const repo = manager.getRepository(VfsNodeEntity);
  const nodes: VfsNodeEntity[] = [];
  for (let offset = 0; offset < ids.length; offset += 250) {
    nodes.push(...await repo.find({ where: { namespaceId, id: In(ids.slice(offset, offset + 250)) } }));
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const states = new Map<string, ChangeFeedNodeState>();
  const resolving = new Set<string>();
  const resolve = async (node: VfsNodeEntity): Promise<ChangeFeedNodeState> => {
    const cached = states.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) throw new Error('VFS node parent cycle');
    resolving.add(node.id);
    const parent = node.parentId === null ? null :
      (byId.get(node.parentId) ?? await repo.findOneBy({ id: node.parentId, namespaceId }));
    if (node.parentId !== null && !parent) throw new Error('VFS parent node missing');
    if (parent) byId.set(parent.id, parent);
    const segments = parent ? [...(await resolve(parent)).segments, node.name] : [];
    const state = { node, segments, path: joinSegments(segments) };
    states.set(node.id, state);
    resolving.delete(node.id);
    return state;
  };
  const result = new Map<string, ChangeFeedNodeState>();
  for (const node of nodes) result.set(node.id, await resolve(node));
  return result;
}

export async function trackChangeFeedBefore(tx: MutationTx, ids: string[]): Promise<void> {
  if (!tx.feedBefore) return;
  // 같은 transaction에서 만든 노드는 최초 상태가 부재다.
  const missing = ids.filter((id) => !tx.feedBefore!.has(id) && !tx.changed.has(id));
  const captured = await captureChangeFeedNodes(tx.manager, tx.namespaceId, missing);
  for (const [id, state] of captured) tx.feedBefore.set(id, state);
}

function sameNode(before: ChangeFeedNodeState, after: ChangeFeedNodeState): boolean {
  const a = before.node;
  const b = after.node;
  return before.path === after.path && a.type === b.type && a.blobId === b.blobId &&
    a.size === b.size && a.mimeType === b.mimeType && a.version === b.version;
}

export async function appendChangeFeedEvents(
  manager: EntityManager,
  namespaceId: string,
  before: Map<string, ChangeFeedNodeState>,
  changedIds: string[],
  sqlite: boolean,
): Promise<void> {
  const after = await captureChangeFeedNodes(manager, namespaceId,
    [...new Set([...before.keys(), ...changedIds])]);
  // 자식의 최종 상태가 원상복구돼도 커밋된 조상 listing revision 변화는
  // updated 이벤트다. FILE과 DIRECTORY 모두 최종 version을 비교한다.
  const meaningful = new Set<string>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldState = before.get(id);
    const newState = after.get(id);
    if (!oldState || !newState || oldState.path !== newState.path ||
        oldState.node.type !== newState.node.type || oldState.node.blobId !== newState.node.blobId ||
        oldState.node.size !== newState.node.size || oldState.node.mimeType !== newState.node.mimeType ||
        oldState.node.version !== newState.node.version) {
      meaningful.add(id);
    }
  }
  const changedAncestors = new Set<string>();
  for (const id of meaningful) {
    for (const snapshot of [before, after]) {
      let parentId = snapshot.get(id)?.node.parentId;
      while (parentId) {
        changedAncestors.add(parentId);
        parentId = snapshot.get(parentId)?.node.parentId ?? null;
      }
    }
  }
  const changes: Array<{
    kind: VfsChangeKind;
    nodeId: string;
    nodeType: VfsNodeEntity['type'];
    path: string;
    previousPath: string | null;
    revision: string | null;
    segments: string[];
  }> = [];

  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldState = before.get(id);
    const newState = after.get(id);
    if (oldState && newState && (sameNode(oldState, newState) ||
      (!meaningful.has(id) && !changedAncestors.has(id)))) continue;
    if (!oldState && !newState) continue;
    const kind: VfsChangeKind = !oldState ? 'created' : !newState ? 'deleted' :
      oldState.path !== newState.path ? 'moved' : 'updated';
    const state = newState ?? oldState!;
    changes.push({
      kind,
      nodeId: id,
      nodeType: state.node.type,
      path: state.path,
      previousPath: kind === 'moved' ? oldState!.path : null,
      revision: newState ? encodeRevision(newState.node) : null,
      segments: state.segments,
    });
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => compareSegments(a.segments, b.segments) ||
    (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

  const states = manager.getRepository(VfsChangeFeedStateEntity);
  const state = await readChangeFeedState(manager, namespaceId, sqlite);
  if (!state?.hasCheckpoint) throw new Error('Change feed checkpoint missing');
  const start = BigInt(state.lastSequence);
  const end = start + BigInt(changes.length);
  if (end > 9223372036854775807n) throw new Error('Change feed sequence exhausted');
  const operationId = randomUUID();
  const events = changes.map((change, operationIndex) => ({
    namespaceId,
    sequence: (start + BigInt(operationIndex) + 1n).toString(),
    operationId,
    operationIndex,
    operationCount: changes.length,
    kind: change.kind,
    nodeId: change.nodeId,
    nodeType: change.nodeType,
    path: change.path,
    previousPath: change.previousPath,
    revision: change.revision,
  }));
  // Bounded insert size keeps SQLite's parameter count below its driver limit.
  for (let offset = 0; offset < events.length; offset += 250) {
    await manager.getRepository(VfsChangeEventEntity).insert(events.slice(offset, offset + 250));
  }
  await states.update({ namespaceId }, { lastSequence: end.toString() });
}
