FROM node:20-bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      make \
      g++ \
      pkg-config \
      ca-certificates \
      curl \
      libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copiar package.json antes para usar cache
COPY package*.json ./

# build-from-source apenas para sqlite3
ENV npm_config_sqlite3_build_from_source=true

# não instalar optional deps (previne tentativa de build do sharp se for optional)
RUN npm ci --no-optional

# copiar código e compilar
COPY . .
RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]