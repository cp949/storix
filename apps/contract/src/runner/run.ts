import type { Contract, ContractContext } from '../define-contract.ts';

/** 계약 하나의 실행 결과. */
export interface ContractResult {
  readonly id: string;
  readonly rq: readonly string[];
  readonly passed: boolean;
  readonly durationMs: number;

  /** 실패했을 때의 오류 메시지 */
  readonly error?: string;
}

/** 계약을 실행하고 예외를 결과로 바꾼다. 한 계약의 실패가 다음 계약 실행을 막지 않는다. */
export async function runContract(contract: Contract, ctx: ContractContext): Promise<ContractResult> {
  const startedAt = performance.now();
  try {
    await contract.run(ctx);
    return {
      id: contract.id,
      rq: contract.rq,
      passed: true,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      id: contract.id,
      rq: contract.rq,
      passed: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 결과를 집계한다. 실패가 있거나 실행한 계약이 없으면 종료 코드는 1이다. */
export function summarize(results: readonly ContractResult[]): {
  passed: number;
  failed: number;
  exitCode: 0 | 1;
} {
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  return { passed, failed, exitCode: failed === 0 && results.length > 0 ? 0 : 1 };
}
