import { fetch as undiciFetch } from 'undici';

// Storix HTTP 호출에 쓰는 fetch다.
// Node 24.20.0 내장 fetch(undici 7.29.0)는 스트림 요청 본문의 청크를 요청이 끝날 때까지 보유한다.
// 그래서 업로드 크기에 비례해 메모리가 늘어난다(issue #9).
// undici 8의 fetch는 전송을 마친 청크를 보유하지 않는다.
// 테스트가 대체할 수 있도록 객체 속성으로 노출한다.
export const storixTransport = { fetch: undiciFetch };
