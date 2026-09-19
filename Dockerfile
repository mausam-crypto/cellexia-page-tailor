# Matches the engines field in package.json (>=20.19 <22 || >=22.12).
FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

# Generate the Prisma client at image build time. Doing this on boot (the
# old `npm run setup` path) added tens of seconds to every cold start.
# Production uses Postgres (`schema.production.prisma`), not local SQLite.
RUN npx prisma generate --schema=./prisma/schema.production.prisma

RUN npm run build

CMD ["npm", "run", "docker-start"]
