/**
 * VFS 콘텐츠 적재의 stream 크기 제한·SHA-256 계산·선택적 암호화 저장을 제공한다.
 * byte 상한은 평문 기준으로 적용한다.
 * 경로별 정책과 적재 성공 뒤 정리는 호출부가 담당한다.
 * 암호화 저장 방식은 api ADR-0009.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { EncryptingPutTarget } from '../encryption/encrypted-content.js';
import { MASTER_KEY } from '../encryption/encryption.constants.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { BLOB_STORAGE } from '../storage/storage.constants.js';
import { hashStream, uploadStream } from '../storage/stream-upload.js';

/** 콘텐츠 적재에서 계산한 평문 정보와 저장용 암호화 메타데이터다. */
export interface ContentIngressResult {
  /** 저장 전에 소비한 평문 byte 수다. */
  readonly size: number;

  /** 저장 전에 계산한 평문 SHA-256이다. */
  readonly sha256: string;

  /** 암호화 저장이면 복호화 IV고, 평문 저장이면 `null`이다. */
  readonly encryptionIv: Buffer | null;
}

/** VFS 적재 경로에서 평문 stream 제한·digest·선택적 암호화를 처리한다. */
@Injectable()
export class ContentIngressService {
  constructor(
    @Inject(BLOB_STORAGE) private readonly storage: BlobStorage,
    @Inject(MASTER_KEY) private readonly masterKey: Buffer | null,
  ) {}

  /** 평문 byte cap을 적용해 객체를 저장하고 평문 digest와 IV를 반환한다. */
  async upload(
    key: string,
    source: Readable,
    contentType: string,
    maxBytes: number,
    encrypted: boolean,
  ): Promise<ContentIngressResult> {
    const target = encrypted ? new EncryptingPutTarget(this.storage, this.requireMasterKey()) : this.storage;
    const uploaded = await uploadStream(target, key, source, contentType, maxBytes);
    return {
      ...uploaded,
      encryptionIv: target instanceof EncryptingPutTarget ? target.getIv() : null,
    };
  }

  /** 저장 없이 평문 stream의 byte cap·size·SHA-256을 계산한다. */
  hash(source: Readable, maxBytes: number): ReturnType<typeof hashStream> {
    return hashStream(source, maxBytes);
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) throw new Error('ENCRYPTED namespace master key missing');
    return this.masterKey;
  }
}
