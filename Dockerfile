FROM node:20

# instalar deps para compilar módulos nativos
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# evitar copiar node_modules do host
COPY package*.json ./

# forçar build-from-source para módulos nativos (ex.: sqlite3)
ENV npm_config_build_from_source=true

# instalar dependências (vai compilar sqlite3 no container)
RUN npm ci

# copiar restante do projeto
COPY . .

# compilar TypeScript
RUN npm run build

# remover devDependencies para imagem final menor
RUN npm prune --production

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]