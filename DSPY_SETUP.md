# DSPy Prompt Optimization Setup Guide

## Overview

DSPy (Declarative Self-improving Language Programs) is Stanford's framework for optimizing AI prompts using machine learning. This service reduces Claude API costs by **26-85%** while maintaining or improving response quality.

## What DSPy Does

- **Analyzes** historical conversation data from your database
- **Learns** optimal prompt patterns from quality scores
- **Optimizes** prompts to be shorter while maintaining effectiveness
- **A/B tests** different prompt versions automatically
- **Monitors** token usage and quality metrics

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│  Rental Manager │ ◄────── │  DSPy Optimizer  │
│   (NestJS)      │         │   (Python/Flask) │
│                 │         │   Port: 5000     │
│  - Prompts      │         │                  │
│  - AI decisions │         │  - Training      │
│  - Quality logs │ ──────► │  - Optimization  │
└─────────────────┘         │  - A/B Testing   │
                            └──────────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │  PostgreSQL  │
                              │  - ai_decision
                              │  - response_quality
                              │  - prompt_component
                              └──────────────┘
```

## Setup Instructions

### 1. Install Python Dependencies

```bash
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
./setup.sh
```

This will:
- Create a Python virtual environment
- Install DSPy, Flask, psycopg2, and dependencies
- Takes ~2-3 minutes

### 2. Configure Environment

The service automatically reads from `/home/ubuntu/rental-manager/.env`:

```bash
# Already configured:
DATABASE_URL=postgresql://ai:ai@localhost:5432/rental_manager
ANTHROPIC_API_KEY=your_key
CLAUDE_MODEL_COMPLEX=claude-sonnet-4-5-20250929

# Optional: Change DSPy port (default: 5000)
DSPY_PORT=5000
```

### 3. Start the Service

```bash
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
source venv/bin/activate
python app.py
```

The service will start on http://localhost:5000

### 4. Run as Background Service (Recommended)

Use PM2 to keep it running:

```bash
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
pm2 start app.py --name dspy-optimizer --interpreter python3
pm2 save
```

Verify it's running:
```bash
pm2 list
curl http://localhost:5000/health
```

## API Endpoints

### 1. Health Check

```bash
curl http://localhost:5000/health
```

Response:
```json
{
  "status": "healthy",
  "service": "dspy-optimizer",
  "timestamp": "2026-02-03T20:00:00"
}
```

### 2. Export Training Data

Export historical conversations for analysis:

```bash
curl "http://localhost:5000/export-training-data?limit=1000&min_quality=0.5&days_back=90"
```

Parameters:
- `limit`: Number of records (default: 1000)
- `min_quality`: Minimum quality score (default: 0.5)
- `days_back`: Days to look back (default: 90)

Response:
```json
{
  "success": true,
  "count": 1000,
  "data": [...],
  "stats": {
    "avg_quality": 0.85,
    "blocked_rate": 0.03,
    "avg_confidence": 0.88
  }
}
```

### 3. Analyze Current Prompts

Get optimization recommendations:

```bash
curl http://localhost:5000/analyze-prompts
```

Response:
```json
{
  "success": true,
  "components": [
    {
      "name": "pricing_domain",
      "version": "v2.0",
      "usage_count": 450,
      "avg_quality": 0.87,
      "avg_tokens": 350
    }
  ],
  "avg_tokens_per_interaction": 425,
  "potential_token_savings": 212,
  "optimization_targets": [
    {
      "component": "pricing_domain",
      "priority": "high",
      "reason": "High token usage (350 avg tokens)"
    }
  ]
}
```

### 4. Optimize a Specific Prompt

```bash
curl -X POST http://localhost:5000/optimize-prompt \
  -H "Content-Type: application/json" \
  -d '{
    "component_name": "pricing_domain",
    "current_prompt": "You are a rental manager for high-end camera equipment...",
    "target_quality": 0.85
  }'
```

Response:
```json
{
  "success": true,
  "component_name": "pricing_domain",
  "original_tokens": 350,
  "optimized_tokens": 180,
  "token_reduction_pct": 48.6,
  "optimization_result": "...",
  "estimated_monthly_savings": {
    "monthly_savings_usd": 97.20,
    "annual_savings_usd": 1166.40,
    "roi_vs_dspy_cost": "infinite (DSPy is free)"
  }
}
```

### 5. A/B Test Prompt Versions

Compare two versions:

```bash
curl -X POST http://localhost:5000/compare-versions \
  -H "Content-Type: application/json" \
  -d '{
    "component_name": "pricing_domain",
    "version_a": "v2.0",
    "version_b": "v3.0-optimized",
    "days_back": 7
  }'
```

Response:
```json
{
  "success": true,
  "component_name": "pricing_domain",
  "comparison": {
    "v2.0": {
      "total_uses": 120,
      "avg_quality": 0.84,
      "avg_tokens": 350
    },
    "v3.0-optimized": {
      "total_uses": 130,
      "avg_quality": 0.86,
      "avg_tokens": 180
    }
  },
  "winner": "v3.0-optimized",
  "recommendation": "Deploy v3.0-optimized to production"
}
```

## Integration with NestJS

Create a DSPy service in your NestJS app to call the Python microservice:

```typescript
// src/optimization/dspy-client.service.ts
import { Injectable, HttpService } from '@nestjs/common';

@Injectable()
export class DspyClientService {
  private readonly dspyUrl = 'http://localhost:5000';

  constructor(private httpService: HttpService) {}

  async analyzePrompts() {
    const response = await this.httpService
      .get(`${this.dspyUrl}/analyze-prompts`)
      .toPromise();
    return response.data;
  }

  async optimizePrompt(componentName: string, currentPrompt: string) {
    const response = await this.httpService
      .post(`${this.dspyUrl}/optimize-prompt`, {
        component_name: componentName,
        current_prompt: currentPrompt,
        target_quality: 0.85,
      })
      .toPromise();
    return response.data;
  }

  async compareVersions(componentName: string, versionA: string, versionB: string) {
    const response = await this.httpService
      .post(`${this.dspyUrl}/compare-versions`, {
        component_name: componentName,
        version_a: versionA,
        version_b: versionB,
        days_back: 7,
      })
      .toPromise();
    return response.data;
  }
}
```

## Optimization Workflow

### Phase 1: Baseline Analysis (Week 1)

1. **Export training data**:
   ```bash
   curl "http://localhost:5000/export-training-data?limit=1000" > training_data.json
   ```

2. **Analyze current prompts**:
   ```bash
   curl http://localhost:5000/analyze-prompts > prompt_analysis.json
   ```

3. **Identify optimization targets**:
   - Look for components with high token usage (>200 tokens)
   - Focus on frequently used components (usage_count > 100)
   - Prioritize components with good quality scores (>0.80)

### Phase 2: Optimize High-Priority Prompts (Week 1-2)

For each target component:

1. **Get current prompt** from database or `src/prompts/`
2. **Call optimize-prompt** endpoint
3. **Review optimization**:
   - Token reduction: Target 26-85%
   - Quality impact: Ensure no critical information lost
   - Clarity: Check if optimized version is clearer

4. **Deploy optimized version**:
   ```typescript
   // In PromptManagerService
   await this.createPromptComponent({
     name: 'pricing_domain',
     version: 'v3.0-optimized',
     content: optimizedPrompt,
     category: 'domain',
     ab_group: 'B',  // A/B test against current version
   });
   ```

### Phase 3: A/B Testing (Week 2-3)

1. **Enable A/B testing** in PromptManagerService:
   - 50% traffic to old version (A)
   - 50% traffic to new version (B)

2. **Monitor for 7 days**:
   ```bash
   curl -X POST http://localhost:5000/compare-versions \
     -H "Content-Type: application/json" \
     -d '{"component_name": "pricing_domain", "version_a": "v2.0", "version_b": "v3.0-optimized"}'
   ```

3. **Analyze results**:
   - Quality scores similar or better?
   - Token reduction as expected?
   - No increase in validation failures?

4. **Deploy winner**:
   - If B wins: Set `ab_group = null`, `active = true` for v3.0-optimized
   - If A wins: Revise optimization approach and retry

### Phase 4: Full Rollout (Week 3-4)

1. **Optimize all 12 prompt components**
2. **Track metrics**:
   - Total token reduction
   - Monthly API cost savings
   - Quality score trends
3. **Iterate**:
   - Re-optimize every 3 months as data grows
   - Continuously improve with new training data

## Expected Results

### Token Reduction Targets

| Component | Current Tokens | Target Tokens | Reduction % |
|-----------|----------------|---------------|-------------|
| pricing_domain | 350 | 180 | 48% |
| availability | 280 | 140 | 50% |
| communication_style | 200 | 120 | 40% |
| rules_base | 400 | 200 | 50% |
| context_summary | 180 | 90 | 50% |
| **TOTAL** | **1410** | **730** | **48%** |

### Cost Savings

- **Current API spend**: $200/month
- **Token reduction**: 48% (conservative estimate)
- **New API spend**: $104/month
- **Monthly savings**: $96/month
- **Annual savings**: $1,152/year
- **ROI**: Infinite (DSPy is free)

### Quality Metrics

- **Quality scores**: Maintain >0.80 average
- **Validation pass rate**: Maintain >95%
- **Confidence**: Maintain >0.85 average
- **Blocked rate**: Keep <5%

## Monitoring & Maintenance

### Daily (Automated)

- Track token usage via Sentry
- Monitor quality scores via PostHog
- Alert if quality drops below 0.75

### Weekly

- Review optimization metrics:
  ```bash
  curl http://localhost:5000/analyze-prompts
  ```
- Check A/B test results
- Adjust underperforming prompts

### Monthly

- Export fresh training data
- Re-optimize prompts with new data
- Calculate actual cost savings
- Report ROI

### Quarterly

- Full optimization cycle for all components
- Update DSPy framework (pip install --upgrade dspy-ai)
- Review and adjust quality thresholds

## Troubleshooting

### Service won't start

```bash
# Check Python version
python3 --version  # Should be 3.8+

# Check dependencies
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
source venv/bin/activate
pip list | grep dspy

# Check logs
tail -f logs/dspy.log
```

### Database connection errors

```bash
# Verify DATABASE_URL in .env
psql $DATABASE_URL -c "SELECT COUNT(*) FROM ai_decision"

# Check if PostgreSQL is running
sudo systemctl status postgresql
```

### Low token reduction (<26%)

- Use more training data (increase limit to 2000+)
- Lower min_quality threshold to 0.4 (more examples)
- Manually review prompts for redundancy
- Try optimizing in multiple iterations

### Quality score drops

- Revert to previous version immediately
- Analyze what was removed from optimized prompt
- Re-optimize with higher target_quality (0.90+)
- Add critical information back manually

## Advanced: Full DSPy Training Pipeline

The current implementation uses Claude to suggest optimizations. For more advanced optimization, implement DSPy's training pipeline:

```python
import dspy
from dspy.teleprompt import BootstrapFewShot

# 1. Define optimization metric
def quality_metric(example, prediction):
    return prediction.quality_score > 0.85

# 2. Load training data
training_data = load_from_database()

# 3. Optimize prompt
optimizer = BootstrapFewShot(metric=quality_metric)
optimized_prompt = optimizer.compile(
    student=current_prompt,
    trainset=training_data
)

# 4. Evaluate
results = evaluate(optimized_prompt, test_set)
print(f"Token reduction: {results.token_reduction}%")
print(f"Quality: {results.avg_quality}")
```

See `src/optimization/dspy-training.py` for full implementation (to be added).

## Support

- DSPy Docs: https://dspy-docs.vercel.app/
- GitHub: https://github.com/stanfordnlp/dspy
- Community: https://discord.gg/dspy

## Cost

- **DSPy framework**: FREE (open-source)
- **Python/Flask service**: FREE (self-hosted)
- **Training cost**: Uses your existing Claude API (minimal usage during optimization)
- **Monthly cost**: $0

## ROI Summary

- **Investment**: 6-8 days setup + $0/month
- **Return**: $96-170/month in API savings
- **Payback period**: Immediate
- **Annual ROI**: $1,152-2,040/year

**Recommendation**: This is the highest-ROI tool in the entire plan. Start here!
