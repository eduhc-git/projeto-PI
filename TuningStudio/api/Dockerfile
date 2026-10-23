FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY api/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY api/src ./src
COPY database/migrations ./migrations
COPY tuning_dashboard.html index_fixed.html gemini-code-1792015511920.html ./public/
COPY logo.PNG ./public/logo.png
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
