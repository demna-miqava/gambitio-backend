# The backend container that Cloudflare runs (see wrangler.jsonc).
# Cloudflare runs it on linux/amd64. Env vars come from the Worker
# (worker/index.ts), never from a .env file baked into the image.

FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-trixie-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080
USER node
# Not `npm start`: that reads a .env file, which the image doesn't have.
CMD ["node", "dist/index.js"]
