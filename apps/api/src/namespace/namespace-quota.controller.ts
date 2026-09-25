import {
  Body,
  Controller,
  Headers,
  Param,
  Patch,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { Public } from '../auth/public.decorator.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { IdempotencyKeyRequiredError } from './namespace.errors.js';
import { NamespaceQuotaService } from './namespace-quota.service.js';
import { parseUpdateNamespaceQuotaRequest } from './dto/update-namespace-quota.dto.js';

@Public()
@Controller('api/v1/admin/namespaces')
@UseGuards(AdminApiKeyGuard)
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceQuotaController {
  constructor(private readonly quotas: NamespaceQuotaService) {}

  @Patch(':namespaceId/quota')
  update(
    @Param('namespaceId') namespaceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw new IdempotencyKeyRequiredError();
    const request = parseUpdateNamespaceQuotaRequest(body);
    return this.quotas.update(namespaceId, idempotencyKey, request.maxTotalLogicalBytes).then((result) => {
      response.status(result.status);
      return result.body;
    });
  }
}
