FROM node:24.20.0-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @cp949/storix-demo1-was --docker

FROM base AS build
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @cp949/storix-demo1-was build

FROM base AS runtime
LABEL org.opencontainers.image.source="https://github.com/cp949/storix"
ENV NODE_ENV=production
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/demo1/was/dist ./apps/demo1/was/dist
EXPOSE 4000
CMD ["node", "apps/demo1/was/dist/main.js"]
