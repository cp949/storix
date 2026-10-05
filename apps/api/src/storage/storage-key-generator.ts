import { randomUUID } from 'node:crypto';
import { BLOB_KEY_PREFIX } from './storage-key-prefixes.js';

export class StorageKeyGenerator {
  generate(): string {
    const id = randomUUID();
    const shard = id.slice(0, 2);
    return `${BLOB_KEY_PREFIX}${shard}/${id}`;
  }
}
