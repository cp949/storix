import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../common/uuid.js';
import { VfsInvalidChangeCursorError } from './vfs.errors.js';

const PREFIX = 'cf1.';
const MAX_SEQUENCE = 9223372036854775807n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function signature(payload: string, signingSecret: string): Buffer {
  return createHmac('sha256', Buffer.from(signingSecret, 'hex'))
    .update(`storix-vfs-change-feed-v1:${payload}`)
    .digest();
}

export function encodeChangeFeedCursor(namespaceId: string, sequence: string, signingSecret: string): string {
  const payload = Buffer.from(JSON.stringify({ namespaceId, sequence }), 'utf8').toString('base64url');
  return `${PREFIX}${payload}.${signature(payload, signingSecret).toString('base64url')}`;
}

export function decodeChangeFeedCursor(raw: string, namespaceId: string, signingSecret: string): string {
  const match = /^cf1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!match || raw.length > 230) throw new VfsInvalidChangeCursorError();
  const mac = Buffer.from(match[2], 'base64url');
  if (
    mac.length !== 32 ||
    mac.toString('base64url') !== match[2] ||
    !timingSafeEqual(mac, signature(match[1], signingSecret))
  )
    throw new VfsInvalidChangeCursorError();
  try {
    const decoded = Buffer.from(match[1], 'base64url');
    if (decoded.toString('base64url') !== match[1]) throw new VfsInvalidChangeCursorError();
    const value: unknown = JSON.parse(decoded.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new VfsInvalidChangeCursorError();
    const record = value as Record<string, unknown>;
    if (
      typeof record.namespaceId !== 'string' ||
      !isUuid(record.namespaceId) ||
      record.namespaceId !== namespaceId ||
      typeof record.sequence !== 'string' ||
      !DECIMAL.test(record.sequence) ||
      BigInt(record.sequence) > MAX_SEQUENCE ||
      encodeChangeFeedCursor(record.namespaceId, record.sequence, signingSecret) !== raw
    )
      throw new VfsInvalidChangeCursorError();
    return record.sequence;
  } catch {
    throw new VfsInvalidChangeCursorError();
  }
}
