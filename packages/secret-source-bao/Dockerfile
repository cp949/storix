# Storix 기준 이미지에 bao 시크릿 어댑터를 얹는다. 빌드 컨텍스트는 저장소 루트다.
#   docker build -f packages/secret-source-bao/Dockerfile --build-arg STORIX_BASE_IMAGE=<기준 이미지> .
# 기준 이미지는 기본값을 두지 않는다. 지정하지 않으면 빌드가 실패한다.
ARG STORIX_BASE_IMAGE

FROM ${STORIX_BASE_IMAGE} AS runtime
# npm 의존성이 없는 어댑터라 소스만 복사한다. Storix가 /repo/apps/api/node_modules에서 찾는다.
COPY packages/secret-source-bao/package.json packages/secret-source-bao/index.js /repo/apps/api/node_modules/storix-secret-source-bao/
COPY packages/secret-source-bao/src /repo/apps/api/node_modules/storix-secret-source-bao/src
