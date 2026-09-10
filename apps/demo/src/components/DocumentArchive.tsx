import { useCallback, useEffect, useState } from 'react';
import { listDocuments, searchDocuments } from '../api/client';
import type { DemoUser, FileEntry } from '../api/types';
import { useErrorReporter } from '../error/ErrorContext';

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
