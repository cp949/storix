// 비동기 stream destroy callback이 끝난 뒤 자원 소유권을 반환한다.
import type { Readable, Writable } from 'node:stream';

/** close 이벤트 또는 closed 상태로 비동기 destroy callback 완료를 기다린다. */
export function waitForClose(stream: Readable | Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const complete = (): void => {
      clearTimeout(timer);
      stream.off('close', complete);
      resolve();
    };
    const checkClosed = (): void => {
      if (stream.closed) complete();
      else timer = setTimeout(checkClosed, 10);
    };
    stream.once('close', complete);
    // emitClose: false인 source도 destroy callback 종료를 closed로 관측한다.
    timer = setTimeout(checkClosed, 10);
  });
}
