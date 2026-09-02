# 单容器源码构建镜像。
# 构建过程使用内部多阶段，不生成独立的组件镜像；最终只输出 memory-stack。

# -----------------------------------------------------------------------------
# 通用构建环境
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build-base

ARG ALPINE_MIRROR=mirrors.tencent.com/alpine
ARG NPM_REGISTRY=https://mirrors.tencent.com/npm/
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#https://${ALPINE_MIRROR}#g" /etc/apk/repositories && \
    apk add --no-cache \
      python3 make g++ git curl ca-certificates libc6-compat
RUN npm config set registry "$NPM_REGISTRY"

# -----------------------------------------------------------------------------
# Memory Core
# -----------------------------------------------------------------------------
FROM build-base AS core-build
WORKDIR /build/core
COPY MemoryCore/package.json ./
RUN node -e " \
      const fs=require('fs'); \
      const p=JSON.parse(fs.readFileSync('package.json','utf8')); \
      delete p.peerDependencies; \
      delete p.peerDependenciesMeta; \
      p.overrides=Object.assign({},p.overrides,{ '@jimp/config-typescript':'npm:dotenv@latest' }); \
      fs.writeFileSync('package.json',JSON.stringify(p,null,2)); \
    "
RUN --mount=type=cache,id=core-npm-cache,target=/root/.npm \
    npm install --omit=dev --omit=optional --ignore-scripts --legacy-peer-deps --no-audit --no-fund
RUN --mount=type=cache,id=core-npm-cache,target=/root/.npm \
    npm install --no-save --ignore-scripts --no-audit --no-fund esbuild
COPY MemoryCore/ ./

# -----------------------------------------------------------------------------
# Memory Proxy
# -----------------------------------------------------------------------------
FROM build-base AS proxy-build
WORKDIR /build/proxy
COPY MemoryProxy/package.json MemoryProxy/package-lock.json ./
RUN sed -i "s#https://registry.npmjs.org/#${NPM_REGISTRY}#g" package-lock.json
RUN --mount=type=cache,id=proxy-npm-cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund
COPY MemoryProxy/ ./

# -----------------------------------------------------------------------------
# Panel UI
# -----------------------------------------------------------------------------
FROM build-base AS panel-ui-build
WORKDIR /build/panel-web
COPY MemoryPanel/web/package.json MemoryPanel/web/package-lock.json ./
RUN --mount=type=cache,id=panel-web-npm-cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund
COPY MemoryPanel/web/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# Panel API
# -----------------------------------------------------------------------------
FROM build-base AS panel-build
WORKDIR /build/panel
COPY MemoryPanel/package.json MemoryPanel/package-lock.json ./
RUN --mount=type=cache,id=panel-npm-cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund
COPY MemoryPanel/ ./
COPY --from=panel-ui-build /build/panel-web/dist ./web/dist
RUN npm run build

# -----------------------------------------------------------------------------
# Knowledge
# -----------------------------------------------------------------------------
FROM build-base AS knowledge-build
WORKDIR /build/knowledge
COPY MemoryKnowledge/package.json ./
RUN --mount=type=cache,id=knowledge-npm-cache,target=/root/.npm \
    npm install --legacy-peer-deps --no-audit --no-fund
COPY MemoryKnowledge/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# 最终运行镜像：Core、Panel、Knowledge、Proxy 共用一个容器
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ARG ALPINE_MIRROR=mirrors.tencent.com/alpine
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#https://${ALPINE_MIRROR}#g" /etc/apk/repositories && \
    apk add --no-cache git curl tini ca-certificates libc6-compat libstdc++

WORKDIR /app
COPY --from=core-build /build/core /app
COPY --from=panel-build /build/panel/dist /opt/tdai/panel/dist
COPY --from=panel-build /build/panel/node_modules /opt/tdai/panel/node_modules
COPY --from=panel-build /build/panel/package.json /opt/tdai/panel/package.json
COPY --from=panel-build /build/panel/web/dist /opt/tdai/panel/web/dist
COPY --from=knowledge-build /build/knowledge/dist /opt/tdai/knowledge/dist
COPY --from=knowledge-build /build/knowledge/node_modules /opt/tdai/knowledge/node_modules
COPY --from=knowledge-build /build/knowledge/package.json /opt/tdai/knowledge/package.json
COPY --from=knowledge-build /build/knowledge/openapi.yaml /opt/tdai/knowledge/openapi.yaml
COPY --from=proxy-build /build/proxy /opt/tdai/proxy
COPY deploy/local-source-docker/start-unified.mjs /usr/local/bin/start-unified.mjs

RUN mkdir -p /data/config /data/knowledge /data/tdai-memory-proxy /opt/tdai/panel/config

ENV NODE_ENV=production \
    TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml \
    TDAI_GATEWAY_HOST=0.0.0.0 \
    TDAI_DATA_DIR=/data/tdai-memory \
    PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db

EXPOSE 8420 8125 8424 8096

HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
    CMD curl -fsS http://127.0.0.1:8420/health >/dev/null && \
        curl -fsS http://127.0.0.1:8424/health >/dev/null && \
        curl -fsS http://127.0.0.1:8125/health >/dev/null && \
        curl -fsS http://127.0.0.1:8096/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/usr/local/bin/start-unified.mjs"]
