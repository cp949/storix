import type { GcCursorRepository } from '../../src/persistence/gc-cursor.repository.js';

export function runGcCursorRepositorySharedTests(
  get: () => { readonly repository: GcCursorRepository },
): void {
  it('저장한 적 없는 이름은 null이다', async () => {
    expect(await get().repository.read('never-written')).toBeNull();
  });

  it('저장한 위치를 읽고 덮어쓴다', async () => {
    const { repository } = get();
    await repository.write('change-feed-prune', '{"a":1}');
    expect(await repository.read('change-feed-prune')).toBe('{"a":1}');
    await repository.write('change-feed-prune', '{"a":2}');
    expect(await repository.read('change-feed-prune')).toBe('{"a":2}');
  });

  it('이름마다 독립이고 지우면 null로 돌아간다', async () => {
    const { repository } = get();
    await repository.write('one', 'x');
    await repository.write('two', 'y');
    await repository.clear('one');
    expect(await repository.read('one')).toBeNull();
    expect(await repository.read('two')).toBe('y');
    await repository.clear('one');
  });

  it('64자를 넘는 이름은 거부한다', async () => {
    await expect(get().repository.write('n'.repeat(65), 'x')).rejects.toThrow();
  });
}
