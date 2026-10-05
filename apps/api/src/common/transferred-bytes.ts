// 요청·응답 전송 바이트를 소켓 기준으로 센다(HTTP 헤더 포함).
// Content-Length는 chunked 업로드·HEAD·중단된 다운로드에서 실제 전송량과 다르다.

interface SocketCounters {
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

// 소켓별로 직전 응답을 끝냈을 때의 누적값. keep-alive로 이어지는 다음 요청은 이 값부터 센다.
const socketMarks = new WeakMap<object, { read: number; written: number }>();
// 응답별 결과. 메트릭·구조화 로그가 같은 'close'에서 각각 물어도 한 번만 계산한다.
const responseBytes = new WeakMap<object, number>();

/**
 * 응답의 'close' 시점에 호출한다. 같은 소켓의 직전 응답 이후 읽고 쓴 바이트의 합을 돌려준다.
 * keep-alive 연결에서 다음 요청을 미리 읽었다면 그 일부가 섞일 수 있다.
 */
export function resolveTransferredBytes(
  request: { readonly socket: SocketCounters | null | undefined },
  response: object,
): number | undefined {
  const cached = responseBytes.get(response);
  if (cached !== undefined) return cached;
  const socket = request.socket;
  if (!socket) return undefined;
  const mark = socketMarks.get(socket) ?? { read: 0, written: 0 };
  const bytes = socket.bytesRead - mark.read + (socket.bytesWritten - mark.written);
  socketMarks.set(socket, { read: socket.bytesRead, written: socket.bytesWritten });
  responseBytes.set(response, bytes);
  return bytes;
}
