import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import { buildContentDisposition } from './content-disposition.js';
import type { ContentPayload } from './content.service.js';

// 인증 경로(FsController)와 공개 경로(PublicFsController)가 동일한 응답 헤더와
// 스트림 정리 규칙을 쓰도록 한 곳에 모은다.
export async function sendContent(res: Response, payload: ContentPayload, download: boolean): Promise<void> {
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
