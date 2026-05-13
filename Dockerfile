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

COPY package*.json ./

# força build-from-source (garante binário compatível com a libc do container)
ENV npm_config_build_from_source=true

# instalar dependências (sem opcionais)
RUN npm ci --no-optional

# garantir rebuild do sqlite3 se por algum motivo ficou pré-compilado
RUN npm rebuild sqlite3 --build-from-source || true

COPY . .

RUN npm run build
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]