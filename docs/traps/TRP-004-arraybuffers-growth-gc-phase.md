# TRP-004 GC 없이 잰 arrayBuffers 증가량은 힙 크기와 GC 위상에 따라 0~115 MiB로 흔들린다

- 상태: ACTIVE
- 적용 조건: `process.memoryUsage().arrayBuffers`의 업로드 전후 차이(피크 − baseline)로 "버퍼가 파트 크기 안팎에 머문다"를 단언할 때.

## 오해하기 쉬운 신호

`apps/api/test/storage/s3-blob-storage.integration-spec.ts`의 대용량 업로드 메모리 spec이 단독 실행에서는 매번 통과한다.
전체 통합 실행에서 1회 `growth.arrayBuffers` 121,634,356 byte로 상한 96 MiB를 넘었다(#10).
같은 spec 재실행과 전체 재실행은 모두 통과했다.
코드가 바뀌지 않았으므로 환경 노이즈로 보인다.

## 원인

측정값은 살아 있는 버퍼가 아니라 GC 전에 쌓인 garbage의 진폭이다.
확인한 사실:

- 단독 실행(힙 약 60 MiB)에서 증가량은 0 / 1.9 / 34 / 51 / 64 MiB로 나왔다. 피크 절댓값은 93.7 MiB로 같았고 baseline만 달랐다.
- baseline 직전에 `gc()`를 호출하고 살아 있는 객체 힙을 키우면 증가량이 커졌다. 힙 200 MiB에서 81~85 MiB, 400 MiB에서 115 MiB, 750 MiB에서 98 MiB였다. 이 중 115·98 MiB는 상한 96 MiB를 넘는다.
- 같은 조건에서 샘플마다 GC를 돌리면 증가량이 13.6~17.8 MiB로 힙 크기와 무관했다.
- 힙이 클수록 업로드 중 GC 횟수가 줄었다(힙 60 MiB에서 38회, 400 MiB에서 8~10회).

해석(미확인): 힙이 큰 프로세스에서는 V8의 external memory GC가 늦게 끝나서 그동안 다 쓴 파트 버퍼가 쌓인다.
실제 실패 당시의 GC 이벤트 로그는 없다.
전체 통합 실행의 높은 RSS(1.49 GB)와 같은 조건으로 추정할 뿐 일치를 입증하지 않았다.

## 탐지/회피

- 탐지: 같은 spec의 증가량이 실행마다 0에서 수십 MiB까지 달라진다. `before`와 `peak` 절댓값을 함께 기록하면 `peak`는 같고 `before`만 다르다.
- 회피: baseline 직전과 샘플링 지점마다 `gc()`를 먼저 호출한다. `--expose-gc` 없이 `v8.setFlagsFromString('--expose-gc')`와 `vm.runInNewContext('gc')`로 얻는다.
- 비용: 매 chunk(1 MiB)마다 돌리면 큰 힙에서 느리다. 파트 크기(16 MiB)에 해당하는 chunk 수마다 돌린다.
- 회귀 검증: 위 spec이 강제 GC 뒤 `arrayBuffers`를 잰다. 상한 96 MiB는 바꾸지 않았다.
- 남는 위험: 같은 spec의 `growth.rss`(상한 160 MiB)는 GC 강제와 무관하다. 힙 750 MiB 합성 조건에서 182 MiB가 관찰됐다. 실제 실행에서는 관찰되지 않았다.
