# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
# Install ALL dependencies (incl. devDependencies like typescript) and compile.
FROM node:18-alpine AS builder

WORKDIR /app

# Copy manifests first so this layer caches when source changes but deps don't
COPY package.json package-lock.json ./

# Full install (including devDependencies — we need tsc to build)
RUN npm ci

# Now bring in the source and compile
COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ---------- Stage 2: runtime ----------
# Slim image with only production deps and the compiled output.
FROM node:18-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy manifests and install ONLY production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the build artifacts from the builder stage
COPY --from=builder /app/dist ./dist

EXPOSE 8000

# Start the HTTP server (dist/http-server.js)
CMD ["npm", "start"]
