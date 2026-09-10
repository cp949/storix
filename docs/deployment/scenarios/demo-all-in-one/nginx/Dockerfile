FROM node:24.20.0-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @storix/demo1-web --docker

FROM base AS build
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @storix/demo1-web build

FROM nginx:1.29-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/cp949/storix"
COPY docs/deployment/scenarios/demo-all-in-one/nginx/00-log-formats.conf /etc/nginx/conf.d/00-log-formats.conf
COPY docs/deployment/scenarios/demo-all-in-one/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/demo1/web/dist /usr/share/nginx/html
EXPOSE 80
