FROM node:20

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      make \
      g++ \
      pkg-config \
      ca-certificates \
      curl \
      git \
      libsqlite3-dev \
      libjpeg-dev \
      libpng-dev \
      libwebp-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# build-from-source apenas para sqlite3 (evita compilar sharp/libvips)
ENV npm_config_sqlite3_build_from_source=true

# permite que sharp baixe binários pré-compilados (não build-from-source)
# (não exportar npm_config_build_from_source)

RUN npm ci

COPY . .

RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

RUN mkdir -p /app/auth /app/data && chown -R node:node /app/auth /app/data

CMD ["node", "dist/index.js"]