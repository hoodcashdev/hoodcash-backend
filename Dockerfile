# HoodCash keeper backend — Railway/Docker image
FROM node:22-slim

# build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps (tsx runs the TS directly, so we keep devDeps)
COPY package*.json ./
RUN npm install

COPY . .

# SQLite lives on a mounted volume so it survives redeploys
RUN mkdir -p /data
ENV NODE_ENV=production
ENV DB_PATH=/data/hoodcash.db

EXPOSE 8787
CMD ["npm", "run", "start"]
