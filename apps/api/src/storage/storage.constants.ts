export const STORAGE_CLIENT = Symbol('STORAGE_CLIENT');
export const STORAGE_PUBLIC_CLIENT = Symbol('STORAGE_PUBLIC_CLIENT');
export const STORAGE_BUCKET = Symbol('STORAGE_BUCKET');
export const BLOB_STORAGE = Symbol('BLOB_STORAGE');
/** PUT 소유권 래퍼를 거치지 않는 storage provider 토큰이다. 온라인 PUT에서는 사용하지 않는다. */
export const RAW_BLOB_STORAGE = Symbol('RAW_BLOB_STORAGE');
