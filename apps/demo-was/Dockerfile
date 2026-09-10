FROM node:24.20.0-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @storix/demo-was --docker

FROM base AS build
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @storix/demo-was build

FROM base AS runtime
LABEL org.opencontainers.image.source="https://github.com/cp949/storix"
ENV NODE_ENV=production
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/demo-was/dist ./apps/demo-was/dist
EXPOSE 4000
CMD ["node", "apps/demo-was/dist/main.js"]
