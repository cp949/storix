# Storage env var·DI 토큰 접두어를 MinIO 전용에서 벤더중립 STORAGE_*로 전환한다

ADR 0012는 env 접두어를 `S3_*`/`STORAGE_*`로 바꾸는 안을 검토했지만, 클래스명·DI
토큰과의 불일치와 self-host 배포 이후 breaking change 우려로 보류했다. 이 ADR은
그 보류를 뒤집고 `STORAGE_*` 전환을 채택한다: 이 env var를 실제로 소비하는
배포가 아직 없어, 지금이 breaking change 비용이 가장 낮은 시점이다.

바꾸는 범위는 env var 11개(`STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_USE_SSL`,
`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_PATH_STYLE`,
`STORAGE_REGION`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_PUBLIC_PORT`,
`STORAGE_PUBLIC_USE_SSL`)와 대응 DI 토큰(`STORAGE_CLIENT`, `STORAGE_PUBLIC_CLIENT`,
`STORAGE_BUCKET`) 뿐이다. `MinioBlobStorage`/`MinioHealthIndicator` 클래스명과
파일명은 바꾸지 않는다 — minio-js `Client`를 직접 생성·타입으로 쓰는 구현부다.
ADR 0012는 클래스명·DI 토큰·env 접두어를 모두 MinIO 특정 이름으로 유지했으므로,
"구현체는 minio-js SDK, 설정·DI·인터페이스는 벤더중립"이라는 경계는 이 ADR이 새로
긋는 것이다 — 0012의 "어댑터 계층 없이 minio-js Client 하나" 결정 자체는 그대로
둔다. 하위호환 alias나 마이그레이션 가이드는 두지 않는다 — 실 배포가 없어
필요 없다.

## Considered Options

- **`S3_*` 접두어 사용**: S3 API 호환이라는 프로토콜 수준을 더 정확히 표현하지만,
  "S3"가 AWS 고유명사라 MinIO/VersityGW 사용자에게는 여전히 혼란을 줄 수 있어
  보류했다. 기존 `BlobStorage` 인터페이스 네이밍과의 일관성도 `STORAGE_*` 쪽이
  더 높다.
- **구버전 `MINIO_*` env var를 fallback으로 유지**: 이미 이 env var를 쓰는 배포가
  없으므로 하위호환 코드를 넣을 이유가 없어 보류했다. 나중에 실 배포가 생긴
  뒤에 접두어를 또 바꿔야 한다면 그때는 이런 fallback이 정당화된다.
- **ADR 0012를 직접 수정**: 이 리포의 ADR은 불변 로그로 취급한다(소급 편집
  사례 없음) — 결정이 바뀌면 새 ADR로 기록하는 이 ADR 자체가 그 컨벤션을
  따른다.

## Consequences

- `.env.example`/`docker-compose.yml`/배포 문서의 env var 이름이 전부 바뀐다.
  현재 이 값을 소비하는 실 배포가 없으므로 운영 영향은 없다.
- 앞으로 `MINIO_*` 접두어를 쓰는 새 env var를 추가하지 않는다 — storage 설정은
  전부 `STORAGE_*` 아래에 둔다.
