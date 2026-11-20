FROM node:22-alpine
WORKDIR /app
# No dependencies to install (the app is zero-dependency Node.js), so this is just the source.
COPY . .
# Fails the BUILD (loud, clear, once) instead of producing an image that crash-loops at runtime with
# "Cannot find module '/app/server.js'". That happens when `docker build` / `docker compose build` is run
# from a folder that does not contain the full source (for example only docker-compose.yml + .env were
# copied to the server, without server.js and the rest of the app next to them).
RUN test -f server.js || (echo "ERROR: server.js is missing from the build context. Run docker build / docker compose build from the full guild-hall source folder (the one server.js is actually in), not from a folder that only has docker-compose.yml and .env." && exit 1)
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD ["node", "-e", "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
CMD ["node", "server.js"]
