# 메트릭/에러 리포팅은 공통 인터페이스 뒤에 Prometheus·Sentry 각 하나씩만 실구현한다

OPS-01은 `MetricsRegistry`(counter/histogram)와 `ErrorReporter`(report) 얇은
인터페이스를 도입해 향후 provider 교체·추가 시 호출부를 바꾸지 않도록 하되,
실제 구현체는 Prometheus(`prom-client`)와 Sentry(`@sentry/node`) 각각 하나씩만
붙인다. 활성화는 provider별 env var 존재 여부로 판단한다(`SENTRY_DSN` 미설정
시 `ErrorReporter`는 no-op) — 로드맵이 명시한 "활성화 목록 구조"는 별도 리스트
env var가 아니라 이 존재-기반 신호로 충족한다. 메트릭은 `/health`와 동일하게
`/metrics`를 무인증·상시 노출하며 별도 on/off 스위치를 두지 않는다. 에러
리포팅은 5xx(`domain-error.filter.ts`의 500 분기)와 GC job
실패(`gc-main.ts`의 catch)에서 `@sentry/node`를 직접 호출해 캡처하고,
`sendDefaultPii: false`로 요청 헤더·바디·쿼리스트링을 전송하지 않는다 — 직전
STORAGE-03 리뷰에서 반영한 "서명값 로그 노출 금지" 기준을 에러 리포팅에도
유지하기 위함이다. GC job은 단발성 프로세스라 Prometheus의 pull 모델과 맞지
않아 메트릭 노출 대상에서 제외하고, 기존 구조화 로그만 유지한다. HTTP
메트릭의 라벨은 `StructuredLoggingInterceptor`가 이미 쓰는
`operation`(`${ClassName}.${handlerName}`)을 재사용해 고카디널리티 라벨(예:
namespaceId)이 섞이지 않게 한다.

## Considered Options

- **`@sentry/nestjs` 전용 패키지로 자동 예외 캡처**: `SentryGlobalFilter`가
  기존 전역 `DomainErrorFilter`와 등록 순서를 다퉈야 하고, 캡처 지점이 이미
  500 분기 하나뿐이라 자동계측의 이점이 없어 보류했다.
- **Sentry 기본값(`sendDefaultPii: true`)으로 요청 헤더·쿼리스트링까지
  전송**: presigned 서명이나 API key 헤더가 그대로 새어나갈 위험이 있어
  보류했다.
- **`METRICS_PROVIDERS=prometheus,otel` 같은 명시적 콤마 리스트 env var로
  활성화 관리**: provider별 개별 설정과 리스트를 동기화해야 해 설정 항목이
  늘어나 보류했다(imgproxy의 개별 env var 존재-기반 활성화를 대신 채택).
- **Prometheus Pushgateway로 GC job(단발성 프로세스) 결과도 push**: self-host
  배포에 별도 인프라 컴포넌트가 추가되어 "단순 self-host" 목표와 맞지 않아
  보류했다.
- **`METRICS_ENABLED` 같은 boolean env var로 `/metrics` on/off**: 무인증
  로컬 pull 엔드포인트라 끌 이유가 약해 불필요한 옵션으로 보고 보류했다
  (`/health`와 동일하게 상시 노출).
- **Prometheus + OpenTelemetry 동시 실구현**: OTel은 metrics/traces/logs로
  범위가 커 이 티켓이 분산 트레이싱 설계로 번지므로 보류했다.
- **`docker-compose.yml`에 Prometheus 컨테이너 추가**: STORAGE-03의 nginx
  샘플과 달리 Prometheus 스크레이프는 표준 HTTP GET이라 재현 위험이 낮고,
  고객 인프라가 이미 Prometheus를 보유한다고 가정할 수 있어 보류했다.
