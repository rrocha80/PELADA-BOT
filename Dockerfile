FROM node:20

# instalar dependências de sistema necessárias para compilar sqlite3 e outros módulos nativos
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copiar package-lock / package antes de copiar o restante para aproveitar cache
COPY package*.json ./

# instalar todas as dependências (dev + prod) para permitir build
RUN npm ci

# copiar restante do projeto
COPY . .

# compilar TypeScript
RUN npm run build

# remover devDependencies para imagem final menor
RUN npm prune --production

ENV NODE_ENV=production

# persistir pasta de autenticação e banco (opcional, montar via -v ao rodar)
VOLUME [ "/app/auth", "/app/pelada.db" ]

CMD ["node", "dist/index.js"]