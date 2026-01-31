# Multi-stage Dockerfile for Rental Manager Service

# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./
COPY prisma ./prisma/

# Install dependencies
RUN yarn install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma Client
RUN yarn prisma generate

# Build the application
RUN yarn build

# Stage 2: Production
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./
COPY prisma ./prisma/

# Install production dependencies only
RUN yarn install --frozen-lockfile --production

# Generate Prisma Client
RUN yarn prisma generate

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p /app/logs

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["node", "dist/main.js"]
