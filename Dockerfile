FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js channels.js test.js ./
COPY lib ./lib

ENV NODE_ENV=production
# PORT este suprascris automat de platformă (Render, Fly, Cloud Run etc.)
ENV PORT=7000
EXPOSE 7000

USER node

CMD ["node", "server.js"]
