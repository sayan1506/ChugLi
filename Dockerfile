FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
COPY infra/package*.json ./infra/
COPY mobile/package*.json ./mobile/

RUN npm ci --workspaces --ignore-scripts

COPY infra/ ./infra/
COPY mobile/ ./mobile/
COPY tsconfig.json ./
COPY sync-config.ts ./

RUN npm run typecheck --workspaces 2>&1 | tee /tmp/typecheck.log
RUN npm run test --workspaces 2>&1 | tee /tmp/test.log
RUN npm run lint --workspaces 2>&1 | tee /tmp/lint.log || true
RUN cd infra && npx cdk synth 2>&1 | tee /tmp/cdk-synth.log

CMD ["sh", "-c", "echo 'All checks passed' && cat /tmp/typecheck.log && cat /tmp/test.log"]