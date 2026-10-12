# Build context is the repo root (see docker-compose.yml) so contracts/ is available.
FROM node:22-alpine AS build
WORKDIR /app
COPY scoring-service/package.json scoring-service/package-lock.json ./
RUN npm ci --ignore-scripts
COPY scoring-service/tsconfig.json scoring-service/tsconfig.build.json ./
COPY scoring-service/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scoring-service/package.json ./
# Resolved at runtime as dist/features/../../../contracts -> /contracts
COPY contracts/geo_cities.csv /contracts/geo_cities.csv
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
