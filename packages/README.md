# packages/

워크스페이스 패키지용 디렉터리. CLI/SDK 구성은 아직 미정이다(의도적 미정 상태 —
`docs/ROADMAP.md`의 `MONO-06` 참고).

## 시크릿 어댑터

`SecretSource` 어댑터(`docs/design/15-secret-sources.md`)를 이미지로 배포하는 패키지다.
npm에 공개하지 않고 변형 이미지(`-bao`, `-aws`) 안에서만 쓴다.

| 디렉터리             | 패키지명                   | scheme   |
| -------------------- | -------------------------- | -------- |
| `secret-source-bao/` | `storix-secret-source-bao` | `bao`    |
| `secret-source-aws/` | `storix-secret-source-aws` | `aws-sm` |

- `pnpm-workspace.yaml`의 `!packages/secret-source-*`로 루트 workspace에서 제외한다. 패키지마다 독립 lockfile과
  `pnpm install --frozen-lockfile`로 설치해야 변형 이미지가 어댑터 의존성만 담는다.
- 각 패키지의 `Dockerfile`이 기준 이미지(`STORIX_BASE_IMAGE`) 위에 어댑터를 얹는다. 빌드 컨텍스트는 저장소 루트다.
