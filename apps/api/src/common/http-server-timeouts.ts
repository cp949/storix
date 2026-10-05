import type { Server } from 'node:http';
import { parseMaxUploadSeconds } from './upload-duration.js';

/**
 * HTTP 서버의 요청 수신 상한(`requestTimeout`)을 업로드 최대 지속 시간(`STORIX_MUTATION_MAX_UPLOAD_SECONDS`)에 맞춘다.
 *
 * Node 기본값(300초)은 본문 수신에도 적용되므로, 그대로 두면 느린 대용량 업로드가 문서의 최대 지속 시간보다
 * 먼저 408로 끊긴다. 헤더 수신 상한(`headersTimeout`)은 바꾸지 않는다.
 * 이 값은 모든 라우트에 적용된다. 본문 수신이 느린 연결을 더 짧게 끊으려면 앞단 프록시에서 제한한다.
 *
 * 값이 잘못되면 서버 설정을 바꾸지 않고 거부한다.
 */
export function applyUploadRequestTimeout(
  server: Pick<Server, 'requestTimeout'>,
  maxUploadSeconds: string | undefined,
): void {
  server.requestTimeout = parseMaxUploadSeconds(maxUploadSeconds) * 1000;
}
