import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { copyEntry, createDirectory, listDocuments, moveEntry, removeEntry, searchDocuments, uploadDocument } from '../api/client';
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
  const [newFolderName, setNewFolderName] = useState('');
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

  async function handleCreateDirectory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) {
      return;
    }
    try {
      await createDirectory(user, joinPath(currentPath, name));
      setNewFolderName('');
      clearError();
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleMove(item: FileEntry) {
    const destination = window.prompt('이동할 대상 경로', item.path);
    if (!destination) {
      return;
    }
    try {
      await moveEntry(user, item.path, destination);
      clearError();
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleCopy(item: FileEntry) {
    const destination = window.prompt('복사할 대상 경로', item.path);
    if (!destination) {
      return;
    }
    try {
      await copyEntry(user, item.path, destination);
      clearError();
      await loadList(currentPath);
    } catch (cause) {
      reportError(cause);
    }
  }

  async function handleRemove(item: FileEntry) {
    if (!window.confirm(`${item.name}을(를) 삭제할까요?`)) {
      return;
    }
    try {
      await removeEntry(user, item.path, item.type === 'DIRECTORY');
      clearError();
      await loadList(currentPath);
    } catch (cause) {
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

      <form onSubmit={handleCreateDirectory}>
        <label>
          새 폴더 이름
          <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} />
        </label>
        <button type="submit">폴더 만들기</button>
      </form>

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
            <button type="button" onClick={() => handleMove(item)}>
              이동
            </button>
            <button type="button" onClick={() => handleCopy(item)}>
              복사
            </button>
            <button type="button" onClick={() => handleRemove(item)}>
              삭제
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
