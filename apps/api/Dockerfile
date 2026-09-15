FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
RUN npm install
COPY apps/api/src ./apps/api/src
RUN npm --workspace @mcp/api run build
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
CMD ["node", "apps/api/dist/server.js"]
