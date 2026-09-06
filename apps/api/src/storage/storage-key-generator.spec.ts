import { StorageKeyGenerator } from './storage-key-generator.js';

describe('StorageKeyGenerator', () => {
  const generator = new StorageKeyGenerator();

  it('blobs/{shard}/{uuid} 형식의 key를 생성한다', () => {
    const key = generator.generate();

    expect(key).toMatch(/^blobs\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('호출할 때마다 서로 다른 key를 생성한다', () => {
    const first = generator.generate();
    const second = generator.generate();

    expect(first).not.toBe(second);
  });
});
