import { Controller, Get, Headers, Param, Query, Res, UseFilters, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { sendContent } from './content-response.js';
import { ContentService } from './content.service.js';

// PUBLIC namespace 전용 무인증 다운로드 표면. 라우트를 다운로드 2개로 한정해
// 목록 조회(ls/find)와 쓰기 작업이 공개 표면에 존재하지 않게 한다. 노출 범위가
// 이 파일 하나에 전부 드러나므로 nginx에서도 이 prefix만 공개 listener에 둔다.
@Public()
@Controller('api/v1/public/:namespaceId/fs')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class PublicFsController {
  constructor(private readonly contentService: ContentService) {}

  @Get('content')
  async getContent(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const payload = await this.contentService.getPublicContent(namespaceId, path ?? '', range);
    await sendContent(res, payload, false);
  }

  @Get('download')
  async download(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const payload = await this.contentService.getPublicContent(namespaceId, path ?? '', range);
    await sendContent(res, payload, true);
  }
}
