# 메트릭/에러 리포팅은 공통 인터페이스 뒤에 Prometheus·Sentry 각 하나씩만 실구현한다

`OPS-01`은 메트릭과 에러 리포팅에 얇은 공통 인터페이스를 둔다.

| 인터페이스        | 기능              | 구현                      |
| ----------------- | ----------------- | ------------------------- |
| `MetricsRegistry` | counter/histogram | Prometheus(`prom-client`) |
| `ErrorReporter`   | report            | Sentry(`@sentry/node`)    |

provider를 교체하거나 추가해도 호출부를 유지하기 위한 구조다.

## 활성화와 노출

- Sentry 활성화는 DSN 설정 여부로 판단한다.
- `STORIX_SENTRY_DSN`(기존 표기 `SENTRY_DSN`)이 없으면 `ErrorReporter`는 no-op이다.
- 로드맵의 “활성화 목록 구조”는 provider별 설정 존재 여부로 충족한다.
- 별도 리스트 env var는 두지 않는다.
- `/metrics`는 `/health`와 같이 무인증으로 상시 노출한다.
- 메트릭 on/off 스위치는 두지 않는다.

## 캡처 지점과 데이터

- 채택 당시 HTTP 캡처 대상은 `domain-error.filter.ts`의 500 분기다.
- 후속 오류별 보고 정책은 api ADR-0022에서 결정한다.
- GC job 실패는 `gc-main.ts`의 catch에서 보고한다.
- 호출부는 `ErrorReporter.report()`를 사용한다.
- Sentry 구현체가 `@sentry/node`로 예외를 캡처한다.
- Sentry 초기화에 `sendDefaultPii: false`를 적용한다.

`STORAGE-03`의 “서명값 로그 노출 금지” 기준을 에러 리포팅에도 적용하기 위한 결정이다.
요청 헤더·바디·쿼리스트링은 보고 context에 포함하지 않는다.

## 메트릭 범위와 라벨

- GC는 단발성 프로세스라 Prometheus pull 모델과 맞지 않는다.
- GC는 메트릭 노출 대상에서 제외한다.
- GC의 기존 구조화 로그는 유지한다.
- HTTP 라벨은 `StructuredLoggingInterceptor`의 `operation`(`${ClassName}.${handlerName}`)을 재사용한다.
- namespaceId 같은 고카디널리티 라벨은 사용하지 않는다.

## Considered Options

- **`@sentry/nestjs` 자동 예외 캡처**
  - `SentryGlobalFilter`와 기존 전역 `DomainErrorFilter`의 등록 순서를 조정해야 한다.
  - 채택 당시 HTTP 캡처 지점은 500 분기 하나였다.
  - 자동계측 이점이 부족해 보류했다.
- **`sendDefaultPii: true`로 요청 데이터 전송**
  - presigned 서명이나 API key 헤더가 유출될 위험이 있어 보류했다.
- **`METRICS_PROVIDERS=prometheus,otel` 같은 활성화 리스트**
  - provider별 설정과 리스트를 동기화해야 한다.
  - 설정 항목이 늘어나므로 보류했다.
  - imgproxy처럼 개별 env var 존재 여부로 활성화한다.
- **Prometheus Pushgateway로 GC 결과 push**
  - 별도 인프라 컴포넌트가 필요하다.
  - “단순 self-host” 목표와 맞지 않아 보류했다.
- **`METRICS_ENABLED`로 `/metrics` on/off**
  - 무인증 로컬 pull 엔드포인트를 끌 요구가 부족하다고 판단했다.
  - 불필요한 옵션으로 보고 보류했다.
- **Prometheus와 OpenTelemetry 동시 구현**
  - OTel은 metrics/traces/logs를 다룬다.
  - 분산 트레이싱 설계로 범위가 확대돼 보류했다.
- **Compose에 Prometheus 컨테이너 추가**
  - 스크레이프는 표준 HTTP GET이다.
  - `STORAGE-03`의 nginx 샘플보다 재현 위험이 낮다고 판단했다.
  - 고객 인프라가 Prometheus를 보유한다고 가정해 보류했다.
