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
import { IdempotencyKeyRequiredError, NamespaceInvalidSettingsRequestError } from './namespace.errors.js';
import { parseUpdateNamespaceSettingsRequest } from './dto/update-namespace-settings.dto.js';
import { NamespaceSettingsService } from './namespace-settings.service.js';

@Public()
@Audited()
@Controller('api/v2/admin/namespaces')
@UseGuards(AdminApiKeyGuard)
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceSettingsController {
  constructor(private readonly settings: NamespaceSettingsService) {}

  @Patch(':namespaceId/settings')
  update(
    @Param('namespaceId') namespaceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw new IdempotencyKeyRequiredError();
    // Node의 latin1 헤더 값은 문자 수가 전송 byte 수와 같다.
    if (idempotencyKey.length > 255) throw new NamespaceInvalidSettingsRequestError();
    const settings = parseUpdateNamespaceSettingsRequest(body);
    return this.settings.update(namespaceId, idempotencyKey, settings).then((result) => {
      response.status(result.status);
      return result.body;
    });
  }
}
