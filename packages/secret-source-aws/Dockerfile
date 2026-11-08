# Storix 기준 이미지에 AWS Secrets Manager 어댑터를 얹는다. 빌드 컨텍스트는 저장소 루트다.
#   docker build -f packages/secret-source-aws/Dockerfile --build-arg STORIX_BASE_IMAGE=<기준 이미지> .
# 기준 이미지는 기본값을 두지 않는다. 지정하지 않으면 빌드가 실패한다.
ARG STORIX_BASE_IMAGE

FROM node:24.20.0-alpine AS adapter
RUN corepack enable
WORKDIR /opt/storix-secret-source-aws
COPY packages/secret-source-aws/package.json packages/secret-source-aws/pnpm-lock.yaml packages/secret-source-aws/pnpm-workspace.yaml packages/secret-source-aws/index.js packages/secret-source-aws/README.md ./
# 격리된 stage에서 lockfile대로 설치하고 tarball을 풀어 둔다. AWS SDK 의존성은 이 디렉터리의 node_modules에만 둔다.
RUN pnpm install --prod --frozen-lockfile \
  && pnpm pack --pack-destination /tmp \
  && mkdir -p package \
  && tar -xzf /tmp/storix-secret-source-aws-0.1.0.tgz -C package --strip-components=1

FROM ${STORIX_BASE_IMAGE} AS runtime
COPY --from=adapter /opt/storix-secret-source-aws /opt/storix-secret-source-aws
# 링크의 실제 경로(/opt/...)에서 노드 모듈 해석이 위로 올라가며 /opt/storix-secret-source-aws/node_modules를 찾는다.
RUN mkdir -p /repo/apps/api/node_modules \
  && ln -s /opt/storix-secret-source-aws/package /repo/apps/api/node_modules/storix-secret-source-aws
