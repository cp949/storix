import { resolveTrashRetentionNodeLimit } from '../../src/vfs/trash-policy.js';

describe('trash retention policy', () => {
  it('uses the default of 100000 nodes when unset', () => {
    expect(resolveTrashRetentionNodeLimit(undefined)).toBe(100000);
  });

  it('accepts positive safe integers', () => {
    expect(resolveTrashRetentionNodeLimit('1')).toBe(1);
    expect(resolveTrashRetentionNodeLimit('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['0', '-1', '1.5', '1e3', '9007199254740992', '', ' 1'])('rejects invalid node limit %s', (value) => {
    expect(() => resolveTrashRetentionNodeLimit(value)).toThrow('Invalid trash retention node limit');
  });
});
