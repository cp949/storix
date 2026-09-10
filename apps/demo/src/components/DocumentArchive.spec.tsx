import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listDocuments, searchDocuments, uploadDocument } from '../api/client';
import type { EntryPage } from '../api/types';
import { ErrorPanel } from '../error/ErrorPanel';
import { ErrorProvider } from '../error/ErrorContext';
import { DocumentArchive } from './DocumentArchive';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    searchDocuments: vi.fn(),
    uploadDocument: vi.fn(),
  };
});

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

  it('파일을 선택하면 현재 경로에 업로드하고 성공 후 목록을 새로고침한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockResolvedValue({
      path: '/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 5,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('파일 업로드'), { target: { files: [file] } });

    await waitFor(() => expect(uploadDocument).toHaveBeenCalledWith('alice', '/a.txt', file));
    expect(await screen.findByText('업로드 완료')).toBeTruthy();
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });

  it('업로드가 실패하면 "업로드 실패"를 표시하고 오류를 보고한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockRejectedValue(new ApiError(413, 'UPLOAD_TOO_LARGE', 'req-1', '너무 큼'));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
        <ErrorPanel />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(['x'], 'big.bin');
    fireEvent.change(screen.getByLabelText('파일 업로드'), { target: { files: [file] } });

    expect(await screen.findByText('업로드 실패')).toBeTruthy();
    expect(await screen.findByText(/413/)).toBeTruthy();
    expect(await screen.findByText(/UPLOAD_TOO_LARGE/)).toBeTruthy();
  });

  it('drag-and-drop으로도 같은 경로에 업로드된다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(uploadDocument).mockResolvedValue({
      path: '/b.txt',
      name: 'b.txt',
      type: 'FILE',
      size: 1,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
    });

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    const file = new File(['b'], 'b.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByText('파일 업로드'), { dataTransfer: { files: [file] } });

    await waitFor(() => expect(uploadDocument).toHaveBeenCalledWith('alice', '/b.txt', file));
  });
});
