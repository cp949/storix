import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { sendContent } from './content-response.js';
import { VfsSnapshotService } from './vfs-snapshot.service.js';
import { VfsInvalidMutationRequestError } from './vfs.errors.js';

@Controller('api/v1/namespaces/:namespaceId/fs/snapshots')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class VfsSnapshotController {
  constructor(private readonly snapshots: VfsSnapshotService) {}

  @Post()
  async create(
    @Param('namespaceId') namespaceId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.snapshots.create(
      namespaceId,
      scope,
      key,
      req.body as Buffer | undefined,
      req.requestId,
    );
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }

  @Get(':snapshotId')
  get(@Param('namespaceId') namespaceId: string, @Param('snapshotId') snapshotId: string) {
    return this.snapshots.get(namespaceId, snapshotId);
  }

  @Get(':snapshotId/entries')
  entries(
    @Param('namespaceId') namespaceId: string,
    @Param('snapshotId') snapshotId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    if (
      (cursor !== undefined && typeof cursor !== 'string') ||
      (limit !== undefined && typeof limit !== 'string')
    )
      throw new VfsInvalidMutationRequestError();
    return this.snapshots.listEntries(namespaceId, snapshotId, cursor, limit);
  }

  @Get(':snapshotId/content')
  async content(
    @Param('namespaceId') namespaceId: string,
    @Param('snapshotId') snapshotId: string,
    @Query('path') path: unknown,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    if (path !== undefined && typeof path !== 'string') throw new VfsInvalidMutationRequestError();
    await sendContent(res, await this.snapshots.getContent(namespaceId, snapshotId, path, range), false);
  }

  @Post(':snapshotId/restore')
  async restore(
    @Param('namespaceId') namespaceId: string,
    @Param('snapshotId') snapshotId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.snapshots.restore(
      namespaceId,
      snapshotId,
      scope,
      key,
      req.body as Buffer | undefined,
      req.requestId,
    );
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }

  @Post(':snapshotId/delete')
  async delete(
    @Param('namespaceId') namespaceId: string,
    @Param('snapshotId') snapshotId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.snapshots.delete(
      namespaceId,
      snapshotId,
      scope,
      key,
      req.body as Buffer | undefined,
      req.requestId,
    );
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }
}
