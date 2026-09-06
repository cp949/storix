import type { Readable } from 'node:stream';

export interface BlobRange {
  readonly start: number;
  readonly end?: number;
}

export interface BlobObjectInfo {
  readonly key: string;
  readonly lastModified: Date;
}

export interface BlobStorage {
  put(key: string, stream: Readable, contentType?: string): Promise<void>;
  get(key: string, range?: BlobRange): Promise<Readable>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<BlobObjectInfo>;
}
