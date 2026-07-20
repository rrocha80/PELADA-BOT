FROM node:20-bullseye-slim

RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries && \
    apt-get update && \
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

# força build-from-source apenas para sqlite3
ENV npm_config_sqlite3_build_from_source=true

# node-gyp disponível no PATH para builders que esperam por ele
RUN npm install -g node-gyp

# instalar dependências (omitindo opcionais se preferir)
RUN npm ci --omit=optional

# garantir rebuild do sqlite3 se houver binário pré-compilado indesejado
RUN npm rebuild sqlite3 --build-from-source || true

COPY . .

RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

RUN mkdir -p /app/auth /app/data && chown -R node:node /app/auth /app/data

CMD ["node", "dist/index.js"]