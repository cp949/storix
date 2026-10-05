import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { toWebStream } from '../common/request-body-stream.js';
import type { DemoUser } from './demo-user.js';
import type {
  FileEntry,
  UploadSessionCompleteResult,
  UploadSessionCreateRequest,
  UploadSessionStatus,
} from '../storix-client/storix-client.types.js';
import { StorixClient } from '../storix-client/storix-client.service.js';
import { StorixApiError } from '../storix-client/storix-client.errors.js';
import { parseDemoUser } from './demo-user.js';
import { firstQueryValue } from './http-query.js';
import { resolveExternalPath, resolveInternalPath } from './path-guard.js';
import { requireStringFields } from './request-body.js';
import { UploadSessionInvalidRequestError, UploadSessionNotFoundError } from './document-archive.errors.js';

function toExternalEntry(user: DemoUser, entry: FileEntry): FileEntry {
  return { ...entry, path: resolveExternalPath(user, entry.path) };
}

function parseUploadSessionCreateRequest(body: unknown): UploadSessionCreateRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UploadSessionInvalidRequestError();
  }
  const request = body as Record<string, unknown>;
  const hasIfAbsent = Object.hasOwn(request, 'ifAbsent');
  const hasIfRevision = Object.hasOwn(request, 'ifRevision');
  if (
    typeof request.path !== 'string' ||
    typeof request.sizeBytes !== 'string' ||
    typeof request.mimeType !== 'string' ||
    (request.sha256 !== undefined && typeof request.sha256 !== 'string') ||
    hasIfAbsent === hasIfRevision ||
    (hasIfAbsent && request.ifAbsent !== true) ||
    (hasIfRevision && typeof request.ifRevision !== 'string')
  ) {
    throw new UploadSessionInvalidRequestError();
  }
  return request as UploadSessionCreateRequest;
}

@Controller('demo-api/documents')
export class DocumentsController {
  constructor(private readonly storixClient: StorixClient) {}

  @Get()
  async list(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Query('cursor') cursor: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    const page = await this.storixClient.list(internalPath, firstQueryValue(cursor));
    return { items: page.items.map((entry) => toExternalEntry(user, entry)), nextCursor: page.nextCursor };
  }

  @Patch('mime-type')
  async setMimeType(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<FileEntry> {
    const user = parseDemoUser(demoUserHeader);
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).path !== 'string' ||
      typeof (body as Record<string, unknown>).mimeType !== 'string'
    ) {
      throw new BadRequestException('path와 mimeType이 필요함');
    }
    const request = body as { path: string; mimeType: string };
    const internalPath = resolveInternalPath(user, request.path);
    const entry = await this.storixClient.setMimeType(internalPath, request.mimeType);
    return toExternalEntry(user, entry);
  }

  @Get('search')
  async search(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Query('name') name: string | string[] | undefined,
    @Query('cursor') cursor: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    const page = await this.storixClient.find(
      internalPath,
      firstQueryValue(name) ?? '',
      firstQueryValue(cursor),
    );
    return { items: page.items.map((entry) => toExternalEntry(user, entry)), nextCursor: page.nextCursor };
  }

  @Put('content')
  async putContent(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');

    const entry = await this.storixClient.upload(internalPath, toWebStream(req), {
      mimeType: contentType,
      contentLength: contentLength !== undefined ? Number(contentLength) : undefined,
    });

    res.status(201);
    return toExternalEntry(user, entry);
  }

  @Post('upload-sessions')
  async createUploadSession(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const request = parseUploadSessionCreateRequest(body);
    const path = resolveInternalPath(user, request.path);
    return this.storixClient.createUploadSession(
      { ...request, path },
      idempotencyKey,
      `demo1-was:upload:${user}`,
    );
  }

  @Get('upload-sessions/:sessionId')
  async getUploadSession(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Param('sessionId') sessionId: string,
  ): Promise<UploadSessionStatus> {
    const user = parseDemoUser(demoUserHeader);
    return this.toExternalSession(user, await this.ownSession(user, sessionId));
  }

  @Put('upload-sessions/:sessionId/parts/:index')
  async putUploadSessionPart(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Param('sessionId') sessionId: string,
    @Param('index') index: string,
    @Headers('content-length') contentLength: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() req: Request,
  ) {
    const user = parseDemoUser(demoUserHeader);
    await this.ownSession(user, sessionId);
    return this.storixClient.putUploadSessionPart(
      sessionId,
      index,
      toWebStream(req),
      contentLength,
      contentType,
    );
  }

  @Post('upload-sessions/:sessionId/complete')
  async completeUploadSession(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Param('sessionId') sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadSessionCompleteResult> {
    const user = parseDemoUser(demoUserHeader);
    await this.ownSession(user, sessionId);
    const completion = await this.storixClient.completeUploadSession(sessionId);
    res.status(completion.status);
    return this.toExternalCompleteResult(user, completion.body);
  }

  @Delete('upload-sessions/:sessionId')
  async cancelUploadSession(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Param('sessionId') sessionId: string,
  ): Promise<UploadSessionStatus> {
    const user = parseDemoUser(demoUserHeader);
    await this.ownSession(user, sessionId);
    return this.toExternalSession(user, await this.storixClient.cancelUploadSession(sessionId));
  }

  private async ownSession(user: DemoUser, sessionId: string): Promise<UploadSessionStatus> {
    let session: UploadSessionStatus;
    try {
      session = await this.storixClient.getUploadSession(sessionId);
    } catch (error) {
      if (
        error instanceof StorixApiError &&
        error.status === 404 &&
        error.code === 'VFS_UPLOAD_SESSION_NOT_FOUND'
      ) {
        throw new UploadSessionNotFoundError();
      }
      throw error;
    }
    this.externalSessionPath(user, session.path);
    return session;
  }

  private externalSessionPath(user: DemoUser, internalPath: string): string {
    try {
      const externalPath = resolveExternalPath(user, internalPath);
      if (resolveInternalPath(user, externalPath) === internalPath) {
        return externalPath;
      }
    } catch {
      // 다른 사용자 또는 비정규 경로는 세션 존재 여부를 숨긴다.
    }
    throw new UploadSessionNotFoundError();
  }

  private toExternalSession(user: DemoUser, session: UploadSessionStatus): UploadSessionStatus {
    return {
      ...session,
      path: this.externalSessionPath(user, session.path),
      ...(session.result ? { result: this.toExternalCompleteResult(user, session.result) } : {}),
    };
  }

  private toExternalCompleteResult(
    user: DemoUser,
    result: UploadSessionCompleteResult,
  ): UploadSessionCompleteResult {
    const userRoot = resolveInternalPath(user, '/');
    return {
      ...result,
      resource: { ...result.resource, path: this.externalSessionPath(user, result.resource.path) },
      affectedRevisions: result.affectedRevisions
        .filter((entry) => entry.path === userRoot || entry.path.startsWith(`${userRoot}/`))
        .map((entry) => ({ ...entry, path: this.externalSessionPath(user, entry.path) })),
    };
  }

  @Post('download')
  async createDownload(@Headers('x-demo-user') demoUserHeader: string | undefined, @Body() body: unknown) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, requireStringFields(body, ['path']).path);
    return this.storixClient.createDownload(internalPath);
  }

  @Post('publish')
  async publish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
  ) {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    return this.storixClient.publish(internalPath);
  }

  @Delete('publish')
  @HttpCode(204)
  async unpublish(
    @Headers('x-demo-user') demoUserHeader: string | undefined,
    @Query('path') path: string | string[] | undefined,
  ): Promise<void> {
    const user = parseDemoUser(demoUserHeader);
    const internalPath = resolveInternalPath(user, firstQueryValue(path) ?? '');
    await this.storixClient.unpublish(internalPath);
  }
}
