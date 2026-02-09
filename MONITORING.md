# Rental Bot Intelligence & Safety Monitoring Dashboard

This document provides SQL queries and instructions for monitoring the rental bot's performance, safety, and quality metrics.

## Overview

The monitoring system tracks:
- **Validation**: Safety rule violations and blocking
- **Quality**: Response quality scores across multiple dimensions
- **Performance**: Token usage, latency, success rates
- **Prompts**: Component performance and A/B test results

## Quick Stats Queries

### Current Performance Overview

```sql
-- Overall system health (last 24 hours)
SELECT
  COUNT(DISTINCT ad.id) as total_responses,
  AVG(rq.overall_quality) as avg_quality,
  AVG(rq.computed_confidence) as avg_confidence,
  COUNT(vl.id) FILTER (WHERE vl.blocked = true) as blocked_count,
  COUNT(vl.id) FILTER (WHERE vl.severity = 'critical') as critical_violations
FROM ai_decision ad
LEFT JOIN response_quality rq ON rq.ai_decision_id = ad.id
LEFT JOIN validation_log vl ON vl.ai_decision_id = ad.id
WHERE ad.created_at > NOW() - INTERVAL '24 hours'
  AND ad.decision_type = 'message';
```

### Validation Safety Report

```sql
-- Validation statistics (last 7 days)
SELECT
  vl.severity,
  COUNT(*) as total_validations,
  COUNT(*) FILTER (WHERE blocked = true) as blocked_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE blocked = true) / COUNT(*), 2) as block_rate_pct,
  ARRAY_AGG(DISTINCT violations[1]) FILTER (WHERE array_length(violations, 1) > 0) as common_violations
FROM validation_log vl
WHERE vl.created_at > NOW() - INTERVAL '7 days'
GROUP BY vl.severity
ORDER BY
  CASE vl.severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END;
```

### Quality Trends

```sql
-- Quality scores by dimension (last 7 days)
SELECT
  DATE(rq.created_at) as date,
  ROUND(AVG(rq.pricing_accuracy)::numeric, 3) as avg_pricing_accuracy,
  ROUND(AVG(rq.rule_compliance)::numeric, 3) as avg_rule_compliance,
  ROUND(AVG(rq.conciseness)::numeric, 3) as avg_conciseness,
  ROUND(AVG(rq.tone_match)::numeric, 3) as avg_tone_match,
  ROUND(AVG(rq.overall_quality)::numeric, 3) as avg_overall_quality,
  COUNT(*) as sample_size
FROM response_quality rq
WHERE rq.created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(rq.created_at)
ORDER BY date DESC;
```

## Detailed Investigation Queries

### Low Quality Responses

```sql
-- Find recent low-quality responses for review
SELECT
  ad.id,
  ad.created_at,
  ad.decision_type,
  SUBSTRING(ad.input_summary, 1, 100) as input,
  SUBSTRING(ad.output_summary, 1, 100) as output,
  rq.overall_quality,
  rq.pricing_accuracy,
  rq.rule_compliance,
  rq.conciseness,
  rq.tone_match
FROM ai_decision ad
JOIN response_quality rq ON rq.ai_decision_id = ad.id
WHERE rq.overall_quality < 0.7
  AND ad.created_at > NOW() - INTERVAL '7 days'
ORDER BY rq.overall_quality ASC, ad.created_at DESC
LIMIT 20;
```

### Critical Validation Failures

```sql
-- Review blocked responses (security incidents)
SELECT
  vl.created_at,
  vl.severity,
  vl.violations,
  SUBSTRING(vl.response_text, 1, 200) as response_preview,
  ad.input_summary,
  ad.action_taken
FROM validation_log vl
LEFT JOIN ai_decision ad ON vl.ai_decision_id = ad.id
WHERE vl.blocked = true
  AND vl.severity IN ('critical', 'high')
  AND vl.created_at > NOW() - INTERVAL '30 days'
ORDER BY vl.created_at DESC;
```

### Violation Breakdown

```sql
-- Most common violation types
SELECT
  UNNEST(violations) as violation_type,
  COUNT(*) as occurrence_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM validation_log
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY violation_type
ORDER BY occurrence_count DESC;
```

## Prompt Performance Queries

### Component Usage Statistics

```sql
-- Prompt component performance
SELECT
  pc.name,
  pc.version,
  pc.category,
  pc.usage_count,
  ROUND(pc.pass_rate::numeric, 3) as validation_pass_rate,
  pc.active
FROM prompt_component pc
WHERE pc.usage_count > 0
ORDER BY pc.usage_count DESC, pc.name;
```

### A/B Test Results

```sql
-- Compare A/B test variants
SELECT
  pvl.component_name,
  pvl.version,
  pc.ab_group,
  COUNT(*) as uses,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pvl.validation_pass = true) / COUNT(*), 2) as pass_rate_pct,
  ROUND(AVG(pvl.quality_score)::numeric, 3) as avg_quality
FROM prompt_version_log pvl
JOIN prompt_component pc ON pc.name = pvl.component_name AND pc.version = pvl.version
WHERE pvl.created_at > NOW() - INTERVAL '7 days'
  AND pc.ab_group IS NOT NULL
GROUP BY pvl.component_name, pvl.version, pc.ab_group
ORDER BY pvl.component_name, avg_quality DESC;
```

## Conversation Analysis

### Multi-Turn Conversation Quality

```sql
-- Analyze conversation continuity
SELECT
  c.chat_id,
  COUNT(*) as message_count,
  MIN(c.created_at) as conversation_start,
  MAX(c.created_at) as conversation_end,
  EXTRACT(EPOCH FROM (MAX(c.created_at) - MIN(c.created_at)))/3600 as duration_hours
FROM conversation c
WHERE c.created_at > NOW() - INTERVAL '7 days'
GROUP BY c.chat_id
HAVING COUNT(*) > 5  -- Multi-turn conversations only
ORDER BY message_count DESC
LIMIT 20;
```

### Response Time Analysis

```sql
-- Token usage and efficiency
SELECT
  DATE(ad.created_at) as date,
  COUNT(*) as response_count,
  AVG(CAST(ad.metadata->>'inputTokens' AS INTEGER)) as avg_input_tokens,
  AVG(CAST(ad.metadata->>'outputTokens' AS INTEGER)) as avg_output_tokens,
  SUM(CAST(ad.metadata->>'inputTokens' AS INTEGER)) as total_input_tokens,
  SUM(CAST(ad.metadata->>'outputTokens' AS INTEGER)) as total_output_tokens
FROM ai_decision ad
WHERE ad.created_at > NOW() - INTERVAL '7 days'
  AND ad.decision_type = 'message'
  AND ad.metadata IS NOT NULL
GROUP BY DATE(ad.created_at)
ORDER BY date DESC;
```

## Alert Queries

### Critical Issues (Run Frequently)

```sql
-- Alert: Critical violations in last hour
SELECT COUNT(*) as critical_violations_last_hour
FROM validation_log
WHERE severity = 'critical'
  AND blocked = true
  AND created_at > NOW() - INTERVAL '1 hour';

-- Alert: Quality degradation
SELECT
  AVG(rq.overall_quality) as avg_quality_last_hour
FROM response_quality rq
WHERE rq.created_at > NOW() - INTERVAL '1 hour'
HAVING AVG(rq.overall_quality) < 0.6;  -- Threshold: quality below 0.6

-- Alert: High block rate
SELECT
  COUNT(*) FILTER (WHERE blocked = true)::float / COUNT(*) as block_rate_last_hour
FROM validation_log
WHERE created_at > NOW() - INTERVAL '1 hour'
HAVING COUNT(*) FILTER (WHERE blocked = true)::float / COUNT(*) > 0.1;  -- Threshold: >10% blocked
```

## Performance Optimization Queries

### Identify Slow Prompts

```sql
-- Find prompt components associated with low quality
SELECT
  pvl.component_name,
  COUNT(*) as uses,
  ROUND(AVG(pvl.quality_score)::numeric, 3) as avg_quality,
  ROUND(100.0 * COUNT(*) FILTER (WHERE NOT pvl.validation_pass) / COUNT(*), 2) as failure_rate_pct
FROM prompt_version_log pvl
WHERE pvl.created_at > NOW() - INTERVAL '7 days'
GROUP BY pvl.component_name
HAVING COUNT(*) > 10
ORDER BY avg_quality ASC;
```

### Context Level Analysis

```sql
-- Analyze context optimization effectiveness
-- (Requires adding context_level to ai_decision metadata)
SELECT
  ad.metadata->>'contextLevel' as context_level,
  COUNT(*) as count,
  AVG(rq.overall_quality) as avg_quality,
  AVG(CAST(ad.metadata->>'inputTokens' AS INTEGER)) as avg_tokens
FROM ai_decision ad
JOIN response_quality rq ON rq.ai_decision_id = ad.id
WHERE ad.created_at > NOW() - INTERVAL '7 days'
  AND ad.metadata->>'contextLevel' IS NOT NULL
GROUP BY ad.metadata->>'contextLevel'
ORDER BY context_level;
```

## Maintenance Tasks

### Clean Old Logs (Run Monthly)

```sql
-- Archive validation logs older than 90 days
DELETE FROM validation_log
WHERE created_at < NOW() - INTERVAL '90 days';

-- Archive prompt version logs older than 90 days
DELETE FROM prompt_version_log
WHERE created_at < NOW() - INTERVAL '90 days';

-- Archive old conversation history (keep 60 days)
DELETE FROM conversation
WHERE created_at < NOW() - INTERVAL '60 days';
```

### Update Component Pass Rates

```sql
-- Recalculate pass rates for prompt components
UPDATE prompt_component pc
SET pass_rate = (
  SELECT COALESCE(
    100.0 * COUNT(*) FILTER (WHERE pvl.validation_pass = true) / NULLIF(COUNT(*), 0),
    0
  )
  FROM prompt_version_log pvl
  WHERE pvl.component_name = pc.name
    AND pvl.version = pc.version
    AND pvl.created_at > NOW() - INTERVAL '7 days'
)
WHERE pc.active = true;
```

## Dashboard Recommendations

### Daily Check (5 minutes)
1. Run "Current Performance Overview"
2. Check "Critical Issues" alerts
3. Review any blocked responses from last 24 hours

### Weekly Review (30 minutes)
1. Analyze "Quality Trends" over the week
2. Review "Low Quality Responses" for patterns
3. Check "A/B Test Results" for winning variants
4. Update underperforming prompt components

### Monthly Analysis (1-2 hours)
1. Deep dive into "Violation Breakdown"
2. Optimize slow/low-quality prompt components
3. Review conversation patterns and multi-turn quality
4. Run maintenance tasks (cleanup old logs)
5. Export trends for reporting

## Integration with External Tools

### Grafana/Metabase Setup
Import these queries into your visualization tool:
- Time-series: Quality trends, violation counts
- Gauges: Current pass rates, average quality
- Tables: Recent low-quality responses, blocked items

### Alerting Setup (e.g., cron + Telegram)
```bash
# Example: Alert on critical violations
*/15 * * * * psql $DATABASE_URL -t -c "SELECT COUNT(*) FROM validation_log WHERE severity='critical' AND blocked=true AND created_at > NOW() - INTERVAL '15 minutes'" | xargs -I {} sh -c 'if [ {} -gt 0 ]; then curl -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" -d "chat_id=$CHAT_ID&text=🚨 Critical validation failures: {}"; fi'
```

## Success Metrics Tracking

Track these KPIs weekly:

| Metric | Target | Query Reference |
|--------|--------|----------------|
| Validation Pass Rate | >95% | Validation Safety Report |
| Average Overall Quality | >0.80 | Quality Trends |
| Critical Violations | 0 | Critical Issues Alert |
| Response Confidence | >0.75 | Current Performance Overview |
| Block Rate | <2% | Validation Safety Report |
| Low Quality Count | <5/week | Low Quality Responses |

## Troubleshooting

**High block rate**: Review "Critical Validation Failures" and check if prompt components need updating.

**Quality degradation**: Run "Identify Slow Prompts" and compare A/B test results. Update underperforming components.

**Token usage spike**: Check "Response Time Analysis" and review context optimization settings.

**Conversation coherence issues**: Verify conversation history is being stored properly with "Multi-Turn Conversation Quality".

---

**Note**: This monitoring system is designed as a free alternative to LangSmith. For production use, consider setting up automated alerting and visualization dashboards.
