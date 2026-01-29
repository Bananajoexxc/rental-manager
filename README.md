# Rental Manager - Hygglo Automation Service

🤖 A headless NestJS background service that automates rental tracking and item extraction for Hygglo rental platform.

## 📦 Features

- **Automated Hygglo Authentication**: Maintains persistent login session with automatic re-authentication
- **Continuous Rental Scanning**: Scans both ongoing and upcoming rentals automatically
- **AI-Powered Image Analysis**: Extracts items from rental listing photos using Vision AI
- **Description Parsing**: Intelligently extracts items mentioned in listing descriptions
- **Adaptive Scheduling**: Adjusts scan frequency based on activity (1 min → 5 min when inactive)
- **Comprehensive Logging**: Rotating log files with detailed operation tracking
- **PostgreSQL Database**: Persistent storage with Prisma ORM
- **Docker Support**: Easy deployment with Docker and Docker Compose
- **REST API with Swagger**: Comprehensive API for monitoring and data access with interactive documentation

## 🏛️ Architecture

### Database Schema

**Rentals Table**: Stores all rental listings with details
- `listing_id` (unique identifier)
- `title`, `status` (ongoing/upcoming)
- `start_date`, `end_date`
- `renter_info`, `listing_url`
- `description`, `photos_urls[]`

**ExtractedItems Table**: Items identified from photos
- `item_name`, `source` (photo/description)
- `confidence_score` (AI confidence)
- `rental_id` (foreign key)

**ItemCatalog Table**: One-time catalog of items per listing
- `listing_id`, `item_name`
- `description`, `first_seen_at`

### Service Modules

- **HyggloService**: Browser automation with Playwright for web scraping
- **ImageAnalysisService**: AI vision analysis for item extraction
- **RentalScannerService**: Core scheduler with adaptive scanning logic
- **LoggingService**: Winston-based logging with daily rotation
- **PrismaService**: Database ORM layer

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and Yarn
- PostgreSQL database
- Hygglo account credentials
- Abacus AI API key (for image analysis)

### Installation

1. **Clone the repository**:
```bash
git clone https://github.com/Bananajoexxc/rental-manager.git
cd rental-manager/nodejs_space
```

2. **Install dependencies**:
```bash
yarn install
```

3. **Set up environment variables**:
```bash
cp .env.example .env
```

Edit `.env` and configure:
```env
HYGGLO_EMAIL=your_email@example.com
HYGGLO_PASSWORD=your_password
DATABASE_URL=postgresql://user:password@localhost:5432/rental_manager
ABACUSAI_API_KEY=your_api_key_here

# Optional: Customize intervals (in milliseconds)
INITIAL_SCAN_INTERVAL_MS=60000
REDUCED_SCAN_INTERVAL_MS=300000
INACTIVITY_THRESHOLD_MS=1800000
LOG_LEVEL=info
```

4. **Set up the database**:
```bash
# Generate Prisma client
yarn prisma generate

# Push schema to database
yarn prisma db push
```

5. **Start the service**:
```bash
# Development mode
yarn start:dev

# Production mode
yarn build
yarn start:prod
```

## 🐳 Docker Deployment

### Option 1: Docker Compose (Recommended)

This method includes a PostgreSQL database container.

1. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your credentials
```

2. **Update database URL** in `.env`:
```env
DATABASE_URL=postgresql://rental_manager:changeme@postgres:5432/rental_manager
```

3. **Start services**:
```bash
docker-compose up -d
```

4. **Run database migrations**:
```bash
docker-compose exec rental-manager yarn prisma db push
```

5. **View logs**:
```bash
# Service logs
docker-compose logs -f rental-manager

# Application logs
cat logs/rental-manager-*.log
```

6. **Stop services**:
```bash
docker-compose down
```

### Option 2: Docker Build Only

1. **Build the image**:
```bash
docker build -t rental-manager .
```

2. **Run the container**:
```bash
docker run -d \
  --name rental-manager \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/rental_manager" \
  -e HYGGLO_EMAIL="your_email@example.com" \
  -e HYGGLO_PASSWORD="your_password" \
  -e ABACUSAI_API_KEY="your_api_key" \
  -v $(pwd)/logs:/app/logs \
  rental-manager
```

## ☁️ AWS Deployment

### Deploy to AWS EC2

1. **Launch EC2 instance** (Ubuntu 22.04, t3.medium or larger recommended)

2. **Install Docker and Docker Compose**:
```bash
sudo apt update
sudo apt install -y docker.io docker-compose
sudo usermod -aG docker ubuntu
```

3. **Clone and configure**:
```bash
git clone https://github.com/Bananajoexxc/rental-manager.git
cd rental-manager/nodejs_space
cp .env.example .env
nano .env  # Edit with your credentials
```

4. **Deploy**:
```bash
docker-compose up -d
docker-compose exec rental-manager yarn prisma db push
```

5. **Set up as systemd service** (optional, for auto-restart):
```bash
sudo nano /etc/systemd/system/rental-manager.service
```

Add:
```ini
[Unit]
Description=Rental Manager Service
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/ubuntu/rental-manager/nodejs_space
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable rental-manager
sudo systemctl start rental-manager
```

### Deploy to AWS ECS (Fargate)

1. **Push image to ECR**:
```bash
aws ecr create-repository --repository-name rental-manager
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

docker build -t rental-manager .
docker tag rental-manager:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/rental-manager:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/rental-manager:latest
```

2. **Create task definition** with environment variables
3. **Create ECS service** with Fargate launch type
4. **Configure RDS PostgreSQL** for database

## 📡 API Endpoints

The service exposes a comprehensive REST API for monitoring and data access. All endpoints are documented with **Swagger UI**.

### Interactive API Documentation

**Access the Swagger UI:**
- **Local**: http://localhost:3000/api-docs
- **Production**: https://your-domain.com/api-docs

### Available Endpoints

#### Health & Status
- `GET /` - Service information with version
- `GET /health` - Health check with uptime and scanner state
- `GET /scanner/status` - Detailed scanner status and authentication

#### Rentals
- `GET /rentals/stats` - Statistics (total, ongoing, upcoming counts)
- `GET /rentals/recent?limit=10` - Recent rental listings (default: 10, max: 100)

#### Items
- `GET /items/recent?limit=20` - Recently extracted items from photos (default: 20, max: 100)
- `GET /items/catalog?limit=50` - Item catalog from descriptions (default: 50, max: 100)

### Example API Calls

```bash
# Service information
curl http://localhost:3000/ | jq .

# Health check
curl http://localhost:3000/health | jq .

# Scanner status
curl http://localhost:3000/scanner/status | jq .

# Rental statistics
curl http://localhost:3000/rentals/stats | jq .

# Get 5 most recent rentals
curl http://localhost:3000/rentals/recent?limit=5 | jq .

# Recently extracted items
curl http://localhost:3000/items/recent?limit=10 | jq .

# Item catalog
curl http://localhost:3000/items/catalog | jq .
```

### Example Response (Health Check)

```json
{
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2026-01-29T12:00:00.000Z",
  "scanner": {
    "isScanning": false,
    "currentScanInterval": 60000,
    "lastActivityTime": "2026-01-29T11:55:00.000Z",
    "authenticated": true
  }
}
```

## 🛡️ Monitoring & Maintenance

### Viewing Logs

**Application logs** (rotating daily):
```bash
tail -f logs/rental-manager-$(date +%Y-%m-%d).log
```

**Docker logs**:
```bash
docker-compose logs -f rental-manager
```

### Database Management

**Connect to database**:
```bash
# Via Docker
docker-compose exec postgres psql -U rental_manager -d rental_manager
```

**View rentals**:
```sql
SELECT id, title, status, created_at FROM rental ORDER BY created_at DESC LIMIT 10;
```

**View extracted items**:
```sql
SELECT r.title, e.item_name, e.source, e.confidence_score 
FROM extracteditem e 
JOIN rental r ON e.rental_id = r.id 
ORDER BY e.created_at DESC LIMIT 20;
```

**View catalog items**:
```sql
SELECT listing_id, item_name, first_seen_at 
FROM itemcatalog 
ORDER BY first_seen_at DESC;
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|----------|
| `HYGGLO_EMAIL` | Hygglo account email | *Required* |
| `HYGGLO_PASSWORD` | Hygglo account password | *Required* |
| `DATABASE_URL` | PostgreSQL connection string | *Required* |
| `ABACUSAI_API_KEY` | API key for image analysis | *Required* |
| `INITIAL_SCAN_INTERVAL_MS` | Scan interval when active | 60000 (1 min) |
| `REDUCED_SCAN_INTERVAL_MS` | Scan interval when inactive | 300000 (5 min) |
| `INACTIVITY_THRESHOLD_MS` | Time before reducing scan frequency | 1800000 (30 min) |
| `LOG_LEVEL` | Logging level (info, debug, warn, error) | info |
| `PORT` | HTTP port for health endpoint | 3000 |

### Adaptive Scheduling Logic

1. **Initial state**: Scans every 1 minute
2. **Activity detection**: If new rentals found → continue 1-minute scanning
3. **Inactivity detection**: No new rentals for 30 minutes → switch to 5-minute scanning
4. **Re-activation**: New rental found → switch back to 1-minute scanning

## 🐛 Troubleshooting

### Authentication Issues

**Problem**: "Authentication failed" in logs

**Solutions**:
- Verify `HYGGLO_EMAIL` and `HYGGLO_PASSWORD` are correct
- Check if Hygglo login page structure has changed
- Test manual login at https://www.hygglo.se/login
- Review logs for detailed error messages

### Image Analysis Issues

**Problem**: No items extracted from photos

**Solutions**:
- Verify `ABACUSAI_API_KEY` is set correctly
- Check API quota/limits
- Review logs for API error responses
- Ensure photo URLs are accessible

### Database Connection Issues

**Problem**: "Database connection failed"

**Solutions**:
- Verify `DATABASE_URL` is correct
- Ensure PostgreSQL is running
- Check firewall rules
- Test connection: `psql $DATABASE_URL`

### Playwright/Browser Issues

**Problem**: "Browser launch failed"

**Solutions**:
- Install system dependencies: `yarn playwright install-deps`
- For Docker: Already included in Dockerfile
- Check system resources (memory, disk space)

## 📝 Logs Explanation

### Log Levels

- **INFO**: Normal operations (scans, new rentals, scheduling changes)
- **WARN**: Non-critical issues (authentication retries, missing data)
- **ERROR**: Critical failures (database errors, API failures)
- **DEBUG**: Detailed debugging information (set `LOG_LEVEL=debug`)

### Key Log Messages

```
🚀 Rental Manager Service is running on port 3000
✅ Database connected successfully
🔐 Attempting to authenticate with Hygglo
🔍 Scanning ongoing rentals...
✨ New rental found: [Rental Title]
🖼️ Analyzing 5 photos...
✅ Saved 12 items from photos
🐌 Switching to reduced scanning (300s interval due to inactivity)
```

## 📊 Performance Considerations

- **Scan frequency**: Balance between real-time tracking and API rate limits
- **Image analysis**: Rate limited to avoid API throttling (1 second delay between images)
- **Database queries**: Indexed on `listing_id` and `status` for fast lookups
- **Memory usage**: ~200-300 MB typical, peaks during image analysis
- **Storage**: Logs rotate daily, keep 14 days by default

## 🔒 Security Best Practices

1. **Never commit `.env` file** to version control
2. **Use strong passwords** for database and Hygglo account
3. **Rotate API keys** periodically
4. **Restrict database access** to localhost or VPC
5. **Use HTTPS** for production deployments
6. **Enable firewall** on AWS EC2 instances
7. **Regular updates**: Keep dependencies updated (`yarn upgrade`)

## 🛣️ Roadmap

- [ ] Email notifications for new rentals
- [ ] Webhook support for real-time updates
- [ ] Enhanced item categorization (AI tagging)
- [ ] Multi-account support
- [ ] GraphQL API for querying data
- [ ] Dashboard UI (optional web interface)
- [ ] Export functionality (CSV, JSON)

## 📜 License

MIT License - See LICENSE file for details

## 👥 Support

For issues and questions:
- GitHub Issues: https://github.com/Bananajoexxc/rental-manager/issues
- Email: [your-email@example.com]

## 🚀 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

**Built with ❤️ using NestJS, Playwright, and Abacus AI**
