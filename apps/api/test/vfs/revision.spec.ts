import { decodeRevision, encodeRevision, MAX_VFS_VERSION } from '../../src/vfs/revision.js';
import { VfsInvalidRevisionError, VfsRevisionExhaustedError } from '../../src/vfs/vfs.errors.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('VFS revision', () => {
  it('encodes the UUID and version into a canonical 24-byte token', () => {
    const token = encodeRevision({ id, version: 1 });
    expect(token).toMatch(/^r1\.[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(token.slice(3), 'base64url')).toHaveLength(24);
    expect(decodeRevision(token)).toEqual({ id, version: 1 });
    expect(decodeRevision(encodeRevision({ id, version: MAX_VFS_VERSION }))).toEqual({
      id,
      version: MAX_VFS_VERSION,
    });
  });

  it('int4 상한(2147483647)을 넘는 version도 왕복한다', () => {
    expect(decodeRevision(encodeRevision({ id, version: 2147483648 }))).toEqual({ id, version: 2147483648 });
  });

  it.each([
    '',
    'r2.AAAA',
    'r1.!',
    `r1.${Buffer.alloc(23).toString('base64url')}`,
    `r1.${Buffer.alloc(25).toString('base64url')}`,
    `r1.${Buffer.alloc(24).toString('base64url')}`,
    `r1.${Buffer.concat([Buffer.from(id.replaceAll('-', ''), 'hex'), Buffer.alloc(8)]).toString('base64url')}`,
    `r1.${(() => {
      const bytes = Buffer.alloc(24);
      Buffer.from(id.replaceAll('-', ''), 'hex').copy(bytes);
      bytes.writeBigUInt64BE(BigInt(MAX_VFS_VERSION) + 1n, 16);
      return bytes.toString('base64url');
    })()}`,
  ])('rejects malformed or out-of-range token %s', (token) => {
    expect(() => decodeRevision(token)).toThrow(VfsInvalidRevisionError);
  });

  it('rejects an exhausted version before encoding', () => {
    expect(() => encodeRevision({ id, version: MAX_VFS_VERSION + 1 })).toThrow(VfsRevisionExhaustedError);
  });

  it.each(['00000000-0000-0000-0000-000000000000', 'not-a-uuid'])(
    'rejects invalid node ID %s',
    (invalidId) => {
      expect(() => encodeRevision({ id: invalidId, version: 1 })).toThrow(VfsInvalidRevisionError);
    },
  );
});
