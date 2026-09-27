import { NamespaceInvalidTrashPolicyError } from '../namespace.errors.js';

export interface UpdateNamespaceTrashPolicyRequest {
  readonly enabled: boolean;
}

export function parseUpdateNamespaceTrashPolicyRequest(body: unknown): UpdateNamespaceTrashPolicyRequest {
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as Record<string, unknown>).enabled !== 'boolean'
  ) {
    throw new NamespaceInvalidTrashPolicyError();
  }
  return { enabled: (body as { enabled: boolean }).enabled };
}
