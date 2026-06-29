FROM node:20-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3010

COPY --chown=node:node proxy/server.mjs ./server.mjs

USER node
EXPOSE 3010

CMD ["node", "server.mjs"]
