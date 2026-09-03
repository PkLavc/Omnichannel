FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
RUN npm ci

COPY apps/gateway apps/gateway
RUN npm run prisma:generate -w @omnichannel/gateway \
    && npm run build -w @omnichannel/gateway

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway ./apps/gateway

WORKDIR /app/apps/gateway
USER node

CMD ["node", "dist/server.js"]
