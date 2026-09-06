import { Body, Controller, Get, Headers, Param, Post, Res, UseFilters, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { parseCreateNamespaceRequest } from './dto/create-namespace.dto.js';
import { IdempotencyKeyRequiredError } from './namespace.errors.js';
import { NamespaceService } from './namespace.service.js';

@Controller('api/v1/namespaces')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceController {
  constructor(private readonly namespaceService: NamespaceService) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new IdempotencyKeyRequiredError();
    }

    const { name, encryptionPolicy } = parseCreateNamespaceRequest(body);
    const result = await this.namespaceService.create(idempotencyKey, name, encryptionPolicy);

    res.status(result.status);
    return result.body;
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.namespaceService.findById(id);
  }

  @Get()
  findAll() {
    return this.namespaceService.findAll();
  }
}
