import { resolveBinaryColumnType, resolveFixedCharColumnType, resolveTimestampColumnType } from './dialect-column-types.js';

describe('resolveBinaryColumnType', () => {
  it("driver가 'sqlite'면 'blob'을 반환한다", () => {
    expect(resolveBinaryColumnType('sqlite')).toBe('blob');
  });

  it("driver가 'sqlite'가 아니면 'bytea'를 반환한다", () => {
    expect(resolveBinaryColumnType('postgres')).toBe('bytea');
    expect(resolveBinaryColumnType(undefined)).toBe('bytea');
  });
});

describe('resolveTimestampColumnType', () => {
  it("driver가 'sqlite'면 'datetime'을 반환한다", () => {
    expect(resolveTimestampColumnType('sqlite')).toBe('datetime');
  });

  it("driver가 'sqlite'가 아니면 'timestamptz'를 반환한다", () => {
    expect(resolveTimestampColumnType('postgres')).toBe('timestamptz');
    expect(resolveTimestampColumnType(undefined)).toBe('timestamptz');
  });
});

describe('resolveFixedCharColumnType', () => {
  it("driver가 'sqlite'면 'varchar'를 반환한다", () => {
    expect(resolveFixedCharColumnType('sqlite')).toBe('varchar');
  });

  it("driver가 'sqlite'가 아니면 'char'를 반환한다", () => {
    expect(resolveFixedCharColumnType('postgres')).toBe('char');
    expect(resolveFixedCharColumnType(undefined)).toBe('char');
  });
});
