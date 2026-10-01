FROM node:22-slim AS build
WORKDIR /app

RUN npm install -g pnpm@10.32.1

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY . .
# Builds the React app (web/dist) and compiles the Express server
# (web/server-dist) — see web/package.json.
RUN pnpm --filter web build

FROM node:22-slim
WORKDIR /app

RUN npm install -g pnpm@10.32.1

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/web/server-dist ./web/server-dist

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3001

CMD ["node", "web/server-dist/index.js"]
