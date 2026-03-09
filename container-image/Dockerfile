FROM node:22-slim

WORKDIR /app

COPY shared/ ./shared/
COPY container/ ./container/

CMD ["node", "container/agent.js"]
