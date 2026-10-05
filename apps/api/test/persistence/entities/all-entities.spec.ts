import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ENTITIES } from '../../../src/persistence/entities/all-entities.js';

const entitiesDir = join(fileURLToPath(new URL('.', import.meta.url)), '../../../src/persistence/entities');

describe('ALL_ENTITIES', () => {
  it('entities 디렉터리의 모든 entity 클래스를 중복 없이 담는다', async () => {
    const files = readdirSync(entitiesDir).filter((file) => file.endsWith('.entity.ts'));
    expect(files.length).toBeGreaterThan(0);
    const declared: string[] = [];
    for (const file of files) {
      const module = (await import(
        `../../../src/persistence/entities/${file.replace(/\.ts$/, '.js')}`
      )) as Record<string, unknown>;
      const names = Object.values(module)
        .filter((value): value is { name: string } => typeof value === 'function')
        .map((value) => value.name)
        .filter((name) => name.endsWith('Entity'));
      expect(names).toHaveLength(1);
      declared.push(...names);
    }
    expect(new Set(ALL_ENTITIES).size).toBe(ALL_ENTITIES.length);
    expect(ALL_ENTITIES.map((entity) => entity.name).sort()).toEqual(declared.sort());
  });
});
