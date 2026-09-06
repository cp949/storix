import { NamespaceInvalidNameError } from '../namespace.errors.js';

const NAMESPACE_NAME_PATTERN = /^[a-z0-9_-]{1,128}$/;

export interface CreateNamespaceRequest {
  readonly name: string;
}

export function parseCreateNamespaceRequest(body: unknown): CreateNamespaceRequest {
  const name = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).name : undefined;

  if (typeof name !== 'string' || !NAMESPACE_NAME_PATTERN.test(name)) {
    throw new NamespaceInvalidNameError(name);
  }

  return { name };
}
