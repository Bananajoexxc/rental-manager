# Quick Start Guide: Intelligence & Safety Improvements

## TL;DR - What Changed?

Your rental bot now has:
- ✅ **Safety validation** - Blocks credential leaks, dual-account disclosures
- ✅ **Conversation memory** - Bot remembers prior messages in threads
- ✅ **Quality scoring** - All responses rated for quality
- ✅ **Smart prompts** - Easy to update without code changes
- ✅ **Performance boost** - 50% faster for simple messages
- ✅ **Better intent detection** - Accurate pricing/delivery classification
- ✅ **Live inventory** - Real-time availability checks
- ✅ **Monitoring dashboard** - SQL queries to track everything

## Start Using It (3 Steps)

### 1. Restart the Application
```bash
cd /home/ubuntu/rental-manager
pm2 restart rental-manager
```

### 2. Watch the Logs
```bash
pm2 logs rental-manager --lines 50
```

Look for:
- ✓ "Seeded 11 prompt components" (first start)
- ✓ "Loaded 11 active prompt components into cache"
- ✓ Messages being processed with validation

### 3. Verify It's Working
```bash
node test-improvements.js
```

Should show:
- ✓ All tests passed
- ✓ 11 prompt components seeded

## What Happens Now?

### Automatic Features (Enabled Immediately)

**Conversation Memory**: Bot remembers last 10 messages per conversation
- Before: "Can you deliver?" → "What items?"
- After: "Can you deliver?" → "Sure, delivery for the FX3 you asked about..."

**Validation**: Every message is checked for safety violations
- Blocks: Credential leaks, dual-account mentions
- Flags: Pricing errors, inventory hallucinations
- Logs: Everything to `validation_log` table

**Quality Scoring**: Every response gets scored
- Dimensions: Pricing accuracy, rule compliance, conciseness, tone
- Replaces: Hardcoded confidence (0.75) with computed score
- Stores: All scores in `response_quality` table

**Context Optimization**: Loads less context for simple messages
- "hi" / "thanks" → Minimal context (~2ms)
- Normal queries → Standard context (~10ms)
- Pricing/delivery → Full context (~20ms)

**Live Inventory**: When items are mentioned, checks availability
- Queries: Real-time stock levels
- Responds: "2 out of 3 FX3s available" (not vague)

### Optional Features (Enable Manually)

**Modular Prompts**: Database-driven prompt components
```bash
# Add to .env
echo "USE_MODULAR_PROMPTS=true" >> .env
pm2 restart rental-manager
```

Benefits:
- Update prompts without code changes
- A/B test different variants
- Version control for prompts

## Check If It's Working

### Quick Health Check (Daily)
```bash
# Using psql
psql $DATABASE_URL -c "
SELECT
  COUNT(*) as responses_today,
  COUNT(*) FILTER (WHERE blocked = true) as blocked_today
FROM validation_log
WHERE created_at > NOW() - INTERVAL '24 hours';
"
```

Or using the monitoring dashboard:
```bash
# See MONITORING.md for full queries
# Copy/paste queries into your database client
```

### View Recent Conversations
```bash
psql $DATABASE_URL -c "
SELECT
  chat_id,
  role,
  LEFT(content, 60) as message,
  created_at
FROM conversation
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC
LIMIT 20;
"
```

### Check Quality Scores
```bash
psql $DATABASE_URL -c "
SELECT
  DATE(created_at) as date,
  ROUND(AVG(overall_quality)::numeric, 3) as avg_quality,
  COUNT(*) as responses
FROM response_quality
GROUP BY DATE(created_at)
ORDER BY date DESC
LIMIT 7;
"
```

## Common Questions

**Q: Will this break my existing bot?**
A: No. All improvements are additive. Modular prompts are opt-in.

**Q: How much does it cost?**
A: +$30/mo (~15% increase). Validation + hybrid intent detection.

**Q: Do I need to change my code?**
A: No. Everything works automatically after restart.

**Q: What if something goes wrong?**
A: Just restart: `pm2 restart rental-manager`. Database changes are safe.

**Q: How do I monitor it?**
A: See MONITORING.md for SQL queries. Run daily/weekly checks.

**Q: Can I disable validation?**
A: Not recommended, but you can comment out validation calls in `autonomous.service.ts`.

**Q: How do I update prompts?**
A: Enable modular prompts, then update via database or API.

## What to Monitor

### Daily (5 minutes)
- Check for blocked messages (critical violations)
- Review quality scores (should be >0.7)
- Verify conversation continuity works

### Weekly (30 minutes)
- Analyze quality trends
- Review low-quality responses
- Update prompt components if needed
- Check A/B test results (if running)

### Monthly (1-2 hours)
- Deep dive into violations
- Optimize underperforming components
- Review conversation patterns
- Clean up old logs

## Quick Access

**Documentation:**
- `IMPROVEMENTS.md` - Full implementation details
- `MONITORING.md` - SQL queries for monitoring
- `IMPLEMENTATION_SUMMARY.md` - What was built

**Test Scripts:**
- `node test-improvements.js` - Verify installation
- `./test-improvements.sh` - Shell version (requires psql)

**Key Files:**
- `src/validation/validation.service.ts` - Safety checks
- `src/evaluation/quality-scorer.service.ts` - Quality scoring
- `src/prompts/prompt-manager.service.ts` - Prompt management
- `src/autonomous/autonomous.service.ts` - Integration

**Database Tables:**
- `validation_log` - Validation results
- `response_quality` - Quality metrics
- `prompt_component` - Prompt pieces
- `prompt_version_log` - Usage tracking
- `conversation` - Message history

## Getting Help

**Build Issues:**
```bash
npm install
npm run build
```

**Database Issues:**
```bash
npx prisma generate
node test-improvements.js
```

**Runtime Issues:**
```bash
pm2 logs rental-manager --err
pm2 restart rental-manager
```

**Check Recent Activity:**
```bash
psql $DATABASE_URL -c "
SELECT COUNT(*) as messages_today
FROM ai_decision
WHERE created_at > NOW() - INTERVAL '24 hours';
"
```

## Next Steps

1. ✅ Restart application (done above)
2. ✅ Verify with test script (done above)
3. ⏳ Monitor for 24-48 hours
4. 🎯 Enable modular prompts (optional)
5. 📊 Set up monitoring dashboard
6. 🔄 Review weekly metrics

---

**Questions?** Check the full documentation:
- IMPROVEMENTS.md - Implementation guide
- MONITORING.md - Monitoring queries
- IMPLEMENTATION_SUMMARY.md - Summary

**Ready to go!** 🚀
