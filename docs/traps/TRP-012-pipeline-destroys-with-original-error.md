# TRP-012 Node pipeline은 원래 오류로 모든 stream을 destroy해 콜백의 오류 번역이 무시된다

- 상태: ACTIVE
- 적용 조건: 여러 stream을 `pipeline`으로 묶고 상류의 오류(zlib, 저장소)를 공개 오류로 번역해 마지막 stream의 소비자에게 줄 때

## 오해하기 쉬운 신호

`pipeline` 콜백에서 `out.destroy(translated)`를 부르면 번역된 오류가 소비자에게 가는 것처럼 보인다.
소비자 쪽 테스트가 "오류가 났다"만 확인하면 원래 오류가 나가도 통과한다.
zlib의 `Z_DATA_ERROR`가 그대로 새면 400이 아니라 500이 된다.

## 원인

- `pipeline`은 한 stream이 실패하면 콜백보다 먼저 마지막 stream을 포함한 모든 stream을 원래 오류로 destroy한다.
- 이미 destroyed인 stream에 뒤따르는 `destroy(translated)`는 무시된다.
- 잘린 입력을 압축 해제기가 손상 데이터로 먼저 판정하면, 저장소의 짧은 응답도 데이터 오류로 분류된다.

## 탐지/회피

- 마지막 stream의 `destroy(error, callback)` 옵션 안에서 `callback(translate(error))`로 번역한다. 상류 stream을 모두 destroy하고 close를 기다린 뒤 callback을 부르면 소비자의 close 이벤트가 상류 정리 뒤에 온다.
- 상류에 길이 가드 Transform을 둔다. 입력이 선언 크기와 다르게 끝나면 일반 오류로 실패시켜 압축 해제기가 손상으로 오분류하기 전에 끝낸다.
- 회귀 검증: `apps/api/test/vfs/zip-reader.spec.ts`의 DEFLATE 손상·짧은 range 응답·destroy 전파 테스트와 `apps/api/test/vfs/extract.service.spec.ts`의 gzip 무결성 테스트.
