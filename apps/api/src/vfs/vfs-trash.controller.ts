import { Controller, Get, Headers, Param, Post, Query, Req, Res, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Audited } from '../audit/audited.decorator.js';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { Public } from '../auth/public.decorator.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { VfsInvalidMutationRequestError } from './vfs.errors.js';
import { VfsTrashService } from './vfs-trash.service.js';

@Controller('api/v2/namespaces/:namespaceId/fs/trash')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class VfsTrashController {
  constructor(private readonly trash: VfsTrashService) {}

  @Get()
  list(
    @Param('namespaceId') namespaceId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    if ((cursor !== undefined && typeof cursor !== 'string') ||
      (limit !== undefined && typeof limit !== 'string')) throw new VfsInvalidMutationRequestError();
    return this.trash.list(namespaceId, cursor, limit);
  }

  @Post(':trashId/restore')
  async restore(
    @Param('namespaceId') namespaceId: string,
    @Param('trashId') trashId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.trash.restore(namespaceId, trashId, scope, key, req.body as Buffer | undefined, req.requestId);
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }

  @Public()
  @Audited()
  @UseGuards(AdminApiKeyGuard)
  @Post(':trashId/purge')
  async purge(
    @Param('namespaceId') namespaceId: string,
    @Param('trashId') trashId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.trash.purge(namespaceId, trashId, scope, key, req.body as Buffer | undefined, req.requestId);
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }
}
