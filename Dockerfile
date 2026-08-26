FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tar git openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]
