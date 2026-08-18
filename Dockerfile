FROM node:22-alpine
WORKDIR /app
COPY server/ ./server/
COPY seed/ ./seed/
ENV DATA_DIR=/data PORT=7331
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 7331
USER node
CMD ["node", "server/server.js"]
