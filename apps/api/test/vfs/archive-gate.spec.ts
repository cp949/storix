// 단일 프로세스 gate의 즉시 획득·거부와 중복 release를 검증한다.
import { ArchiveGate } from '../../src/vfs/archive-gate.js';

// 입력과 호출 순서를 고정해 허용·거부 계약을 재현한다.
describe('ArchiveGate 실행 슬롯 제한', () => {
  it('한도를 넘은 동시 요청은 대기하지 않고 거부한다', () => {
    const gate = new ArchiveGate(1);
    const first = gate.tryAcquire();
    expect(first).not.toBeNull();
    expect(gate.tryAcquire()).toBeNull();
    first?.release();
  });

  it('동일 tick의 동시 요청은 설정 한도만 획득한다', () => {
    const gate = new ArchiveGate(2);
    const leases = Array.from({ length: 3 }, () => gate.tryAcquire());
    expect(leases.filter(Boolean)).toHaveLength(2);
  });

  it('release를 반복해도 슬롯을 한 번만 반환한다', () => {
    const gate = new ArchiveGate(1);
    const lease = gate.tryAcquire();
    lease?.release();
    lease?.release();
    expect(gate.tryAcquire()).not.toBeNull();
  });
});
