/** `StorageKeyGenerator`가 만드는 영구 object key의 prefix다(`blobs/{shard}/{uuid}`). */
export const BLOB_KEY_PREFIX = 'blobs/';

/** 업로드 조각 임시 object key의 prefix다(`upload-staging/{uuid}`). */
export const UPLOAD_STAGING_KEY_PREFIX = 'upload-staging/';

/**
 * Storix가 만드는 object key의 prefix 전체다. STORIX_STORAGE_BUCKET에 Storix가 만들지 않은
 * object가 섞여 있어도 GC·백업·복구는 이 prefix 안의 key만 다룬다.
 */
export const STORIX_KEY_PREFIXES: readonly string[] = [BLOB_KEY_PREFIX, UPLOAD_STAGING_KEY_PREFIX];

/** key가 Storix가 만드는 key의 prefix 안에 있으면 true다. */
export function isStorixKey(key: string): boolean {
  return STORIX_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
