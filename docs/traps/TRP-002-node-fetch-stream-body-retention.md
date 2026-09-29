# TRP-002 Node 내장 fetch가 스트림 요청 본문을 요청이 끝날 때까지 보유한다

- 상태: ACTIVE
- 적용 조건: Node 24.20.0 내장 `fetch`(undici 7.29.0)에 `ReadableStream` 요청 본문(`duplex: 'half'`)을 넘겨 큰 파일을 업로드할 때.

## 오해하기 쉬운 신호

업로드가 성공하고 수신 서버가 본문을 읽지 않을 때의 백프레셔 테스트도 통과한다.
소스 스트림은 상한 이상 미리 읽히지 않으므로 스트리밍으로 보인다.
그러나 프로세스 메모리는 업로드 크기에 비례해 늘어난다.
`apps/demo1/was`에서 256 MiB 업로드의 `arrayBuffers` 피크가 286 MiB, RSS가 396 MiB였다.

## 원인

전송을 마친 청크를 fetch가 요청이 끝날 때까지 참조한다.
강제 GC를 20ms마다 실행해도 줄지 않으므로 회수 대기 중인 garbage가 아니라 살아 있는 참조다.
요청이 끝나면 한꺼번에 해제된다.
본문이 `Readable.toWeb(req)`, async iterable, 입력과 무관한 생성기 스트림이어도 같다.
undici 내부에서 참조를 잡는 위치는 확인하지 않았다.
undici 8.10.2의 `fetch`와 `request`는 같은 조건에서 보유하지 않았다.
내장 fetch에 undici 8의 `Agent`를 `dispatcher`로 주입하면 `invalid onRequestStart method`로 실패한다.

## 탐지/회피

- 탐지: 속도를 제한한 업로드(예: curl `--limit-rate 8M`) 동안 `process.memoryUsage().arrayBuffers`를 주기적으로 기록한다. 강제 GC 상태에서도 선형으로 늘면 이 함정이다.
- 회피: `undici` 8의 `fetch`를 쓴다. `apps/demo1/was`는 `storix-transport.ts`가 이 fetch를 노출한다.
- 회귀 검증: `storix-http.client.spec.ts`의 "전송을 마친 청크를 요청이 끝날 때까지 보유하지 않는다"가 강제 GC 뒤 `arrayBuffers`를 잰다.
- 이 조건이 사라졌는지는 Node가 번들 undici를 올릴 때 위 회귀 테스트를 내장 fetch로 실행해 확인한다.
- 남는 성분: 강제 GC가 없으면 다 쓴 Buffer가 GC 전까지 쌓여 cold 프로세스의 RSS가 크기와 무관한 상한까지 오른다. 이 성분은 보유가 아니다.
