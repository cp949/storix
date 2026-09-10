import { useCallback, useEffect, useState } from 'react';
import { listDocuments, searchDocuments, uploadDocument } from '../api/client';
import type { DemoUser, FileEntry } from '../api/types';
import { useErrorReporter } from '../error/ErrorContext';
import { joinPath } from '../utils/path';

export interface DocumentArchiveProps {
  readonly user: DemoUser;
}

function splitBreadcrumb(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

export function DocumentArchive({ user }: DocumentArchiveProps) {
  const [currentPath, setCurrentPath] = useState('/');
  const [items, setItems] = useState<FileEntry[]>([]);
  const [searchName, setSearchName] = useState('');
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const { reportError, clearError } = useErrorReporter();

  const loadList = useCallback(
    async (path: string) => {
      try {
        const pageResult = await listDocuments(user, path);
        setItems(pageResult.items);
        clearError();
      } catch (cause) {
        reportError(cause);
      }
    },
    [user, reportError, clearError],
  );

  useEffect(() => {
    setCurrentPath('/');
  }, [user]);

  useEffect(() => {
    setSearchResults(null);
    void loadList(currentPath);
  }, [currentPath, loadList]);

  async function handleSearch() {
    try {
      const pageResult = await searchDocuments(user, '/', searchName);
      setSearchResults(pageResult.items);
      clearError();
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleUpload(file: File) {
    setUploadStatus('uploading');
    try {
      await uploadDocument(user, joinPath(currentPath, file.name), file);
      setUploadStatus('success');
      clearError();
      await loadList(currentPath);
    } catch (cause) {
      setUploadStatus('error');
      reportError(cause);
    }
  }

  const breadcrumbSegments = splitBreadcrumb(currentPath);
  const visibleItems = searchResults ?? items;

  return (
    <section aria-label="문서 아카이브">
      <nav aria-label="현재 위치">
        <button type="button" onClick={() => setCurrentPath('/')}>
          root
        </button>
        {breadcrumbSegments.map((segment, index) => {
          const path = `/${breadcrumbSegments.slice(0, index + 1).join('/')}`;
          return (
            <span key={path}>
              {' / '}
              <button type="button" onClick={() => setCurrentPath(path)}>
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSearch();
        }}
      >
        <label>
          검색어
          <input value={searchName} onChange={(event) => setSearchName(event.target.value)} />
        </label>
        <button type="submit">검색</button>
        {searchResults !== null && (
          <button type="button" onClick={() => setSearchResults(null)}>
            목록으로 돌아가기
          </button>
        )}
      </form>

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file) {
            void handleUpload(file);
          }
        }}
      >
        <label>
          파일 업로드
          <input
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleUpload(file);
              }
              event.target.value = '';
            }}
          />
        </label>
        <p role="status">
          {uploadStatus === 'uploading' && '업로드중...'}
          {uploadStatus === 'success' && '업로드 완료'}
          {uploadStatus === 'error' && '업로드 실패'}
        </p>
      </div>

      <ul aria-label="문서 목록">
        {visibleItems.map((item) => (
          <li key={item.path}>
            {item.type === 'DIRECTORY' ? (
              <button type="button" onClick={() => setCurrentPath(item.path)}>
                📁 {item.name}
              </button>
            ) : (
              <span>📄 {item.name}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
