FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 5001
CMD ["bun", "run", "start"]
