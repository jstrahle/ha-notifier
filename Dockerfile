# syntax=docker/dockerfile:1
#
# Alpine-based image. Alpine works here because the server has NO native addons:
# password hashing uses Node's built-in scrypt (not argon2) and SMS talks to
# Twilio's REST API over fetch (not the SDK). No compiler, no musl/glibc build
# differences, small multi-arch image.
#
# Note: there is deliberately no HEALTHCHECK instruction. Podman builds OCI-format
# images by default, and HEALTHCHECK is a Docker-format extension that Podman
# silently ignores ("HEALTHCHECK is not supported for OCI image format"). The
# health check is defined in deploy/compose.yaml instead, where both Podman and
# Docker honour it.

# ---- Stage 1: build the PWA ----
FROM node:22-alpine AS pwa
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /pwa
COPY apps/pwa/package.json apps/pwa/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/pwa/ ./
RUN npm run build

# ---- Stage 2: build the server ----
FROM node:22-alpine AS server-build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /srv
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/server/ ./
RUN npm run build

# ---- Stage 3: production dependencies only ----
FROM node:22-alpine AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /srv
COPY apps/server/package.json apps/server/package-lock.json ./
# `npm cache clean --force` would print "using --force / Recommended protections
# disabled". Removing the cache directory outright is equivalent and quiet.
RUN npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm

# ---- Stage 4: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# Quiet hours are evaluated in the container's local time, so the timezone must
# be real. Override TZ in .env with an IANA name, e.g. Europe/Helsinki.
ENV TZ=UTC
# tzdata provides the zone database that TZ resolves against.
# `wget` is already provided by BusyBox in Alpine, so the health check needs no
# extra package.
RUN apk add --no-cache tzdata

WORKDIR /app
COPY --from=deps         /srv/node_modules  ./node_modules
COPY --from=server-build /srv/dist          ./dist
COPY --from=server-build /srv/package.json  ./package.json
# The server serves the PWA from ../public relative to dist/.
COPY --from=pwa          /pwa/dist          ./public

# Run unprivileged (the node image ships a `node` user).
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
