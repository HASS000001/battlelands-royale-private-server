FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org \
    && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/backups && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
