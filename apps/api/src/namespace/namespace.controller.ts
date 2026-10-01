import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { CapabilityService } from '../capability/capability.service.js';
import { parseCreateNamespaceRequest } from './dto/create-namespace.dto.js';
import { IdempotencyKeyRequiredError, NamespaceNotFoundError } from './namespace.errors.js';
import { NamespaceService } from './namespace.service.js';

@Controller('api/v2/namespaces')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class NamespaceController {
  constructor(
    private readonly namespaceService: NamespaceService,
    private readonly capabilityService: CapabilityService,
  ) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new IdempotencyKeyRequiredError();
    }

    const { name, encryptionPolicy, accessPolicy, maxTotalLogicalBytes } = parseCreateNamespaceRequest(body);
    const result = await this.namespaceService.create(
      idempotencyKey,
      name,
      encryptionPolicy,
      accessPolicy,
      maxTotalLogicalBytes ?? null,
    );

    res.status(result.status);
    return result.body;
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.namespaceService.findById(id);
  }

  @Get(':id/capabilities')
  async findCapabilities(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const namespace = await this.namespaceService.findById(id);
    if (namespace.status !== 'ACTIVE') throw new NamespaceNotFoundError(id);

    res.setHeader('Cache-Control', 'no-store');
    return { capabilities: this.capabilityService.listEnabled(id) };
  }

  // `limit`·`cursor`를 주면 page 객체(`{ items, nextCursor }`), 둘 다 없으면 이전 계약의 전체 배열이다.
  @Get()
  findAll(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (limit === undefined && cursor === undefined) return this.namespaceService.findAll();
    return this.namespaceService.findPage(limit, cursor);
  }
}
