FROM node:22-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM base AS dev
COPY . .
EXPOSE 7440
CMD ["npx", "tsx", "src/server.ts"]

FROM base AS production
COPY . .
RUN npm run build
EXPOSE 7440
CMD ["node", "bin/server.js"]
