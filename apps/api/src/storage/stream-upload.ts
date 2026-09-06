import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import type { BlobStorage } from './blob-storage.js';
import { VfsFileTooLargeError } from './storage.errors.js';

export interface StreamedUpload {
  readonly size: number;
  readonly sha256: string;
}

export async function uploadStream(
  storage: BlobStorage,
  key: string,
  source: Readable,
  contentType: string,
  maxBytes: number,
): Promise<StreamedUpload> {
  const sink = new PassThrough();
  const hash = createHash('sha256');
  let total = 0;
  let exceeded = false;

  const putPromise = storage.put(key, sink, contentType);
  const putSettled = putPromise.then(
    () => undefined,
    (error: unknown) => error,
  );

  // putSettled(microtask)를 매번 await하지 않고도 "이미 실패했는지"를 동기적으로
  // 확인하기 위한 캐시. PENDING과 성공(undefined)을 구분해야 실패 시에만 조기 중단한다.
  const PENDING = Symbol('pending');
  let putResult: unknown = PENDING;
  void putSettled.then((result) => {
    putResult = result;
  });

  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) {
        // sink.destroy(error)로 중단하면 minio-js 내부의 body.pipe(chunker)가
        // 'error'를 전파받지 못해(Node pipe()의 알려진 한계) chunker가 영원히
        // 대기하며 교착 상태에 빠진다. break로 정상 종료시켜 우회한다.
        exceeded = true;
        break;
      }
      hash.update(chunk);
      if (!sink.write(chunk)) {
        // storage.put()이 이미 실패했다면 sink를 더 이상 아무도 소비하지 않으므로
        // drain 이벤트가 영원히 오지 않아 여기서 무한정 대기(교착)한다. putSettled를
        // 함께 race시켜 put 실패가 drain을 대신 깨우도록 한다.
        await Promise.race([once(sink, 'drain'), putSettled]);
        if (putResult !== PENDING && putResult !== undefined) {
          // put이 이미 실패한 상태 — 아무도 읽지 않는 sink에 나머지 chunk를 계속
          // write하면 backpressure 없이 무한정 버퍼링되므로 즉시 루프를 중단한다.
          break;
        }
      }
    }
    sink.end();
  } catch (error) {
    // 클라이언트 연결 끊김 등 진짜 source 오류. sink.destroy(error)로 중단하면
    // minio-js 내부 body.pipe(chunker)가 'error'를 전파받지 못해 미처리 예외로
    // 프로세스가 죽는다(exceeded 분기와 동일한 근본 원인). sink.end()로 정상
    // 종료시켜 minio 업로드를 완료시킨 뒤 즉시 정리하고 원래 오류를 다시 던진다.
    sink.end();
    const putFailureOnSourceError = await putSettled;
    if (putFailureOnSourceError === undefined) {
      // 정상 종료 덕분에 MinIO에는 불완전한 데이터의 객체가 실제로 생성된다.
      // 어차피 버릴 데이터이므로 즉시 정리한다(정리 실패는 GC가 나중에 처리).
      await storage.delete(key).catch(() => undefined);
    }
    throw error;
  }

  const putFailure = await putSettled;

  if (exceeded) {
    if (putFailure === undefined) {
      // 정상 종료 덕분에 MinIO에는 한도 이하 크기의 잘린 객체가 실제로 생성된다.
      // 어차피 버릴 데이터이므로 즉시 정리한다(정리 실패는 GC가 나중에 처리).
      await storage.delete(key).catch(() => undefined);
    }
    throw new VfsFileTooLargeError(maxBytes);
  }

  if (putFailure !== undefined) {
    throw putFailure;
  }

  return { size: total, sha256: hash.digest('hex') };
}
