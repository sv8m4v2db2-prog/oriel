# syntax=docker/dockerfile:1
#
# Oriel — image serveur (API + temps réel + client web).
#
#   docker build -t oriel .
#   docker run -d -p 3000:3000 -v oriel-data:/data oriel
#
# Étape 1 : installe uniquement les espaces de travail shared/server/web (jamais Electron) et
#           construit web/dist puis server/dist/server.cjs (fichier unique).
# Étape 2 : image finale minimale = Node + server.cjs + web/, utilisateur non-root, données dans /data.

ARG NODE_IMAGE=node:24-alpine

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# Manifestes d'abord (cache des dépendances). desktop/package.json est nécessaire pour que le
# lockfile corresponde aux espaces de travail déclarés, mais ses dépendances ne sont pas installées.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY desktop/package.json desktop/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=shared --workspace=server --workspace=web --include-workspace-root=false

COPY . .

RUN npm run build -w web \
 && npm run build -w server \
 && test -f server/dist/server.cjs \
 && test -f web/dist/index.html

# Artefacts à embarquer (+ licence si présente à la racine du dépôt).
RUN mkdir -p /out \
 && cp server/dist/server.cjs /out/server.cjs \
 && cp -R web/dist /out/web \
 && for f in LICENSE LICENSE.md LICENCE COPYING; do if [ -f "$f" ]; then cp "$f" /out/; fi; done

# ------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Oriel" \
      org.opencontainers.image.description="Espace de travail collaboratif open-source et auto-hébergeable" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=build --chown=root:root /out/ /app/

# L'utilisateur « node » (uid 1000) fourni par l'image officielle possède /data.
RUN mkdir -p /data && chown node:node /data
USER node

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server.cjs"]
