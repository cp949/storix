import { DomainError } from '../common/domain-error.js';
import {
  resolveErrorCode,
  resolveErrorCurrent,
  resolveErrorMessage,
  resolveErrorPath,
} from '../common/domain-error.filter.js';
import type { VfsMutationReceiptEntity } from '../persistence/entities/vfs-mutation-receipt.entity.js';
import type {
  ReceiptIdentity,
  ReceiptResponse,
  VfsMutationReceiptRepository,
} from '../persistence/vfs-mutation-receipt.repository.js';
import { VfsNamespaceNotFoundError } from './vfs.errors.js';

// 조건부 mutation(JSON mutation, conditional content, snapshot)의 receipt 저장·재생 규칙.
// 세 서비스가 같은 분류기와 같은 재생 응답을 쓰도록 이 모듈 하나에 모은다.

/** claim을 소유한 요청이 오류 receipt를 확정할 때 필요한 식별값 */
export interface ErrorReceiptOwner {
  readonly identity: ReceiptIdentity;
  readonly generation: number;
  readonly fingerprint: string;
  readonly method: string;
  readonly requestBodyBytes?: number;
}

// 코드로 제외하는 오류:
// - MUTATION_IN_PROGRESS, MUTATION_KEY_REUSED: receipt 자체의 상태를 알리는 응답이다.
//   저장하면 진행 중이던 원래 요청이나 원래 receipt를 덮어쓴다.
// - NAMESPACE_NOT_FOUND: receipt가 namespace FK를 가지므로 namespace가 없으면 저장할 수 없다.
const NON_REPLAYABLE_CODES: ReadonlySet<string> = new Set([
  'MUTATION_IN_PROGRESS',
  'MUTATION_KEY_REUSED',
  'NAMESPACE_NOT_FOUND',
]);

/**
 * claim 뒤 요청 처리 중 발생한 오류를 receipt로 고정해 재생할지 판정한다.
 *
 * 저장 대상은 입력과 그 시점의 VFS 상태만으로 정해지는 결정적 4xx `DomainError`다.
 * 같은 key로 재시도하면 상태가 바뀌었더라도 최초 응답을 받아야 하므로 저장한다
 * (412, 404, 409, 428, 400 `VFS_INVALID_PATH`, 상한 초과 413 포함).
 *
 * 저장하지 않는 오류와 근거:
 * - `DomainError`가 아닌 예외(DB·Blob 장애, claim lost 등): 일시 장애라 재시도가 재평가해야 한다.
 * - 5xx: 서버 쪽 실패라 같은 이유로 재평가 대상이다.
 * - 401: 인증 결과는 요청 내용이 아니라 자격 증명에 달려 있다.
 * - `NON_REPLAYABLE_CODES`의 코드.
 *
 * fingerprint를 만들기 전에 끝나는 오류(body 한도 초과 413, Content-Length 오류 등)는
 * 호출부가 이 함수에 넘기지 않으므로 여기서 다루지 않는다.
 */
export function isReplayableMutationError(error: unknown): error is DomainError {
  if (!(error instanceof DomainError)) return false;
  if (error.status < 400 || error.status > 499 || error.status === 401) return false;
  return !NON_REPLAYABLE_CODES.has(error.code);
}

/** DomainError를 receipt에 저장·응답할 HTTP 결과로 바꾼다. body 규칙은 DomainErrorFilter와 같다. */
export function errorResponse(error: DomainError, requestId: string): ReceiptResponse {
  const path = resolveErrorPath(error);
  return {
    status: error.status,
    body: {
      code: resolveErrorCode(error, error.status),
      message: resolveErrorMessage(error, error.status),
      ...(path ? { path } : {}),
      ...resolveErrorCurrent(error),
      requestId,
    },
    headers: { 'x-request-id': requestId },
  };
}

/**
 * 롤백된 요청의 오류를 receipt로 확정하고 응답을 반환한다.
 *
 * 저장 대상이 아니면 오류를 그대로 다시 던진다(호출부가 claim을 해제한다).
 * 저장은 작업 트랜잭션이 롤백된 뒤 별도 트랜잭션에서 generation·lease로 fencing하며,
 * 응답은 저장이 끝난 뒤에만 반환한다. fencing 실패가 claim lost이고 namespace 삭제가
 * 확인되면 저장 불가한 404를 반환하며, 그 외에는 원래 완료 오류를 전파한다.
 */
export async function storeErrorReceipt(
  receipts: VfsMutationReceiptRepository,
  owner: ErrorReceiptOwner,
  error: unknown,
  requestId: string,
): Promise<ReceiptResponse> {
  if (!isReplayableMutationError(error)) throw error;
  const response = errorResponse(error, requestId);
  try {
    await receipts.completeAfterRollback(
      owner.identity,
      owner.generation,
      owner.fingerprint,
      owner.method,
      response,
      owner.requestBodyBytes,
    );
  } catch (completionError) {
    if (completionError instanceof Error && completionError.message === 'VFS mutation claim lost') {
      try {
        if (!(await receipts.namespaceExists(owner.identity.namespaceId))) {
          throw new VfsNamespaceNotFoundError(owner.identity.namespaceId);
        }
      } catch (namespaceError) {
        if (namespaceError instanceof VfsNamespaceNotFoundError) throw namespaceError;
      }
    }
    throw completionError;
  }
  return response;
}

/**
 * 완료 receipt를 재생한다. method나 fingerprint가 다르면 다른 요청에 key를 재사용한 것이다.
 * 재생 응답은 최초 status·body·헤더(`X-Request-Id` 포함)를 그대로 쓴다.
 */
export function replayReceipt(
  receipt: VfsMutationReceiptEntity,
  method: string,
  fingerprint: string,
  requestId: string,
): ReceiptResponse {
  if (receipt.method !== method || receipt.fingerprint !== fingerprint) {
    return {
      status: 409,
      body: { code: 'MUTATION_KEY_REUSED', message: '다른 요청에 사용한 mutation key', requestId },
      headers: { 'x-request-id': requestId },
    };
  }
  return {
    status: receipt.responseStatus as number,
    body: JSON.parse(receipt.responseBody as string) as unknown,
    headers: JSON.parse(receipt.responseHeaders as string) as Record<string, string>,
  };
}

/** 다른 요청이 claim을 소유 중일 때의 응답. receipt에 저장하지 않는다. */
export function busyResponse(retryAfterSeconds: number, requestId: string): ReceiptResponse {
  return {
    status: 409,
    body: { code: 'MUTATION_IN_PROGRESS', message: 'mutation 처리 중', requestId },
    headers: { 'retry-after': String(retryAfterSeconds), 'x-request-id': requestId },
  };
}
