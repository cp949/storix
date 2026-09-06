FROM node:24.20.0-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS pruner
COPY . .
RUN pnpm dlx turbo prune @storix/api --docker

FROM base AS build
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @storix/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/api/dist ./apps/api/dist
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
