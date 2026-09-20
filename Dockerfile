# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.docker.json package-lock.docker.json ./
RUN mv package.docker.json package.json && mv package-lock.docker.json package-lock.json
RUN --mount=type=secret,id=npm_ca,required=false \
    export ONNXRUNTIME_NODE_INSTALL=skip; \
    if [ -s /run/secrets/npm_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci; \
    else \
      npm ci; \
    fi
COPY . .
RUN npm run build && npm run check

FROM build AS verify

FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts --offline

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DATA_DIR=/data
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3100
CMD ["node", "server/index.mjs"]
