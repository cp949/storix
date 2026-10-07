import { createHash } from 'node:crypto';
import type { StoragePutOwnershipRepository } from '../persistence/storage-put-ownership.repository.js';
import type { BlobStorage, IncompleteUploadInfo } from './blob-storage.js';

const LEGACY_PREFIXES = ['blobs/', 'upload-staging/'] as const;

/** 운영자가 확인하고 legacy multipart 회수에 승인할 manifest다. */
export interface LegacyMultipartManifest {
  /** 회수 대상의 key, S3 upload ID, gateway 시작 시각이다. */
  readonly uploads: readonly {
    readonly key: string;
    readonly uploadId: string;
    readonly initiated: string;
  }[];
  /** uploads 직렬화 결과의 SHA-256이다. */
  readonly sha256?: string;
}

/** 수동 종료 확인과 기존 미등록 multipart 유지보수 작업을 제공한다. */
export class StoragePutAdminService {
  constructor(
    private readonly storage: BlobStorage,
    private readonly ownership: StoragePutOwnershipRepository,
  ) {}

  /** 소유권 기록이 없는 Storix prefix의 multipart를 정확한 key·uploadId 목록으로 반환한다. */
  async createLegacyManifest(): Promise<LegacyMultipartManifest & { readonly sha256: string }> {
    const uploads: Array<{ key: string; uploadId: string; initiated: string }> = [];
    for (const prefix of LEGACY_PREFIXES) {
      let after: string | undefined;
      for (;;) {
        const page = await this.storage.listIncompleteUploadsPage(prefix, { after, limit: 1000 });
        for (const upload of page.items) {
          if (!(await this.ownership.hasKeyRecord(upload.key))) uploads.push(serializeUpload(upload));
        }
        if (!page.next) break;
        if (page.next === after) throw new Error(`multipart manifest page가 진행되지 않음: ${prefix}`);
        after = page.next;
      }
    }
    uploads.sort(
      (left, right) => left.key.localeCompare(right.key) || left.uploadId.localeCompare(right.uploadId),
    );
    return { uploads, sha256: digest(uploads) };
  }

  /** 확인한 digest와 일치하며 여전히 미등록인 manifest 항목만 abort한다. */
  async abortLegacyManifest(manifest: LegacyMultipartManifest, expectedSha256: string): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || digest(manifest.uploads) !== expectedSha256) {
      throw new Error('manifest SHA-256 불일치');
    }
    const seen = new Set<string>();
    for (const upload of manifest.uploads) {
      if (
        !upload.key ||
        !upload.uploadId ||
        !LEGACY_PREFIXES.some((prefix) => upload.key.startsWith(prefix)) ||
        seen.has(`${upload.key}\0${upload.uploadId}`)
      ) {
        throw new Error('manifest에 유효하지 않거나 중복된 multipart 항목이 있음');
      }
      seen.add(`${upload.key}\0${upload.uploadId}`);
      if (await this.ownership.hasKeyRecord(upload.key)) {
        throw new Error(`소유권 기록이 생긴 key는 legacy abort할 수 없음: ${upload.key}`);
      }
    }
    for (const upload of manifest.uploads) {
      await this.storage.abortIncompleteUpload(upload.key, upload.uploadId);
    }
    return manifest.uploads.length;
  }
}

function serializeUpload(upload: IncompleteUploadInfo) {
  return { key: upload.key, uploadId: upload.uploadId, initiated: upload.initiated.toISOString() };
}

function digest(uploads: LegacyMultipartManifest['uploads']): string {
  return createHash('sha256').update(JSON.stringify(uploads)).digest('hex');
}
