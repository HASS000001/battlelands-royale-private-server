FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org \
    && npm cache clean --force

COPY --chown=node:node src ./src
USER node

CMD ["node", "src/index.js"]
