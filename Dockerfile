# Optional Docker path for web + server. `pnpm dev` keeps working unchanged.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS server
ENV HOST=0.0.0.0 PORT=4000 DATA_DIR=/data
EXPOSE 4000
CMD ["pnpm", "--filter", "@whiteboard/server", "start"]

FROM base AS web
# Inlined into the client bundle at build time; set to empty for same-origin server mode (behind Caddy).
ARG NEXT_PUBLIC_API_BASE=http://localhost:4000
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
RUN pnpm --filter @whiteboard/web build
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@whiteboard/web", "start"]
