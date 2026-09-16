FROM node:24.6.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check && pnpm prune --prod

FROM node:24.6.0-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data && chmod 700 /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/LICENSE /app/README.md ./
COPY --from=build --chown=node:node /app/vendor ./vendor
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
