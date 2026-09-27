import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { loadUploadSessionPolicy } from '../../src/vfs/upload-session-config.js';

const NS = '123e4567-e89b-42d3-a456-426614174000';
const enabled = {
  globalAllowedCapabilities: ['resumable-upload'],
  namespaceAllowedCapabilities: { [NS]: ['resumable-upload'] },
};

describe('upload session policy', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storix-upload-policy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(value: unknown, capabilities = enabled) {
    const path = join(dir, 'upload.json');
    await writeFile(path, JSON.stringify(value));
    return loadUploadSessionPolicy(
      new ConfigService({ STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: path }),
      capabilities,
    );
  }

  it('disabled capability permits an absent policy', async () => {
    await expect(
      loadUploadSessionPolicy(new ConfigService({}), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: {},
      }),
    ).resolves.toBeNull();
  });

  it('enabled capability requires a policy', async () => {
    await expect(loadUploadSessionPolicy(new ConfigService({}), enabled)).rejects.toThrow(/policy|config/i);
    await expect(
      loadUploadSessionPolicy(new ConfigService({}), {
        globalAllowedCapabilities: [],
        namespaceAllowedCapabilities: { [NS]: ['resumable-upload'] },
      }),
    ).rejects.toThrow(/policy|config/i);
  });

  it('loads finite caps and documented defaults', async () => {
    await expect(
      load({
        global: { maxStagedBytes: '104857600', maxActiveSessions: 10 },
        namespaces: { [NS]: { maxStagedBytes: '52428800', maxActiveSessions: 5 } },
      }),
    ).resolves.toEqual({
      global: {
        maxStagedBytes: 104857600n,
        maxActiveSessions: 10,
        partSizeBytes: 16777216,
        inactivitySeconds: 86400,
        maxLifetimeSeconds: 604800,
      },
      namespaces: { [NS]: { maxStagedBytes: 52428800n, maxActiveSessions: 5 } },
    });
  });

  it.each([
    {
      global: { maxStagedBytes: '0', maxActiveSessions: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '9223372036854775808', maxActiveSessions: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: Number.MAX_SAFE_INTEGER + 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 0 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: null },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1, partSizeBytes: 2147483648 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1 },
      namespaces: { [NS]: { maxStagedBytes: '101', maxActiveSessions: 1 } },
    },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 2 } },
    },
    { global: { maxStagedBytes: '100', maxActiveSessions: 1 }, namespaces: {} },
    {
      global: { maxStagedBytes: '100', maxActiveSessions: 1 },
      namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1, extra: true } },
    },
  ])('rejects invalid or missing finite policy limits: %j', async (value) => {
    await expect(load(value)).rejects.toThrow();
  });

  it('rejects a lifetime that cannot be represented as a JavaScript Date', async () => {
    await expect(
      load({
        global: {
          maxStagedBytes: '100',
          maxActiveSessions: 1,
          inactivitySeconds: 1,
          maxLifetimeSeconds: Number.MAX_SAFE_INTEGER,
        },
        namespaces: { [NS]: { maxStagedBytes: '1', maxActiveSessions: 1 } },
      }),
    ).rejects.toThrow(/Date range/);
  });
});
