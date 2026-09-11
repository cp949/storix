import { useEffect, useState } from 'react';
import { listDocuments } from '../api/client';
import type { DemoUser, FileEntry } from '../api/types';

export interface FolderTreeProps {
  readonly user: DemoUser;
  readonly selectedPath: string;
  readonly onNavigate: (path: string) => void;
  readonly refreshKey: number;
}

export function FolderTree({ user, selectedPath, onNavigate, refreshKey }: FolderTreeProps) {
  return (
    <nav aria-label="폴더 트리">
      <TreeNode
        user={user}
        path="/"
        label="root"
        depth={0}
        selectedPath={selectedPath}
        onNavigate={onNavigate}
        refreshKey={refreshKey}
        defaultExpanded
      />
    </nav>
  );
}

interface TreeNodeProps {
  readonly user: DemoUser;
  readonly path: string;
  readonly label: string;
  readonly depth: number;
  readonly selectedPath: string;
  readonly onNavigate: (path: string) => void;
  readonly refreshKey: number;
  readonly defaultExpanded?: boolean;
}

function TreeNode({ user, path, label, depth, selectedPath, onNavigate, refreshKey, defaultExpanded }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded));
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    listDocuments(user, path)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setChildren(result.items.filter((item) => item.type === 'DIRECTORY'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, path, expanded, refreshKey]);

  return (
    <div>
      <div style={{ paddingLeft: depth * 12 }}>
        <button type="button" aria-label={`${label} ${expanded ? '접기' : '펼치기'}`} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" aria-current={path === selectedPath ? 'true' : undefined} onClick={() => onNavigate(path)}>
          📁 {label}
        </button>
      </div>
      {expanded &&
        (loading && children === null ? (
          <p style={{ paddingLeft: (depth + 1) * 12 }}>불러오는 중...</p>
        ) : (
          (children ?? []).map((child) => (
            <TreeNode
              key={child.path}
              user={user}
              path={child.path}
              label={child.name}
              depth={depth + 1}
              selectedPath={selectedPath}
              onNavigate={onNavigate}
              refreshKey={refreshKey}
            />
          ))
        ))}
    </div>
  );
}
