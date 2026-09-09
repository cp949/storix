# 개발용 mTLS 인증서

`generate-development-certificates.sh`는 로컬 개발과 검증에만 사용하는 CA, Nginx
server 인증서, WAS client 인증서를 만든다. 기본 출력 디렉터리 `generated/`는
gitignore 대상이다.

```bash
./generate-development-certificates.sh
```

| 파일 | 배포 대상 | 용도 |
| --- | --- | --- |
| `ca.crt` | Nginx, WAS | 개발 CA 신뢰 anchor |
| `server.crt`, `server.key` | Nginx | `storix.internal` server 인증 |
| `was-client.crt`, `was-client.key` | WAS | Nginx에 WAS 신원 증명 |

CA 개인키 `ca.key`는 인증서 발급에만 사용한다. WAS나 Nginx runtime에 배포하지
않는다. 스크립트는 기존 출력물을 덮어쓰지 않으므로 다시 생성하려면 이전
`generated/`를 안전한 위치로 옮긴 뒤 실행한다.

운영에서는 이 개발 CA와 인증서를 사용하지 않는다. 회사 내부 PKI에서
`storix.internal` serverAuth 인증서와 WAS clientAuth 인증서를 발급하고, Nginx에는
WAS 인증서 발급 CA만 배포한다.
