FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/analyzer/package.json packages/analyzer/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/vscode/package.json apps/vscode/
RUN npm ci -w @tesseract/analyzer -w @tesseract/web -w @tesseract/server --include-workspace-root
COPY packages/analyzer packages/analyzer
COPY apps/web apps/web
COPY apps/server apps/server
RUN npm run build:server

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/analyzer/package.json packages/analyzer/
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
