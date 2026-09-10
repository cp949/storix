import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listDocuments, searchDocuments } from '../api/client';
import type { EntryPage } from '../api/types';
import { ErrorProvider } from '../error/ErrorContext';
import { DocumentArchive } from './DocumentArchive';

vi.mock('../api/client', () => ({
  listDocuments: vi.fn(),
  searchDocuments: vi.fn(),
}));

function page(items: EntryPage['items']): EntryPage {
  return { items, nextCursor: null };
}

describe('DocumentArchive', () => {
  beforeEach(() => {
    vi.mocked(listDocuments).mockReset();
    vi.mocked(searchDocuments).mockReset();
  });

  it('마운트되면 root 목록을 불러와 표시한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(
      page([
        {
          path: '/a.txt',
          name: 'a.txt',
          type: 'FILE',
          size: 1,
          mimeType: 'text/plain',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ]),
    );

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    expect(await screen.findByText('a.txt', { exact: false })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith('alice', '/');
  });

  it('디렉터리를 클릭하면 그 경로로 다시 목록을 불러온다', async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce(
      page([
        {
          path: '/reports',
          name: 'reports',
          type: 'DIRECTORY',
          size: null,
          mimeType: null,
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ]),
    );
    vi.mocked(listDocuments).mockResolvedValueOnce(page([]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    fireEvent.click(await screen.findByText('reports', { exact: false }));

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('alice', '/reports'));
  });

  it('검색을 실행하면 결과로 목록이 대체되고, 돌아가기를 누르면 원래 목록으로 복귀한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(searchDocuments).mockResolvedValue(
      page([
        {
          path: '/found.txt',
          name: 'found.txt',
          type: 'FILE',
          size: 1,
          mimeType: 'text/plain',
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ]),
    );

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    fireEvent.change(screen.getByLabelText('검색어'), { target: { value: 'found' } });
    fireEvent.click(screen.getByText('검색'));

    expect(await screen.findByText('found.txt', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText('목록으로 돌아가기'));

    await waitFor(() => expect(screen.queryByText('found.txt')).toBeNull());
  });

  it('사용자를 전환하면 경로가 root로 리셋되고 새 사용자로 목록을 다시 불러온다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));

    const { rerender } = render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('alice', '/'));

    rerender(
      <ErrorProvider>
        <DocumentArchive user="bob" />
      </ErrorProvider>,
    );

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('bob', '/'));
  });
});
