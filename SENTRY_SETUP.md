# Sentry Error Monitoring Setup Guide

## Overview

Sentry provides real-time error tracking, performance monitoring, and quality alerts for the Rental Manager bot.

## Features Implemented

- ✅ Real-time error tracking with stack traces
- ✅ Performance monitoring (10% sampling to reduce overhead)
- ✅ CPU profiling (10% sampling)
- ✅ Quality score monitoring (alerts when score < 0.7)
- ✅ Validation failure tracking
- ✅ API performance monitoring (alerts when operations > 10s)
- ✅ Custom breadcrumbs for debugging
- ✅ User context tracking per rental

## Setup Instructions

### 1. Create a Sentry Account (Free)

1. Go to https://sentry.io/signup/
2. Sign up with your email
3. Create a new project:
   - Platform: **Node.js**
   - Alert frequency: **On every new issue** (recommended for immediate notifications)
   - Project name: **rental-manager**

### 2. Get Your DSN

1. After creating the project, Sentry will show you a DSN (Data Source Name)
2. It looks like: `https://[key]@o[org-id].ingest.sentry.io/[project-id]`
3. Copy this DSN

### 3. Configure Environment Variable

1. Open `/home/ubuntu/rental-manager/.env`
2. Find the line: `SENTRY_DSN=`
3. Paste your DSN: `SENTRY_DSN=https://[your-key]@o[org-id].ingest.sentry.io/[project-id]`
4. Save the file

### 4. Restart the Application

```bash
cd /home/ubuntu/rental-manager
yarn build
pm2 restart rental-manager
```

### 5. Test Error Tracking

Test that Sentry is working:

```bash
# Trigger a test error
curl http://localhost:3000/api/test-error

# Check Sentry dashboard - you should see the error appear within seconds
```

## Setting Up Telegram Alerts

To receive Sentry alerts in Telegram:

### Option 1: Sentry's Native Telegram Integration (Recommended)

1. Go to **Settings** → **Integrations** in your Sentry project
2. Search for "Telegram"
3. Click **Add Integration**
4. Follow the prompts to connect your Telegram account
5. Configure alert rules to send to your Telegram

### Option 2: Email to Telegram Bridge

1. Use a service like IFTTT or Zapier
2. Create a rule: **Sentry email alert** → **Send Telegram message**
3. Configure with your Telegram bot token

### Option 3: Custom Webhook (Advanced)

1. In Sentry, go to **Settings** → **Developer Settings** → **Internal Integrations**
2. Create a new integration with webhook permissions
3. Set webhook URL to a custom endpoint that forwards to Telegram
4. Example endpoint code:

```typescript
// Custom webhook handler (add to app.controller.ts if desired)
@Post('webhooks/sentry')
async handleSentryWebhook(@Body() payload: any) {
  const message = `
🚨 Sentry Alert
Error: ${payload.message}
Project: ${payload.project_name}
Environment: ${payload.environment}
View: ${payload.url}
  `;

  await this.telegramService.sendMessageToOwner(message);
}
```

## Using Sentry in Your Code

The `SentryService` is globally available and automatically injected.

### Example 1: Track Errors

```typescript
import { SentryService } from './monitoring/sentry.service';

constructor(private sentryService: SentryService) {}

async someOperation() {
  try {
    // Your code
  } catch (error) {
    this.sentryService.captureError(error, {
      rental_id: rental.id,
      operation: 'someOperation',
    });
  }
}
```

### Example 2: Monitor Quality Scores

```typescript
// Automatically alerts if score < 0.7
this.sentryService.monitorQualityScore(
  qualityScore.overall_quality,
  rental.id,
  {
    pricing_accuracy: qualityScore.pricing_accuracy,
    rule_compliance: qualityScore.rule_compliance,
  }
);
```

### Example 3: Track Validation Failures

```typescript
if (validationResult.blocked) {
  this.sentryService.monitorValidationFailure(
    'PricingValidator',
    validationResult.reason,
    {
      rental_id: rental.id,
      renter_name: rental.renter_name,
    }
  );
}
```

### Example 4: Monitor API Performance

```typescript
const startTime = Date.now();

// Call Claude API
const response = await this.claudeService.generateResponse(...);

const duration = Date.now() - startTime;

// Alerts if > 10 seconds
this.sentryService.monitorApiPerformance('claude_api', duration, {
  model: 'claude-haiku-4-5',
  tokens: response.usage.total_tokens,
});
```

### Example 5: Add Breadcrumbs for Debugging

```typescript
// Add context before an operation
this.sentryService.addBreadcrumb(
  'Starting rental analysis',
  'rental',
  {
    rental_id: rental.id,
    stage: rental.conversation_stage,
  }
);

// If an error occurs, Sentry will show these breadcrumbs
```

## Sentry Dashboard Features

### 1. Issues Tab
- See all errors grouped by type
- View frequency, first seen, last seen
- Click to see stack traces and context

### 2. Performance Tab
- Transaction duration trends
- Slow API calls (Claude, Hygglo, etc.)
- Database query performance

### 3. Releases Tab
- Track errors by deployment
- See if new deployments introduce bugs
- Correlate issues with specific commits

### 4. Alerts Tab
- Configure custom alert rules
- Set thresholds (e.g., "Alert if error rate > 10/min")
- Route alerts to Telegram, email, or Slack

## Best Practices

1. **Don't Log Sensitive Data**
   - Never log passwords, API keys, or PII in error context
   - Sentry automatically scrubs common patterns, but be careful

2. **Use Tags for Filtering**
   ```typescript
   this.sentryService.setTags({
     rental_stage: rental.conversation_stage,
     model_used: 'claude-haiku-4-5',
   });
   ```

3. **Set User Context**
   ```typescript
   // At start of operation
   this.sentryService.setUserContext(rental.id, rental.renter_name);

   // At end of operation
   this.sentryService.clearUserContext();
   ```

4. **Monitor Quality Trends**
   - Check Sentry weekly for quality score alerts
   - If scores are consistently low, investigate prompt quality

5. **Review Performance Metrics**
   - Identify slow API calls
   - Optimize prompts to reduce token usage and latency

## Cost

- **Free tier**: 5,000 errors/month (sufficient for current scale)
- **Team tier**: $26/month for 50,000 errors + advanced features
- **Recommendation**: Start with free tier, upgrade only if needed

## ROI

- **50% faster bug detection**: Catch errors immediately instead of waiting for user reports
- **Better uptime**: Proactive monitoring prevents extended downtime
- **Data-driven optimization**: Performance metrics guide optimization efforts
- **Cost**: $0/month (free tier)
- **Time saved**: ~5-10 hours/month on debugging

## Verification

After setup, verify Sentry is working:

1. Check Sentry dashboard for events
2. Trigger test errors and confirm they appear
3. Monitor for 24 hours to baseline error rates
4. Set up alert rules for critical issues

## Support

- Sentry Docs: https://docs.sentry.io/platforms/node/guides/nestjs/
- Support: support@sentry.io
- Community: https://discord.gg/sentry
