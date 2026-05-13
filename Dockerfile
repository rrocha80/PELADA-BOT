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
      libvips-dev \
      libglib2.0-dev \
      liborc-0.4-dev \
      libcairo2-dev \
      libgirepository1.0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# build-from-source apenas para sqlite3
ENV npm_config_sqlite3_build_from_source=true

RUN npm ci

COPY . .

RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

RUN mkdir -p /app/auth /app/data && chown -R node:node /app/auth /app/data

CMD ["node", "dist/index.js"]