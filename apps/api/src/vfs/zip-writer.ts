// 입력 검증을 마친 FILE 목록을 ZIP32 stream으로 작성한다.
// 이름·경로·원본 무결성 검증은 호출자가 맡고, 반환된 source의 종료는 writer가 맡는다.
// opener는 전달된 signal로 대기 중인 I/O를 취소해야 한다. settled는 opener와 stream 정리를 기다린다.
import { crc32, createDeflateRaw } from 'node:zlib';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import {
  ZIP_METHOD_DEFLATED,
  ZIP_METHOD_STORED,
  encodeCentralDirectoryEntry,
  encodeDataDescriptor,
  encodeEndOfCentralDirectory,
  encodeLocalFileHeader,
} from './zip-format.js';
import { VfsArchiveResultTooLargeError } from './vfs.errors.js';

const ZIP32_MAX = 0xffff_ffff;
const ZIP32_ENTRY_MAX = 65_534;

/** ZIP archive에 쓸 entry metadata다. */
export interface ZipWriterEntry {
  /** ZIP 안의 UTF-8 상대 경로다. */
  name: string;

  /** ZIP DOS timestamp의 원천 시각이다. */
  modifiedAt: Date;
}

/** ZIP writer의 실행 제한과 취소 신호다. */
export interface ZipWriterOptions {
  /** 0은 STORED, 1~9는 DEFLATED 압축 수준이다. */
  compressionLevel: number;

  /** ZIP record를 포함한 전체 출력 상한이다. */
  maxResultBytes: bigint;

  /** 실행 취소 신호다. */
  signal: AbortSignal;
}

/** ZIP output과 실행 완료·취소 제어를 제공한다. */
export interface ZipWriteExecution {
  /** 생성 중인 ZIP byte stream이다. */
  output: Readable;

  /** output 소비와 열린 source·압축 단계의 종료까지 기다리는 실행 결과다. */
  settled: Promise<void>;

  /** 실행 중인 source·compressor·output을 취소한다. */
  abort(error: Error): void;

  /** output으로 보낸 byte 수다. */
  readonly outputBytes: number;
}

/**
 * 제한된 ZIP32 archive를 한 entry씩 stream으로 작성한다.
 *
 * - 호출자는 이름·경로를 검증한 entries와 취소 신호를 I/O에 전달하는 opener를 제공한다.
 * - writer는 opener가 반환한 source를 소유하고 파괴 후 종료까지 기다린다.
 * - 호출자는 output을 소비해야 성공 settled가 완료된다.
 * - opener가 취소에 응답하지 않으면 settled도 해당 호출의 정착을 기다린다.
 */
export function createZipWriter<T extends ZipWriterEntry>(
  entries: readonly T[],
  openEntry: (entry: T, index: number, signal: AbortSignal) => Promise<Readable>,
  options: ZipWriterOptions,
): ZipWriteExecution {
  if (entries.length > ZIP32_ENTRY_MAX) throw new RangeError('ZIP32 entry count exceeds 65534');
  if (
    !Number.isInteger(options.compressionLevel) ||
    options.compressionLevel < 0 ||
    options.compressionLevel > 9
  ) {
    throw new RangeError('ZIP compression level must be between 0 and 9');
  }
  if (options.maxResultBytes <= 0n || options.maxResultBytes > 2_147_483_648n) {
    throw new RangeError('ZIP result limit must be between 1 and 2147483648 bytes');
  }

  const output = new PassThrough();
  output.on('error', () => undefined);
  const controller = new AbortController();
  let totalBytes = 0n;
  let activeSource: Readable | undefined;

  const abort = (error: Error): void => {
    if (!controller.signal.aborted) controller.abort(error);
    if (!output.destroyed) output.destroy(error);
    if (activeSource && !activeSource.destroyed) activeSource.destroy(error);
  };
  const outputError = (error: Error): void => abort(error);
  const outputClose = (): void => {
    if (!output.readableEnded) abort(output.errored ?? new Error('ZIP output closed before completion'));
  };
  output.on('error', outputError);
  output.once('close', outputClose);
  const externalAbort = (): void => abort(toError(options.signal.reason));
  if (options.signal.aborted) externalAbort();
  else options.signal.addEventListener('abort', externalAbort, { once: true });

  const write = async (bytes: Buffer): Promise<void> => {
    throwIfAborted(controller.signal);
    if (output.destroyed) throw output.errored ?? new Error('ZIP output closed before completion');
    const nextSize = totalBytes + BigInt(bytes.length);
    if (nextSize > options.maxResultBytes) throw new VfsArchiveResultTooLargeError();
    if (nextSize > BigInt(ZIP32_MAX)) throw new Error('ZIP32 archive offset exceeded');
    totalBytes = nextSize;
    if (output.write(bytes)) return;
    await waitForDrain(output, controller.signal);
  };

  const run = async (): Promise<void> => {
    const centralDirectory: Buffer[] = [];
    try {
      for (const [index, entry] of entries.entries()) {
        throwIfAborted(controller.signal);
        const name = Buffer.from(entry.name, 'utf8');
        if (name.length > 0xffff) throw new Error('ZIP entry name exceeds 65535 bytes');
        const method = options.compressionLevel === 0 ? ZIP_METHOD_STORED : ZIP_METHOD_DEFLATED;
        const localHeaderOffset = toZip32Number(totalBytes, 'local header offset');
        await write(encodeLocalFileHeader(name, entry.modifiedAt, method));

        const source = await openEntry(entry, index, controller.signal);
        activeSource = source;
        let crc = 0;
        let uncompressedSize = 0n;
        let compressedSize = 0n;
        const integrity = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            uncompressedSize += BigInt(bytes.length);
            if (uncompressedSize > BigInt(ZIP32_MAX)) {
              callback(new Error('ZIP32 entry size exceeded'));
              return;
            }
            crc = crc32(bytes, crc);
            callback(null, bytes);
          },
        });
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            compressedSize += BigInt(bytes.length);
            void write(bytes).then(
              () => callback(),
              (error: unknown) => callback(toError(error)),
            );
          },
        });
        const deflater =
          method === ZIP_METHOD_DEFLATED ? createDeflateRaw({ level: options.compressionLevel }) : undefined;
        const stages = deflater ? [source, integrity, deflater, sink] : [source, integrity, sink];
        // 공유 output을 pipeline에 반복 연결하지 않는다. 각 entry는 전용 sink를 소유한다.
        const closed = stages.map(waitForClose);
        try {
          throwIfAborted(controller.signal);
          if (deflater) {
            await pipeline(source, integrity, deflater, sink, { signal: controller.signal });
          } else {
            await pipeline(source, integrity, sink, { signal: controller.signal });
          }
        } finally {
          for (const stage of stages) {
            if (!stage.destroyed) stage.destroy();
          }
          await Promise.all(closed);
          activeSource = undefined;
        }

        const compressed = toZip32Number(compressedSize, 'compressed entry size');
        const uncompressed = toZip32Number(uncompressedSize, 'uncompressed entry size');
        await write(encodeDataDescriptor(crc, compressed, uncompressed));
        centralDirectory.push(
          encodeCentralDirectoryEntry({
            name,
            modifiedAt: entry.modifiedAt,
            method,
            crc32: crc,
            compressedSize: compressed,
            uncompressedSize: uncompressed,
            localHeaderOffset,
          }),
        );
      }

      const directoryOffset = toZip32Number(totalBytes, 'central directory offset');
      const directorySize = centralDirectory.reduce((total, record) => total + BigInt(record.length), 0n);
      toZip32Number(directorySize, 'central directory size');
      for (const record of centralDirectory) await write(record);
      await write(
        encodeEndOfCentralDirectory({
          entryCount: entries.length,
          centralDirectorySize: Number(directorySize),
          centralDirectoryOffset: directoryOffset,
        }),
      );
      output.end();
      await finished(output, { cleanup: true });
    } catch (error) {
      const failure = controller.signal.aborted ? toError(controller.signal.reason) : toError(error);
      if (!output.destroyed) output.destroy(failure);
      throw failure;
    } finally {
      options.signal.removeEventListener('abort', externalAbort);
      output.off('error', outputError);
      output.off('close', outputClose);
    }
  };

  const settled = run();
  void settled.catch(() => undefined);
  return {
    output,
    settled,
    abort,
    get outputBytes() {
      return Number(totalBytes);
    },
  };
}

/** ZIP32 unsigned 32-bit 값 범위인지 검사한다. */
export function toZip32Number(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(ZIP32_MAX)) throw new RangeError(`ZIP32 ${label} exceeded`);
  return Number(value);
}

/** 취소되었으면 최초 취소 사유를 던진다. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw toError(signal.reason);
}

/** 알 수 없는 실패 값을 Error로 변환한다. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value ?? 'ZIP writer aborted'));
}

/** output backpressure가 풀리거나 stream 오류·취소가 발생할 때까지 기다린다. */
function waitForDrain(stream: PassThrough, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(stream.errored ?? new Error('ZIP output closed before drain'));
      return;
    }
    const cleanup = (): void => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(stream.errored ?? new Error('ZIP output closed before drain'));
    };
    const onAbort = (): void => {
      cleanup();
      reject(toError(signal.reason));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** close 이벤트 또는 closed 상태로 비동기 destroy callback 완료를 기다린다. */
function waitForClose(stream: Readable | Writable): Promise<void> {
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
