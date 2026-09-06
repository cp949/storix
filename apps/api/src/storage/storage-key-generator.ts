import { randomUUID } from 'node:crypto';

export class StorageKeyGenerator {
  generate(): string {
    const id = randomUUID();
    const shard = id.slice(0, 2);
    return `blobs/${shard}/${id}`;
  }
}
