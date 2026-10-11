// 장시간 mutation receipt lease를 갱신하는 공통 helper다.
import {
  mutationLeaseSeconds,
  type ReceiptIdentity,
  type VfsMutationReceiptRepository,
} from '../persistence/vfs-mutation-receipt.repository.js';

/** 긴 mutation 동안 receipt owner lease를 갱신하고 소유권 상실을 추적한다. */
export function startLeaseRenewal(
  receipts: VfsMutationReceiptRepository,
  identity: ReceiptIdentity,
  generation: number,
) {
  let lost = false;
  let renewal: Promise<void> | null = null;
  const timer = setInterval(
    () => {
      if (renewal) return;
      renewal = receipts
        .renew(identity, generation)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          renewal = null;
        });
    },
    Math.max(250, Math.floor((mutationLeaseSeconds() * 1000) / 3)),
  );
  timer.unref();
  return {
    get lost() {
      return lost;
    },
    async stop() {
      clearInterval(timer);
      if (renewal) await renewal;
    },
  };
}
