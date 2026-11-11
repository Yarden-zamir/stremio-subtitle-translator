FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV CACHE_DIR=/data
EXPOSE 7000
# Runs as the image's root user on purpose: on the kitshn machine, Docker is rootless,
# so container root is the kitshn user, which owns the socket folder (K-607).
CMD ["bun", "src/server.ts"]
