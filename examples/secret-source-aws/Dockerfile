ARG STORIX_BASE_IMAGE

FROM node:24.20.0-alpine AS adapter
RUN corepack enable
WORKDIR /opt/storix-secret-source-aws-example
COPY examples/secret-source-aws/package.json ./
COPY examples/secret-source-aws/pnpm-lock.yaml ./
COPY examples/secret-source-aws/pnpm-workspace.yaml ./
COPY examples/secret-source-aws/index.js ./
COPY examples/secret-source-aws/README.md ./
RUN pnpm install --prod --frozen-lockfile \
  && pnpm pack --pack-destination /tmp \
  && mkdir -p package \
  && tar -xzf /tmp/storix-secret-source-aws-example-0.1.0.tgz -C package --strip-components=1

FROM ${STORIX_BASE_IMAGE} AS runtime
COPY --from=adapter /opt/storix-secret-source-aws-example /opt/storix-secret-source-aws-example
COPY docs/deployment/scenarios/aws-secrets-localstack/fixtures/verify-exit.mjs /opt/storix-secret-source-aws-example/verify-exit.mjs
RUN mkdir -p /repo/apps/api/node_modules \
  && ln -s /opt/storix-secret-source-aws-example/package /repo/apps/api/node_modules/storix-secret-source-aws-example
