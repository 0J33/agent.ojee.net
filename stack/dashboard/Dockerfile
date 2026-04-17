FROM node:20-alpine
# gcompat lets glibc-linked binaries (nvidia-smi, injected by nvidia-container-toolkit) run on Alpine/musl.
RUN apk add --no-cache docker-cli docker-cli-compose gcompat
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
EXPOSE 8080
CMD ["node", "server.js"]
