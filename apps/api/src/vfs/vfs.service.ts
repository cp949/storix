import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePositiveInt } from '../common/env-parsing.js';
import { decodeCursor, encodeCursor, KeysetCursor } from '../common/keyset-cursor.js';
import {
  FindFilter,
  NameFilterMode,
  VfsNodeRecord,
  VfsNodeRepository,
} from '../persistence/vfs-node.repository.js';
import { VfsNodeType } from '../persistence/entities/vfs-node.entity.js';
import { toNodeResponse, VfsNodeResponseDto } from './dto/node-response.dto.js';
import { joinChildPath, PathResolver } from './path-resolver.js';
import { requireRoot, requireRootWithLimits } from './require-root.js';
import { resolveEffectiveLimit } from '../common/resource-limit.js';
import {
  VfsAlreadyExistsError,
  VfsInvalidCursorError,
  VfsInvalidOperationError,
  VfsNodeNotFoundError,
  VfsNotDirectoryError,
} from './vfs.errors.js';
import { resolveLimit } from './pagination.js';

const NAME_FILTER_MODES: readonly NameFilterMode[] = ['exact', 'contains', 'prefix', 'suffix'];

export interface FindOptions {
  readonly name?: string;
  readonly match?: string;
  readonly type?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

export interface PageResult {
  readonly items: VfsNodeResponseDto[];
  readonly nextCursor: string | null;
}

function isNameFilterMode(value: string | undefined): value is NameFilterMode {
  return NAME_FILTER_MODES.includes(value as NameFilterMode);
}

@Injectable()
export class VfsService {
  private readonly maxSyncDeleteNodes: number;
  private readonly maxSyncCopyNodes: number;

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly repo: VfsNodeRepository,
    config: ConfigService,
  ) {
    this.maxSyncDeleteNodes = parsePositiveInt(config.getOrThrow<string>('MAX_SYNC_DELETE_NODES'), 1000);
    this.maxSyncCopyNodes = parsePositiveInt(config.getOrThrow<string>('MAX_SYNC_COPY_NODES'), 1000);
  }

  async mkdir(
    namespaceId: string,
    rawPath: string,
    parents: boolean,
  ): Promise<{ status: number; body: VfsNodeResponseDto }> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);

    if (segments.length === 0) {
      throw new VfsAlreadyExistsError(canonical);
    }

    const { node, created } = await this.repo.ensureDirectory(namespaceId, root.id, segments, parents);
    return { status: created ? 201 : 200, body: toNodeResponse(node, canonical) };
  }

  async move(
    namespaceId: string,
    rawSource: string,
    rawDestination: string,
    destinationParents: boolean,
  ): Promise<{ status: number; body: VfsNodeResponseDto }> {
    const root = await requireRoot(this.repo, namespaceId);
    const source = this.pathResolver.resolve(rawSource);
    const destination = this.pathResolver.resolve(rawDestination);

    if (source.segments.length === 0) {
      throw new VfsInvalidOperationError(source.canonical);
    }

    const result = await this.repo.moveNode(
      namespaceId,
      root.id,
      source.segments,
      destination.segments,
      destinationParents,
    );

    return { status: 200, body: toNodeResponse(result.node, result.finalPath) };
  }

  async copy(
    namespaceId: string,
    rawSource: string,
    rawDestination: string,
    destinationParents: boolean,
  ): Promise<{ status: number; body: VfsNodeResponseDto }> {
    const { root, limits } = await requireRootWithLimits(this.repo, namespaceId);
    const source = this.pathResolver.resolve(rawSource);
    const destination = this.pathResolver.resolve(rawDestination);

    if (source.segments.length === 0) {
      throw new VfsInvalidOperationError(source.canonical);
    }

    const maxSyncCopyNodes = resolveEffectiveLimit(limits.maxSyncCopyNodes, this.maxSyncCopyNodes);
    const result = await this.repo.copyNode(
      namespaceId,
      root.id,
      source.segments,
      destination.segments,
      destinationParents,
      maxSyncCopyNodes,
    );

    return { status: 201, body: toNodeResponse(result.node, result.finalPath) };
  }

  async rmdir(namespaceId: string, rawPath: string): Promise<void> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);

    if (segments.length === 0) {
      throw new VfsInvalidOperationError(canonical);
    }

    await this.repo.removeEmptyDirectory(namespaceId, root.id, segments);
  }

  async rm(namespaceId: string, rawPath: string, recursive: boolean): Promise<void> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);

    if (segments.length === 0) {
      throw new VfsInvalidOperationError(canonical);
    }

    await this.repo.removeNode(namespaceId, root.id, segments, recursive, this.maxSyncDeleteNodes);
  }

  async ls(
    namespaceId: string,
    rawPath: string,
    cursorParam: string | undefined,
    limitParam: string | undefined,
  ): Promise<PageResult> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const target = await this.resolveTarget(namespaceId, root, segments);

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }
    if (target.type !== 'DIRECTORY') {
      throw new VfsNotDirectoryError(canonical);
    }

    const cursor = this.decodeCursorParam(cursorParam);
    const limit = resolveLimit(limitParam);
    const rows = await this.repo.listChildren(namespaceId, target.id, cursor, limit);

    return this.paginate(rows, limit, (row) => joinChildPath(canonical, row.name));
  }

  async stat(namespaceId: string, rawPath: string): Promise<VfsNodeResponseDto> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const target = await this.resolveTarget(namespaceId, root, segments);

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }

    return toNodeResponse(target, canonical);
  }

  async exists(namespaceId: string, rawPath: string): Promise<{ exists: boolean }> {
    const root = await requireRoot(this.repo, namespaceId);
    const { segments } = this.pathResolver.resolve(rawPath);
    const target = await this.resolveTarget(namespaceId, root, segments);

    return { exists: target !== null };
  }

  async find(namespaceId: string, rawPath: string, options: FindOptions): Promise<PageResult> {
    const root = await requireRoot(this.repo, namespaceId);
    const { canonical, segments } = this.pathResolver.resolve(rawPath);
    const target = await this.resolveTarget(namespaceId, root, segments);

    if (!target) {
      throw new VfsNodeNotFoundError(canonical);
    }
    if (target.type !== 'DIRECTORY') {
      throw new VfsNotDirectoryError(canonical);
    }

    const cursor = this.decodeCursorParam(options.cursor);
    const limit = resolveLimit(options.limit);
    const filter: FindFilter = {
      ...(options.name
        ? { name: { mode: isNameFilterMode(options.match) ? options.match : 'exact', value: options.name } }
        : {}),
      ...(options.type === 'FILE' || options.type === 'DIRECTORY'
        ? { type: options.type as VfsNodeType }
        : {}),
    };

    const rows = await this.repo.findRecursive(namespaceId, target.id, filter, cursor, limit);

    return this.paginate(rows, limit, (row) => joinChildPath(canonical, row.relativeSegments.join('/')));
  }

  private async resolveTarget(
    namespaceId: string,
    root: VfsNodeRecord,
    segments: string[],
  ): Promise<VfsNodeRecord | null> {
    return segments.length === 0 ? root : this.repo.resolvePath(namespaceId, root.id, segments);
  }

  private decodeCursorParam(raw: string | undefined): KeysetCursor | null {
    if (!raw) {
      return null;
    }

    const decoded = decodeCursor(raw);
    if (!decoded) {
      throw new VfsInvalidCursorError(raw);
    }

    return decoded;
  }

  private paginate<T extends VfsNodeRecord>(
    rows: T[],
    limit: number,
    pathFor: (row: T) => string,
  ): PageResult {
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ name: last.name, id: last.id }) : null;

    return { items: page.map((row) => toNodeResponse(row, pathFor(row))), nextCursor };
  }
}
