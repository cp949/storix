import type { Readable } from 'node:stream';

/**
 * 요청 본문(Node Readable)을 fetch 본문으로 쓸 웹 ReadableStream으로 바꾼다.
 *
 * `Readable.toWeb`을 쓰지 않는 이유:
 * - 그 어댑터는 `data` 리스너를 계속 유지한다.
 * - 원본이 오류·조기 종료로 끝나 컨트롤러가 닫힌 뒤에도 버퍼에 남은 청크가 흘러나오면 `enqueue`가
 *   "Controller is already closed"를 던진다.
 * - 이 예외는 스트림 밖의 이벤트 핸들러에서 발생해 프로세스 전체가 종료된다.
 *   Storix가 413으로 먼저 응답하고 프록시가 본문 전송 중 연결을 닫을 때 재현됐다.
 *
 * async iterator로 청크를 하나씩 당기면 종료·오류가 읽기 결과로만 전달된다.
 * 소비자가 읽는 만큼만 당기므로 백프레셔도 유지된다.
 */
export function toWebStream(source: Readable): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value as Uint8Array);
      },
      async cancel() {
        // iterator.return()이 원본 스트림을 destroy한다.
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}
