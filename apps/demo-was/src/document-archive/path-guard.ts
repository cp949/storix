import { DemoUser } from './demo-user.js';
import { DocumentPathEscapesRootError } from './document-archive.errors.js';

const ROOT_BY_USER: Record<DemoUser, string> = {
  alice: '/documents/alice',
  bob: '/documents/bob',
};

export function resolveInternalPath(user: DemoUser, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const segments = withLeadingSlash.split('/').filter((segment) => segment.length > 0);

  if (segments.includes('..') || segments.includes('.')) {
    throw new DocumentPathEscapesRootError(requestedPath);
  }

  const suffix = segments.length === 0 ? '' : `/${segments.join('/')}`;
  return `${ROOT_BY_USER[user]}${suffix}`;
}

export function resolveExternalPath(user: DemoUser, internalPath: string): string {
  const root = ROOT_BY_USER[user];
  if (internalPath === root) {
    return '/';
  }
  return internalPath.startsWith(`${root}/`) ? internalPath.slice(root.length) : internalPath;
}
