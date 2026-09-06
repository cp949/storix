import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainErrorFilter } from '../common/domain-error.filter.js';
import { StructuredLoggingInterceptor } from '../common/structured-logging.interceptor.js';
import { buildContentDisposition } from './content-disposition.js';
import { ContentPayload, ContentService } from './content.service.js';
import { parseCopyRequest } from './dto/copy-request.dto.js';
import { parseMkdirRequest } from './dto/mkdir-request.dto.js';
import { parseMoveRequest } from './dto/move-request.dto.js';
import { parseTouchRequest } from './dto/touch-request.dto.js';
import { VfsService } from './vfs.service.js';

@Controller('api/v1/namespaces/:namespaceId/fs')
@UseFilters(DomainErrorFilter)
@UseInterceptors(StructuredLoggingInterceptor)
export class FsController {
  constructor(
    private readonly vfsService: VfsService,
    private readonly contentService: ContentService,
  ) {}

  @Post('mkdir')
  async mkdir(
    @Param('namespaceId') namespaceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { path, parents } = parseMkdirRequest(body);
    const result = await this.vfsService.mkdir(namespaceId, path, parents);

    res.status(result.status);
    return result.body;
  }

  @Post('touch')
  async touch(
    @Param('namespaceId') namespaceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { path, parents } = parseTouchRequest(body);
    const result = await this.contentService.touch(namespaceId, path, parents);

    res.status(result.status);
    return result.body;
  }

  @Post('mv')
  async mv(
    @Param('namespaceId') namespaceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { source, destination, destinationParents } = parseMoveRequest(body);
    const result = await this.vfsService.move(namespaceId, source, destination, destinationParents);

    res.status(result.status);
    return result.body;
  }

  @Post('cp')
  async cp(
    @Param('namespaceId') namespaceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { source, destination, destinationParents } = parseCopyRequest(body);
    const result = await this.vfsService.copy(namespaceId, source, destination, destinationParents);

    res.status(result.status);
    return result.body;
  }

  @Delete('rmdir')
  @HttpCode(204)
  async rmdir(@Param('namespaceId') namespaceId: string, @Query('path') path: string | undefined) {
    await this.vfsService.rmdir(namespaceId, path ?? '');
  }

  @Delete('rm')
  @HttpCode(204)
  async rm(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Query('recursive') recursive: string | undefined,
  ) {
    await this.vfsService.rm(namespaceId, path ?? '', recursive === 'true');
  }

  @Put('content')
  async putContent(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Query('parents') parents: string | undefined,
    @Query('force') force: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.contentService.putContent(namespaceId, path ?? '', req, {
      contentType,
      contentLength,
      ifMatch,
      force: force === 'true',
      parents: parents === 'true',
    });

    res.status(result.status);
    return result.body;
  }

  @Get('content')
  async getContent(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const payload = await this.contentService.getContent(namespaceId, path ?? '', range);
    await this.sendContent(res, payload, false);
  }

  @Get('download')
  async download(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    const payload = await this.contentService.getContent(namespaceId, path ?? '', range);
    await this.sendContent(res, payload, true);
  }

  @Get('ls')
  ls(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.vfsService.ls(namespaceId, path ?? '', cursor, limit);
  }

  @Get('stat')
  stat(@Param('namespaceId') namespaceId: string, @Query('path') path: string | undefined) {
    return this.vfsService.stat(namespaceId, path ?? '');
  }

  @Get('exists')
  exists(@Param('namespaceId') namespaceId: string, @Query('path') path: string | undefined) {
    return this.vfsService.exists(namespaceId, path ?? '');
  }

  @Get('find')
  find(
    @Param('namespaceId') namespaceId: string,
    @Query('path') path: string | undefined,
    @Query('name') name: string | undefined,
    @Query('match') match: string | undefined,
    @Query('type') type: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    return this.vfsService.find(namespaceId, path ?? '', { name, match, type, cursor, limit });
  }

  private async sendContent(res: Response, payload: ContentPayload, download: boolean): Promise<void> {
    res.status(payload.status);
    res.setHeader('Content-Type', payload.mimeType);
    res.setHeader('Content-Length', String(payload.contentLength));
    res.setHeader('Accept-Ranges', 'bytes');
    if (payload.contentRange) {
      res.setHeader('Content-Range', payload.contentRange);
    }
    if (download) {
      res.setHeader('Content-Disposition', buildContentDisposition(payload.name));
    }
    // 단순 pipe()는 source 오류를 destination으로 전파하지 않고(Node .pipe()의 알려진
    // 한계), 클라이언트가 다운로드 도중 연결을 끊어도 source를 정리하지 않는다.
    // pipeline()은 양방향 오류 전파와 리소스 정리를 모두 보장한다. 응답을 이미
    // 보내기 시작한 뒤 발생하는 실패이므로 별도 처리 없이 무시한다(unhandled rejection 방지).
    await pipeline(payload.stream, res).catch(() => undefined);
  }
}
