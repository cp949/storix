import type { VfsNodeRecord } from '../persistence/vfs-node.repository.js';
import { VfsInvalidRevisionError, VfsRevisionExhaustedError } from './vfs.errors.js';

export const MAX_VFS_VERSION = 2147483647;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^r1\.([A-Za-z0-9_-]{32})$/;

export function encodeRevision(node: Pick<VfsNodeRecord, 'id' | 'version'>): string {
  if (!Number.isSafeInteger(node.version) || node.version < 1 || node.version > MAX_VFS_VERSION) {
    throw new VfsRevisionExhaustedError();
  }
  const id = node.id.toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw new VfsInvalidRevisionError();
  }
  const bytes = Buffer.alloc(24);
  Buffer.from(id.replaceAll('-', ''), 'hex').copy(bytes, 0);
  bytes.writeBigUInt64BE(BigInt(node.version), 16);
  return `r1.${bytes.toString('base64url')}`;
}

export function decodeRevision(raw: string): { id: string; version: number } {
  const match = TOKEN_PATTERN.exec(raw);
  if (!match) {
    throw new VfsInvalidRevisionError();
  }
  const bytes = Buffer.from(match[1], 'base64url');
  if (bytes.length !== 24) {
    throw new VfsInvalidRevisionError();
  }
  const hex = bytes.subarray(0, 16).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const value = bytes.readBigUInt64BE(16);
  if (!UUID_PATTERN.test(id) || value < 1n || value > BigInt(MAX_VFS_VERSION)) {
    throw new VfsInvalidRevisionError();
  }
  const version = Number(value);
  if (encodeRevision({ id, version }) !== raw) {
    throw new VfsInvalidRevisionError();
  }
  return { id, version };
}
