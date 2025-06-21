FROM node:20-slim

RUN apt-get update && \
    apt-get install -y chromium && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm install

ENTRYPOINT ["node", "src/cli.js"]
