import type { ChangeFeedEvent } from '../../persistence/vfs-change-feed-journal.js';

export interface ChangeFeedEventDto {
  readonly sequence: string;
  readonly operationId: string;
  readonly operationIndex: number;
  readonly operationCount: number;
  readonly kind: ChangeFeedEvent['kind'];
  readonly nodeId: string;
  readonly nodeType: ChangeFeedEvent['nodeType'];
  readonly path: string;
  readonly previousPath?: string;
  readonly revision?: string;
  readonly occurredAt: string;
}

export interface ChangeFeedPageDto {
  readonly changes: readonly ChangeFeedEventDto[];
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

export function toChangeFeedEventDto(event: ChangeFeedEvent): ChangeFeedEventDto {
  return {
    sequence: event.sequence,
    operationId: event.operationId,
    operationIndex: event.operationIndex,
    operationCount: event.operationCount,
    kind: event.kind,
    nodeId: event.nodeId,
    nodeType: event.nodeType,
    path: event.path,
    ...(event.previousPath === null ? {} : { previousPath: event.previousPath }),
    ...(event.revision === null ? {} : { revision: event.revision }),
    occurredAt: event.occurredAt.toISOString(),
  };
}
