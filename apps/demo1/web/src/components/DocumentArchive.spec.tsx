import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listDocuments, searchDocuments, uploadDocument, createDirectory, moveEntry, removeEntry, createDownload, publishDocument, unpublishDocument } from '../api/client';
import type { EntryPage } from '../api/types';
import { ErrorPanel } from '../error/ErrorPanel';
import { ErrorProvider } from '../error/ErrorContext';
import { DocumentArchive } from './DocumentArchive';
import { FolderTree } from './FolderTree';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listDocuments: vi.fn(),
    searchDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    createDirectory: vi.fn(),
    moveEntry: vi.fn(),
    copyEntry: vi.fn(),
    removeEntry: vi.fn(),
    createDownload: vi.fn(),
    publishDocument: vi.fn(),
    unpublishDocument: vi.fn(),
  };
});

// FolderTree는 자체 테스트(FolderTree.spec.tsx)에서 검증한다. 여기서는
// listDocuments 호출 횟수를 DocumentArchive 자체 로직에만 묶어두기 위해
// 기본은 아무것도 렌더링하지 않는 스텁으로 대체하고, 연동 확인이 필요한
// 테스트에서만 onNavigate를 노출하는 버튼으로 바꿔 끼운다.
vi.mock('./FolderTree', () => ({ FolderTree: vi.fn(() => null) }));

function page(items: EntryPage['items']): EntryPage {
  return { items, nextCursor: null };
}

const entryA = {
  path: '/a.txt',
  name: 'a.txt',
  type: 'FILE' as const,
  size: 1,
  mimeType: 'text/plain',
  createdAt: '',
  updatedAt: '',
  version: 1,
};

const dirReports = {
  path: '/reports',
  name: 'reports',
  type: 'DIRECTORY' as const,
  size: null,
  mimeType: null,
  createdAt: '',
  updatedAt: '',
  version: 1,
};

async function selectRow(text: string) {
  fireEvent.click(await screen.findByText(text, { exact: false }));
}

describe('DocumentArchive', () => {
  beforeEach(() => {
    vi.mocked(listDocuments).mockReset();
    vi.mocked(searchDocuments).mockReset();
    vi.mocked(FolderTree).mockClear();
    vi.mocked(FolderTree).mockImplementation((() => null) as unknown as typeof FolderTree);
  });

  it('마운트되면 root 목록을 불러와 표시한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    expect(await screen.findByText('a.txt', { exact: false })).toBeTruthy();
    expect(listDocuments).toHaveBeenCalledWith('alice', '/');
  });

  it('사이드바 트리에서 폴더로 이동하면 그 경로로 목록을 다시 불러온다', async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce(page([dirReports]));
    vi.mocked(listDocuments).mockResolvedValueOnce(page([]));
    vi.mocked(FolderTree).mockImplementation(({ onNavigate }) => (
      <button type="button" onClick={() => onNavigate('/reports')}>
        tree-nav-reports
      </button>
    ));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('alice', '/'));

    fireEvent.click(screen.getByText('tree-nav-reports'));

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('alice', '/reports'));
  });

  it('디렉터리를 선택하고 열기를 누르면 그 경로로 목록을 다시 불러온다', async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce(page([dirReports]));
    vi.mocked(listDocuments).mockResolvedValueOnce(page([]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    await selectRow('reports');
    fireEvent.click(screen.getByText('열기'));

    await waitFor(() => expect(listDocuments).toHaveBeenCalledWith('alice', '/reports'));
  });

  it('검색을 실행하면 결과로 목록이 대체되고, 돌아가기를 누르면 원래 목록으로 복귀한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(searchDocuments).mockResolvedValue(page([{ ...entryA, path: '/found.txt', name: 'found.txt' }]));

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );

    fireEvent.change(screen.getByLabelText('검색어'), { target: { value: 'found' } });
    fireEvent.click(screen.getByText('검색'));

    expect(await screen.findByText('found.txt', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByText('목록으로 돌아가기'));

    await waitFor(() => expect(screen.queryByText('found.txt', { exact: false })).toBeNull());
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
    vi.mocked(uploadDocument).mockResolvedValue({ ...entryA, size: 5 });

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
    vi.mocked(uploadDocument).mockResolvedValue({ ...entryA, path: '/b.txt', name: 'b.txt' });

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

  it('새 폴더 이름을 입력하고 제출하면 현재 경로 아래에 디렉터리를 만든다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([]));
    vi.mocked(createDirectory).mockResolvedValue(undefined);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('새 폴더 이름'), { target: { value: 'reports' } });
    fireEvent.click(screen.getByText('폴더 만들기'));

    await waitFor(() => expect(createDirectory).toHaveBeenCalledWith('alice', '/reports'));
  });

  it('항목을 선택하고 이동 버튼을 누르면 prompt로 받은 대상 경로로 이동을 요청한다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(moveEntry).mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue('/archive/a.txt');

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('이동'));

    await waitFor(() => expect(moveEntry).toHaveBeenCalledWith('alice', '/a.txt', '/archive/a.txt'));
  });

  it('선택 후 삭제는 confirm에서 취소하면 removeEntry를 호출하지 않는다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('삭제'));

    expect(removeEntry).not.toHaveBeenCalled();
  });

  it('root 밖으로 이동을 시도해 403이 나면 오류 패널에 그대로 표시된다(경로 이탈 데모)', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(moveEntry).mockRejectedValue(new ApiError(403, 'DOCUMENT_PATH_ESCAPES_ROOT', 'req-9', '경로 이탈'));
    vi.spyOn(window, 'prompt').mockReturnValue('../bob/secret.txt');

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
        <ErrorPanel />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('이동'));

    expect(await screen.findByText(/DOCUMENT_PATH_ESCAPES_ROOT/)).toBeTruthy();
  });

  it('선택 후 다운로드 버튼을 누르면 presigned URL을 새 창으로 연다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(createDownload).mockResolvedValue({ url: 'http://signed.test/x', expiresAt: '2026-01-01T00:00:00.000Z' });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('다운로드'));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('http://signed.test/x', '_blank'));
  });

  it('선택 후 발행을 확인하면 공개 링크와 복사/발행취소 버튼이 나타난다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(publishDocument).mockResolvedValue({ url: 'http://public.test/x', publicPath: 'abcd1234/a.txt' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('발행'));

    expect(await screen.findByText('공개 링크')).toBeTruthy();
    expect(screen.getByText('발행 취소')).toBeTruthy();
  });

  it('발행 확인을 취소하면 publishDocument를 호출하지 않는다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('발행'));

    expect(publishDocument).not.toHaveBeenCalled();
  });

  it('발행 취소를 누르면 공개 링크가 사라지고 다시 발행 버튼이 보인다', async () => {
    vi.mocked(listDocuments).mockResolvedValue(page([entryA]));
    vi.mocked(publishDocument).mockResolvedValue({ url: 'http://public.test/x', publicPath: 'abcd1234/a.txt' });
    vi.mocked(unpublishDocument).mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <ErrorProvider>
        <DocumentArchive user="alice" />
      </ErrorProvider>,
    );
    await selectRow('a.txt');
    fireEvent.click(screen.getByText('발행'));
    fireEvent.click(await screen.findByText('발행 취소'));

    await waitFor(() => expect(screen.queryByText('공개 링크')).toBeNull());
    expect(screen.getByText('발행')).toBeTruthy();
  });
});
