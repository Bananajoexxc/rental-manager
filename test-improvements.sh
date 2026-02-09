#!/bin/bash

# Test script for validating the intelligence and safety improvements

set -e

echo "=================================================="
echo "Rental Bot Intelligence & Safety Improvements Test"
echo "=================================================="
echo ""

# Load environment
if [ -f .env ]; then
  source .env
fi

# Check database connection
echo "1. Testing database connection..."
psql $DATABASE_URL -c "SELECT 1;" > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "✓ Database connection successful"
else
  echo "✗ Database connection failed"
  exit 1
fi

# Check new tables exist
echo ""
echo "2. Verifying new database tables..."
for table in validation_log response_quality prompt_component prompt_version_log; do
  count=$(psql $DATABASE_URL -t -c "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "0")
  if [ "$count" != "0" ] || [ $? -eq 0 ]; then
    echo "✓ Table $table exists"
  else
    echo "✗ Table $table missing"
    exit 1
  fi
done

# Check prompt components seeded
echo ""
echo "3. Checking prompt components..."
component_count=$(psql $DATABASE_URL -t -c "SELECT COUNT(*) FROM prompt_component;")
if [ "$component_count" -gt 0 ]; then
  echo "✓ Prompt components seeded ($component_count components)"
else
  echo "⚠ Prompt components not seeded yet (will seed on first app start)"
fi

# Check build artifacts
echo ""
echo "4. Verifying build artifacts..."
if [ -f "dist/main.js" ]; then
  echo "✓ Build artifacts exist"
else
  echo "✗ Build artifacts missing - run 'npm run build'"
  exit 1
fi

# Check new service files
echo ""
echo "5. Checking new service files..."
for file in \
  "src/validation/validation.service.ts" \
  "src/evaluation/quality-scorer.service.ts" \
  "src/prompts/prompt-manager.service.ts"; do
  if [ -f "$file" ]; then
    echo "✓ $file exists"
  else
    echo "✗ $file missing"
    exit 1
  fi
done

# Check documentation
echo ""
echo "6. Checking documentation..."
for doc in IMPROVEMENTS.md MONITORING.md; do
  if [ -f "$doc" ]; then
    echo "✓ $doc exists"
  else
    echo "✗ $doc missing"
    exit 1
  fi
done

# Test queries
echo ""
echo "7. Running test queries..."

# Validation stats
echo "  - Validation statistics:"
psql $DATABASE_URL -t -c "
SELECT
  COALESCE(COUNT(*), 0) as total_validations,
  COALESCE(COUNT(*) FILTER (WHERE blocked = true), 0) as blocked_count
FROM validation_log
WHERE created_at > NOW() - INTERVAL '7 days';
" 2>/dev/null

# Quality stats
echo "  - Quality statistics:"
psql $DATABASE_URL -t -c "
SELECT
  COALESCE(COUNT(*), 0) as total_scores,
  COALESCE(ROUND(AVG(overall_quality)::numeric, 3), 0) as avg_quality
FROM response_quality
WHERE created_at > NOW() - INTERVAL '7 days';
" 2>/dev/null

# Conversation history
echo "  - Conversation history:"
psql $DATABASE_URL -t -c "
SELECT COUNT(*) as conversation_messages
FROM conversation
WHERE created_at > NOW() - INTERVAL '7 days';
" 2>/dev/null

echo ""
echo "=================================================="
echo "✓ All tests passed!"
echo "=================================================="
echo ""
echo "Next steps:"
echo "1. Restart the application: pm2 restart rental-manager"
echo "2. Monitor logs: pm2 logs rental-manager"
echo "3. Check validation: psql \$DATABASE_URL -f MONITORING.md (use queries)"
echo "4. Enable modular prompts: Add USE_MODULAR_PROMPTS=true to .env"
echo ""
echo "Documentation:"
echo "- IMPROVEMENTS.md - Implementation details"
echo "- MONITORING.md - SQL queries for monitoring"
echo ""
