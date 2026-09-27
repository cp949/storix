import { Controller, Get, Param, Query, UseFilters, UseInterceptors } from '@nestjs/common';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { ChangeFeedService } from './change-feed.service.js';
import { VfsInvalidChangeCursorError, VfsInvalidMutationRequestError } from './vfs.errors.js';

@Controller('api/v2/namespaces/:namespaceId/fs/changes')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class ChangeFeedController {
  constructor(private readonly feed: ChangeFeedService) {}

  @Get()
  list(
    @Param('namespaceId') namespaceId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    if (cursor !== undefined && typeof cursor !== 'string') throw new VfsInvalidChangeCursorError();
    if (limit !== undefined && typeof limit !== 'string') throw new VfsInvalidMutationRequestError();
    return this.feed.list(namespaceId, cursor, limit);
  }
}
