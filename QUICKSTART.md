# Quick Start Guide

🚀 Get the Rental Manager running in **5 minutes** with Docker!

## Prerequisites

- Docker and Docker Compose installed
- Hygglo account credentials
- Abacus AI API key

## Step 1: Clone Repository

```bash
git clone https://github.com/Bananajoexxc/rental-manager.git
cd rental-manager/nodejs_space
```

## Step 2: Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your credentials
nano .env  # or vim, code, etc.
```

**Required variables:**
```env
HYGGLO_EMAIL=your_email@example.com
HYGGLO_PASSWORD=your_password
ABACUSAI_API_KEY=your_api_key_here
DATABASE_URL=postgresql://rental_manager:changeme@postgres:5432/rental_manager
```

## Step 3: Start Services

```bash
# Start containers in background
docker-compose up -d

# View logs
docker-compose logs -f
```

## Step 4: Initialize Database

```bash
# Run database migration
docker-compose exec rental-manager yarn prisma db push
```

## Step 5: Verify Running

```bash
# Check health endpoint
curl http://localhost:3000/health

# Expected response:
# {
#   "status": "healthy",
#   "uptime": 123,
#   "timestamp": "2026-01-29T12:00:00.000Z",
#   "scanner": {
#     "isScanning": false,
#     "currentScanInterval": 60000,
#     "lastActivityTime": "2026-01-29T11:55:00.000Z",
#     "authenticated": true
#   }
# }
```

## ✅ Done!

The service is now:
- ✅ Running in background
- ✅ Authenticated with Hygglo
- ✅ Scanning rentals every 1 minute
- ✅ Logging to `./logs/`

## Useful Commands

### View Logs
```bash
# Service logs
docker-compose logs -f rental-manager

# Application logs
tail -f logs/rental-manager-$(date +%Y-%m-%d).log
```

### Database Access
```bash
# Connect to PostgreSQL
docker-compose exec postgres psql -U rental_manager -d rental_manager

# View rentals
SELECT id, title, status, created_at FROM rental ORDER BY created_at DESC LIMIT 10;

# View extracted items
SELECT r.title, e.item_name, e.confidence_score 
FROM extracteditem e 
JOIN rental r ON e.rental_id = r.id 
ORDER BY e.created_at DESC LIMIT 20;
```

### Manage Service
```bash
# Stop service
docker-compose stop

# Start service
docker-compose start

# Restart service
docker-compose restart

# Stop and remove containers
docker-compose down

# Remove containers AND data
docker-compose down -v
```

## Next Steps

1. **Monitor Activity**: Watch logs for rental scans
2. **Check Database**: Query rentals and extracted items
3. **Customize Intervals**: Edit scanning intervals in `.env`
4. **Deploy to AWS**: Follow AWS deployment guide in README.md

## Troubleshooting

**Service won't start?**
```bash
docker-compose logs rental-manager
```

**Database connection error?**
- Check `DATABASE_URL` in `.env`
- Ensure PostgreSQL container is running: `docker-compose ps`

**Authentication failed?**
- Verify `HYGGLO_EMAIL` and `HYGGLO_PASSWORD`
- Test manual login at https://www.hygglo.se/login

**Need help?** Check the full README.md or open an issue on GitHub.

---

**🎉 Happy Rental Tracking!**
