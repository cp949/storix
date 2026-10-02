/**
 * GC 단계 실행 보조. 단계마다 한 실행의 작업량 예산(`GcStageBudget`)을 두고, 예산이 소진되면 재개 위치를
 * `gc_cursor`에 저장해 다음 실행이 이어가게 한다. 규칙은 docs/design/08-namespace-change-feed.md "보존 정리".
 */
import type { Logger } from '@nestjs/common';
import type { GcCursorRepository } from '../persistence/gc-cursor.repository.js';
import { GcStageBudget } from './gc-budget.js';

export interface GcStageContext {
  /** 단계 하나의 예산(`STORIX_GC_MAX_ROWS_PER_STAGE`) */
  readonly budgetLimit: number;
  readonly cursors?: GcCursorRepository;
  readonly logger: Logger;
}

/**
 * 단계 하나를 cursor로 이어 돌린다. 예산이 소진되면 cursor를 저장해 다음 실행이 이어가고, 끝까지 돌았으면
 * 저장된 cursor를 지워 다음 실행이 처음부터 다시 돈다(cursor 앞에서 뒤늦게 대상이 된 행, 실패한 삭제 재시도).
 * `step`은 cursor 뒤의 한 page를 처리하고 다음 위치(없으면 null)와 읽은 행 수를 돌려준다.
 */
export async function runCursorStage<C>(
  context: GcStageContext,
  stage: string,
  exhaustedStages: string[],
  parse: (raw: unknown) => C | null,
  step: (cursor: C | null) => Promise<{ next: C | null; examined: number }>,
): Promise<void> {
  const budget = new GcStageBudget(context.budgetLimit);
  let cursor: C | null = await readCursor(context, stage, parse);
  while (true) {
    const result: { next: C | null; examined: number } = await step(cursor);
    budget.consume(result.examined);
    cursor = result.next;
    if (cursor === null) {
      await context.cursors?.clear(stage);
      return;
    }
    if (budget.exhausted) {
      await context.cursors?.write(stage, JSON.stringify(cursor));
      exhaustedStages.push(stage);
      context.logger.warn(`GC 단계 ${stage}: 예산(${budget.limit}행) 소진 — 다음 실행에서 이어간다`);
      return;
    }
  }
}

/**
 * 처리한 행이 후보 집합에서 빠지는 단계(재개 위치가 필요 없다)를 예산 안에서 반복한다.
 * `step`은 한 batch를 처리하고 처리한 행 수와 후보가 더 없는지(`done`)를 돌려준다.
 * `done`이 false인데 예산이 소진되면 남은 작업을 다음 실행으로 넘기고 단계를 보고한다.
 */
export async function runBudgetedStage(
  context: GcStageContext,
  stage: string,
  exhaustedStages: string[],
  step: () => Promise<{ done: boolean; examined: number }>,
): Promise<void> {
  const budget = new GcStageBudget(context.budgetLimit);
  while (true) {
    const result = await step();
    budget.consume(result.examined);
    if (result.done) return;
    if (budget.exhausted) {
      exhaustedStages.push(stage);
      context.logger.warn(`GC 단계 ${stage}: 예산(${budget.limit}행) 소진 — 다음 실행에서 이어간다`);
      return;
    }
  }
}

async function readCursor<C>(
  context: GcStageContext,
  stage: string,
  parse: (raw: unknown) => C | null,
): Promise<C | null> {
  const stored = await context.cursors?.read(stage);
  if (!stored) return null;
  try {
    const parsed = parse(JSON.parse(stored));
    if (parsed !== null) return parsed;
  } catch {
    // 아래에서 처음부터 다시 시작한다.
  }
  context.logger.warn(`GC 단계 ${stage}: 저장된 cursor를 읽을 수 없어 처음부터 다시 시작한다`);
  return null;
}
