/** 관리자 전용 삭제 접수와 영속 operation 상태 조회를 제공한다. */
import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Audited } from '../audit/audited.decorator.js';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { Public } from '../auth/public.decorator.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { IdempotencyKeyRequiredError, NamespaceInvalidDeleteRequestError } from './namespace.errors.js';
import { NamespaceDeletionService } from './namespace-deletion.service.js';

@Public()
@Audited()
@Controller('api/v2/admin/namespaces')
@UseGuards(AdminApiKeyGuard)
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceDeletionController {
  constructor(private readonly deletions: NamespaceDeletionService) {}

  @Post(':namespaceId/delete')
  async accept(
    @Param('namespaceId') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key) throw new IdempotencyKeyRequiredError();
    // Node는 헤더 값을 latin1로 읽어 문자 하나가 전송된 byte 하나이므로 문자 수가 곧 byte 수다.
    if (key.length > 255) throw new NamespaceInvalidDeleteRequestError();
    const length = req.headers['content-length'];
    if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined)
      throw new NamespaceInvalidDeleteRequestError();
    const result = await this.deletions.accept(id, key);
    res.status(result.status);
    res.setHeader('Location', `/api/v2/admin/namespaces/${result.body.namespaceId}/deletion`);
    res.setHeader('Cache-Control', 'no-store');
    return result.body;
  }

  @Get(':namespaceId/deletion')
  async getStatus(@Param('namespaceId') id: string, @Res({ passthrough: true }) res: Response) {
    const result = await this.deletions.getStatus(id);
    res.setHeader('Cache-Control', 'no-store');
    return result;
  }
}
