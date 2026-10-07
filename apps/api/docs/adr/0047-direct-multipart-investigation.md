# 직접 multipart는 전환 후보로 유지하고 검증된 바이트와 저장소 작업 종료를 분리한다

## 상태

조사 완료. 2026-10-08.
현행 재개 업로드 구현과 api ADR-0026을 유지한다.
직접 multipart 전환은 아래 조건을 구현·검증하는 별도 작업에서 수행한다.

## 배경

기존 재개 업로드는 staging 객체를 읽어 최종 Blob을 다시 쓴다.
최종 저장도 큰 stream에는 SDK multipart를 사용한다.
VersityGW POSIX는 multipart 조각을 최종 임시 파일로 복사한 뒤 공개한다.
따라서 기본 16 MiB 조각과 대용량 신규 파일에서는 staging, 최종 MPU 조각, 최종 임시 파일이 함께 존재할 수 있다.

직접 multipart는 API의 최종 재쓰기와 별도 staging 객체를 제거할 수 있다.
gateway의 내부 조립 복사와 전체 평문 SHA-256 검증 읽기는 남는다.
완료 시간이 파일 크기와 무관해진다는 주장은 채택하지 않는다.

## 조사 결과

검증 환경은 VersityGW v1.8.0 POSIX 단일 gateway, 로컬 ext4, AWS SDK 3.1146.0이다.
기존 경로는 실제 `ContentIngressService`와 `S3BlobStorage`를 사용했다.
직접 경로는 조사용 S3 실행 코드와 SQLite 상태 모델을 사용했다.
제품 HTTP API·repository·GC·restore 통합 증거는 아니다.

- PLAIN·ENCRYPTED의 1 GiB·5 GB 비교에서 API→gateway 데이터 본문 쓰기는 2F에서 F로 감소했다.
- 두 경로의 완료 검증 읽기는 F다.
- 관측 최대 데이터 저장 공간은 약 3F에서 약 2F로 감소했다.
- 크기, 각 조각의 평문 digest, 전체 평문 SHA-256, 조각 경계를 가로지르는 Range 복호화를 검증했다.
- 최대 공간은 20 ms filesystem·gateway fd 표본이다. 열린 O_TMPFILE도 포함한다. 원자적인 절대 최대 공간 증거는 아니다.
- 각 조합은 단일 표본이다. cold cache 통제나 성능 분포 검증은 아니다.
- 완료된 ciphertext와 IV·digest metadata의 복원 후 평문·Range를 검증했다.
- 정상 gateway 재시작 후 MPU 조회·추가 조각 저장을 검증했다.
- 조각 없는 파일과 마지막 조각의 5 MiB 미만 크기는 별도 처리할 수 있다. 고정 16 MiB는 비마지막 조각의 최소 크기와 CTR 블록 정렬을 만족한다.

VersityGW v1.8.0에서 다음 경합을 재현했다.

- 첫 Complete 조립 중 중복 Complete는 200을 반환했다. 직후 HEAD는 404였다. 원래 요청이 끝난 뒤 최종 바이트를 검증했다.
- Complete와 겹친 늦은 동일 ciphertext UploadPart는 성공했다. 최종 바이트는 유지됐다.
- 늦은 PUT가 남긴 16 MiB 조각은 ListMultipartUploads에 나타나지 않았다.
- 모든 해당 전송의 정착을 확인한 뒤 알려진 key/uploadId로 abort했다. 전용 POSIX 경로에서 잔여 조각 제거를 확인했다.
- 실제 HTTP 완료 응답을 프록시에서 끊으면 소비자는 오류를 받았다. 후보 바이트가 정상이어도 결과 불명 작업의 quota 반환을 보류했다.

## 결정

PLAIN·ENCRYPTED 모두 자원 절감의 전환 후보로 유지한다.
현행 구현의 계약과 동작을 조사용 코드로 대체하지 않는다.
api ADR-0026의 완료 규칙 개정은 제품 전환 구현과 검증을 함께 수행할 때 반영한다.

전환 설계의 기준:

- 소비자가 없어 호환성 유지 제약을 두지 않는다.
- 조각 크기는 16 MiB로 고정한다. S3 최대 10,000 parts도 생성 전에 검사한다.
- 암호화 전에 전체 조각의 크기와 평문 SHA-256을 검증한다.
- session/index의 digest binding을 storage 호출 전에 DB에 확정한다.
- binding은 전송 실패·lease 만료·정리에도 유지한다. 다른 내용의 재시도는 새 세션을 요구한다.
- ENCRYPTED는 세션별 IV와 조각 offset의 연속 AES-CTR을 사용한다. 같은 index 재시도는 같은 평문·ciphertext만 허용한다.
- plaintext buffer admission은 프로세스당 4개다. 포화 요청은 할당·quota 예약 전에 429와 전용 코드로 거절한다.
- 64 MiB는 plaintext buffer 예산이다. ciphertext·SDK·HTTP·임시 할당과 전체 RSS 예산은 별도로 검증한다.
- 슬롯은 storage 작업이 실제 정착한 뒤 반환한다. 요청 종료·deadline·lease 만료를 종료 근거로 쓰지 않는다.
- 완료는 동기 요청으로 유지한다.
- 후보 key, uploadId, storage generation, IV, accepted ETags, 검증 단계와 결과를 durable 상태로 보존한다.
- Complete 응답만으로 후보 바이트가 완성됐다고 판단하지 않는다.
- 조립 후보를 한 번 읽으며 각 조각의 bound 크기·digest와 전체 평문 SHA-256을 검증한다.
- 경로 조건·논리 quota·Blob·Node·revision·완료 receipt를 DB 트랜잭션에서 공개한다.
- 완료 실패는 같은 후보 객체를 검증해 복구한다. 결과 불명 storage 작업의 종료를 추정하지 않는다.

## 저장소 소유권과 quota

검증된 후보 바이트와 정착된 storage 작업은 별도 조건이다.
정상 바이트를 읽었다는 사실은 늦은 PUT나 Complete worker가 끝났다는 증거가 아니다.

- 활성 세션, in-flight UploadPart와 Complete, 결과 불명 시도를 GC에서 보호한다.
- 같은 ciphertext binding만으로 storage worker 종료나 잔여 조각 삭제를 판정하지 않는다.
- Complete 시작 전에 등록한 조각 전송의 정착을 확인한다.
- transport 오류·기록 저장 실패는 결과 불명 상태로 보존한다.
- 원래 worker가 정착하지 않은 상태에서 같은 내용의 재전송이 성공해도 원래 작업의 정착으로 간주하지 않는다.
- ListMultipartUploads 부재와 NoSuchUpload를 단독 회수·정산 근거로 쓰지 않는다.
- 정착 확인 후에도 durable key/uploadId를 기준으로 잔여 정리를 수행한다.
- 현행 api ADR-0045의 PUT 단위 소유권을 직접 세션 MPU의 수명에 맞게 확장해야 한다.
- quota는 조각별 논리 바이트다. 조립된 미공개 후보도 포함한다. gateway 조립 중 물리 사본의 상한을 보장하지 않는다.
- 공개 완료와 잔여 작업·조각의 안전 조건을 함께 확인한 뒤 quota를 반환한다.
- 종료를 확인할 수 없는 작업은 보호·정산 보류를 유지한다. 시간 경과로 해제하지 않는다.

## 재시작과 백업 복원

- 정상 API·gateway 재시작은 durable 세션과 MPU를 재개한다.
- 결과 불명 작업이 남은 재시작은 정상 종료 후 재시작과 구분한다. 보류 상태를 자동 종료 확인하지 않는다.
- 재해 백업·복원은 완료 Blob과 암호화 metadata를 보장한다.
- 미완료 MPU 조각은 기존 object list/get 백업에 포함되지 않는다.
- 복원한 미완료 세션은 명시적으로 종결한다. 이전 MPU를 활성 세션으로 계속 표시하지 않는다.
- 미완료 종결은 잔여 작업 종료·storage 정리·quota 정산을 대신하지 않는다.

## 대안과 한계

- 조각별 독립 IV·암호화 형식은 Blob metadata와 전체·Range 읽기 변경이 필요하다. 우선 연속 CTR과 사전 검증을 선택한다.
- 로컬 임시 파일 검증은 전체 파일 합계 F의 추가 로컬 쓰기·읽기가 필요하다. 고정 조각 크기와 bounded buffer를 선택한다.
- 세션 생성 시 전체 크기 예약은 도착하지 않은 조각도 quota를 점유한다. 조각별 admission을 선택한다.
- 비동기 완료 worker·claim 회수·drain은 이번 전환 후보에 포함하지 않는다.
- 실제 7일 경과는 검증하지 않았다. disk metadata, 정상 재시작, 단축 만료 모델을 실제 7일 보존 증거로 대체하지 않는다.
- 제품 DB 원자성, 제품 HTTP admission, 실제 GC·restore 통합, 다중 API·gateway, NAS·다른 filesystem·AWS 실제 환경은 검증하지 않았다.
- 조사 상태 모델은 제품의 worker 정착 증거를 제공하지 않는다. 프록시의 upstream 종료 관측도 운영 환경에 자동 존재한다고 가정하지 않는다.

## 근거

- [GitHub 이슈 #47](https://github.com/cp949/storix/issues/47): 합의 범위, 실측 결과와 재실행 기록.
- [VersityGW v1.8.0 POSIX 고정 소스](https://github.com/versity/versitygw/blob/fd04bc1df2656298577b82667a4195c77f8c7563/backend/posix/posix.go): CompleteMultipartUploadWithCopy, UploadPart, ListMultipartUploads.
- [VersityGW tmpfile 공개](https://github.com/versity/versitygw/blob/fd04bc1df2656298577b82667a4195c77f8c7563/backend/posix/with_otmpfile.go): tmpfile.link, linkatOTmpfile.
- [AWS SDK Upload 고정 소스](https://github.com/aws/aws-sdk-js-v3/blob/054298b1520fc45a7017966674a5ac3aa6f32a04/lib/lib-storage/src/Upload.ts): 단일 PUT와 MPU 분기.
- [NIST SP 800-38A](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38a.pdf): CTR counter 유일성 조건.
- [AWS multipart 제한](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html): part 크기·개수 제한.
