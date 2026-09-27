import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { UploadSessionService } from './upload-session.service.js';
import { UploadSessionPartService } from './upload-session-part.service.js';
import { UploadSessionFinalizeService } from './upload-session-finalize.service.js';
import { VfsInvalidMutationRequestError } from './vfs.errors.js';

@Controller('api/v2/namespaces/:namespaceId/fs/upload-sessions')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class UploadSessionController {
  constructor(
    private readonly sessions: UploadSessionService,
    private readonly parts: UploadSessionPartService,
    private readonly finalize: UploadSessionFinalizeService,
  ) {}

  @Post(':sessionId/complete')
  async complete(
    @Param('namespaceId') namespaceId: string,
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.finalize.complete(namespaceId, sessionId, req.requestId);
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }

  @Put(':sessionId/parts/:index')
  putPart(
    @Param('namespaceId') namespaceId: string,
    @Param('sessionId') sessionId: string,
    @Param('index') index: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
  ) {
    if (contentType?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream')
      throw new VfsInvalidMutationRequestError();
    return this.parts.putPart(namespaceId, sessionId, index, req, contentLength, req.requestId);
  }

  @Post()
  async create(
    @Param('namespaceId') namespaceId: string,
    @Headers('x-mutation-scope') scope: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sessions.create(namespaceId, scope, key, body, req.requestId);
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return result.body;
  }

  @Get(':sessionId')
  status(@Param('namespaceId') namespaceId: string, @Param('sessionId') sessionId: string) {
    return this.sessions.status(namespaceId, sessionId);
  }

  @Delete(':sessionId')
  cancel(@Param('namespaceId') namespaceId: string, @Param('sessionId') sessionId: string) {
    return this.sessions.cancel(namespaceId, sessionId);
  }
}
