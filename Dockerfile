FROM node:20

# instalar deps do sistema necessárias para compilar módulos nativos (sqlite3, sharp, etc.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
      make \
      g++ \
      pkg-config \
      ca-certificates \
      libsqlite3-dev \
      libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copiar package.json (e lock) antes para aproveitar cache
COPY package*.json ./

# forçar build-from-source para módulos nativos que precisam (garante binário compatível com a libc do container)
ENV npm_config_build_from_source=true

# instalar dependências (vai compilar o que for necessário)
RUN npm ci

# copiar restante do projeto
COPY . .

# compilar TypeScript
RUN npm run build

# remover devDependencies para imagem final menor
RUN npm prune --production

ENV NODE_ENV=production

# montar volumes para persistir auth e DB ao rodar
VOLUME [ "/app/auth", "/app/pelada.db" ]

CMD ["node", "dist/index.js"]