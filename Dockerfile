# realdentalcosts-mcp, stdio MCP server (dist/index.js). Data is bundled in dist/data: no network access at runtime.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-alpine
ARG VERSION=0.0.0
LABEL io.modelcontextprotocol.server.name="io.github.tresor4k/realdentalcosts-mcp" \
      org.opencontainers.image.title="realdentalcosts-mcp" \
      org.opencontainers.image.description="Sourced US and Canadian dental prices, Medicaid and Medicare dental rules, treatment-plan checker." \
      org.opencontainers.image.url="https://mcp.realdentalcosts.com/docs" \
      org.opencontainers.image.source="https://github.com/tresor4k/realdentalcosts-mcp" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# uid 1000 = user "node" of the official image
USER node
ENTRYPOINT ["node", "/app/dist/index.js"]
