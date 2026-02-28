FROM ghcr.io/puppeteer/puppeteer:latest
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
ENV PORT=10000
CMD ["node", "server.js"]
