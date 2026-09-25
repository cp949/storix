import { VfsNodeRepository, type MutationTx } from './vfs-node.repository.js';
import type { ConditionalMutation } from '../vfs/dto/conditional-mutation-request.dto.js';

describe('VfsNodeRepository conditional path validation', () => {
  const repository = Object.create(VfsNodeRepository.prototype) as VfsNodeRepository;
  const tx = {} as MutationTx;

  it.each<ConditionalMutation>([
    { kind: 'mkdir', path: '/e\u0301', segments: ['e\u0301'], ifAbsent: true },
    { kind: 'delete', path: '/e\u0301', segments: ['e\u0301'], ifRevision: 'unused', recursive: false },
    {
      kind: 'move',
      source: '/e\u0301',
      sourceSegments: ['e\u0301'],
      destination: '/dst',
      destinationSegments: ['dst'],
      sourceRevision: 'unused',
      destinationAbsent: true,
    },
    {
      kind: 'copy',
      source: '/src',
      sourceSegments: ['src'],
      destination: '/e\u0301',
      destinationSegments: ['e\u0301'],
      sourceRevision: 'unused',
      destinationAbsent: true,
    },
  ])('direct $kind call rejects NFD segments before database work', async (command) => {
    await expect(repository.applyConditionalMutation(tx, command)).rejects.toMatchObject({ status: 400 });
  });

  it('direct content call rejects NFD segments before database work', async () => {
    await expect(
      repository.putConditionalContent(
        tx,
        ['e\u0301'],
        { ifAbsent: true },
        {
          storageKey: 'unused',
          size: '0',
          mimeType: 'text/plain',
          sha256: 'unused',
          encryptionIv: null,
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
