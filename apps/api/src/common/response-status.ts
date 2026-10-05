import type { Response } from 'express';

// 응답을 끝까지 보내기 전에 연결이 닫힌 요청의 status. nginx의 "client closed request" 관례를 따른다.
export const CLIENT_CLOSED_REQUEST_STATUS = 499;

/**
 * 'close' 시점에 감사 로그·메트릭·구조화 로그에 남길 응답 status를 정한다.
 *
 * 응답 전에 클라이언트가 연결을 끊으면 `statusCode`는 아직 기본값 200이다.
 * 응답을 끝까지 보내지 못했으면(`writableFinished`가 false) 499를 쓴다.
 * 실제 처리 결과는 mutation receipt와 서비스 로그로 확인한다.
 */
export function resolveResponseStatus(response: Pick<Response, 'statusCode' | 'writableFinished'>): number {
  return response.writableFinished ? response.statusCode : CLIENT_CLOSED_REQUEST_STATUS;
}
