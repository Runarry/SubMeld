FROM node:24.6.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm cores:prepare && pnpm prune --prod

FROM node:24.6.0-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir /data && chown node:node /data && chmod 700 /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/LICENSE /app/README.md ./
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
