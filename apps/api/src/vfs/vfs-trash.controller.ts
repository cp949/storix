import { Controller, Get, Param, Query, UseFilters, UseInterceptors } from '@nestjs/common';
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
}
