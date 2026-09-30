FROM node:24.20.0-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @cp949/storix-api --docker

FROM base AS build
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @cp949/storix-api build

FROM base AS runtime
LABEL org.opencontainers.image.source="https://github.com/cp949/storix"
ENV NODE_ENV=production
# Alpine 베이스를 쓰는 이유는 api ADR-0031.
# - 수정판이 나온 OS 패키지를 빌드 시점에 반영한다.
# - pg_dump/pg_restore는 대상 Postgres major(16)와 같은 client를 설치한다. 낮은 client는 버전 불일치로 실패한다.
# - runtime은 corepack의 pnpm만 쓴다. 쓰지 않는 번들 npm·yarn은 취약한 모듈을 포함하므로 지운다.
RUN apk upgrade --no-cache \
  && apk add --no-cache postgresql16-client \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/api/dist ./apps/api/dist
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
