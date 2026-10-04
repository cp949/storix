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
import { Audited } from '../audit/audited.decorator.js';
import { AdminApiKeyGuard } from '../auth/admin-api-key.guard.js';
import { Public } from '../auth/public.decorator.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { requireIdempotencyKey } from './idempotency-key.js';
import { NamespaceTrashPolicyService } from './namespace-trash-policy.service.js';
import { parseUpdateNamespaceTrashPolicyRequest } from './dto/update-namespace-trash-policy.dto.js';

@Public()
@Audited()
@Controller('api/v2/admin/namespaces')
@UseGuards(AdminApiKeyGuard)
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceTrashPolicyController {
  constructor(private readonly policies: NamespaceTrashPolicyService) {}

  @Patch(':namespaceId/trash')
  update(
    @Param('namespaceId') namespaceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const request = parseUpdateNamespaceTrashPolicyRequest(body);
    return this.policies.update(namespaceId, key, request.enabled).then((result) => {
      response.status(result.status);
      return result.body;
    });
  }
}
