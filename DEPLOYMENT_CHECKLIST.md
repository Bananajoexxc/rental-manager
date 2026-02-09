# Rental Bot Optimizations - Deployment Checklist

## Overview

Successfully implemented **Phase 1 (Cost Reduction & Reliability)** and **Phase 2 (Automation)** optimizations.

**Status**: ✅ Code complete, ready for configuration and deployment
**Investment**: $0-30/month
**Expected ROI**: £550-870/month ($690-1,090)

---

## Pre-Deployment Checklist

### ✅ Code Changes Complete

- [x] Sentry monitoring module created
- [x] DSPy optimization service created
- [x] Google Vision API integration completed
- [x] All modules built successfully (`yarn build`)
- [x] No TypeScript errors
- [x] All services ready for deployment

### 📦 Files Created/Modified

**New Modules**:
- `src/monitoring/` - Sentry error monitoring
- `src/vision/` - Google Vision API integration
- `python-services/dspy-optimizer/` - DSPy prompt optimization

**Documentation**:
- `SENTRY_SETUP.md` - Sentry configuration guide
- `DSPY_SETUP.md` - DSPy optimization workflow
- `VISION_SETUP.md` - Vision API setup and usage
- `IMPLEMENTATION_SUMMARY_PHASE1-2.md` - Complete implementation details
- `QUICK_START_OPTIMIZATIONS.md` - Quick setup guide
- `DEPLOYMENT_CHECKLIST.md` - This file

**Modified Files**:
- `src/main.ts` - Added Sentry initialization
- `src/app.module.ts` - Added MonitoringModule and VisionModule
- `.env` - Added configuration placeholders
- `package.json` - Added new dependencies

---

## Deployment Steps

### Phase 1: Sentry Error Monitoring (Est. 10 minutes)

#### Step 1.1: Create Sentry Account
- [ ] Go to https://sentry.io/signup/
- [ ] Sign up (FREE tier: 5,000 errors/month)
- [ ] Create a new project:
  - Platform: **Node.js**
  - Framework: **NestJS**
  - Project name: **rental-manager**

#### Step 1.2: Configure Sentry
- [ ] Copy your Sentry DSN from project settings
- [ ] Edit `/home/ubuntu/rental-manager/.env`:
  ```bash
  SENTRY_DSN=https://your-key@o-org-id.ingest.sentry.io/project-id
  ```

#### Step 1.3: Restart Application
```bash
cd /home/ubuntu/rental-manager
yarn build
pm2 restart rental-manager
```

#### Step 1.4: Verify Sentry is Working
```bash
# Check logs for Sentry initialization
pm2 logs rental-manager | grep Sentry

# Trigger test error (optional)
curl http://localhost:3000/api/test-error

# Check Sentry dashboard - error should appear within seconds
```

#### Step 1.5: Configure Alerts (Optional)
- [ ] Set up Telegram/Email alerts in Sentry project settings
- [ ] Create alert rules for critical errors
- [ ] Test alert delivery

**Expected Result**: ✅ Real-time error monitoring active

---

### Phase 2: DSPy Prompt Optimization (Est. 15 minutes)

#### Step 2.1: Install Python Dependencies
```bash
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
./setup.sh
```

#### Step 2.2: Start DSPy Service
```bash
# Option A: Run directly (for testing)
source venv/bin/activate
python app.py

# Option B: Run with PM2 (recommended for production)
pm2 start app.py --name dspy-optimizer --interpreter python3 --cwd /home/ubuntu/rental-manager/python-services/dspy-optimizer
pm2 save
```

#### Step 2.3: Verify DSPy is Running
```bash
# Check if service is running
pm2 list | grep dspy

# Test health endpoint
curl http://localhost:5000/health

# Should return: {"status":"healthy","service":"dspy-optimizer"}
```

#### Step 2.4: Initial Analysis
```bash
# Export training data
curl "http://localhost:5000/export-training-data?limit=1000" > /tmp/training_data.json

# Analyze current prompts
curl http://localhost:5000/analyze-prompts > /tmp/prompt_analysis.json

# View optimization opportunities
cat /tmp/prompt_analysis.json | jq '.optimization_targets'
```

**Expected Result**: ✅ DSPy service running, ready to optimize prompts

**Next Steps** (do this after deployment):
1. Review optimization targets
2. Optimize high-priority prompts (see `DSPY_SETUP.md`)
3. A/B test optimized versions
4. Deploy winners to production
5. Measure token reduction (target: 26-85%)

---

### Phase 3: Google Vision API (Est. 10 minutes)

#### Step 3.1: Create Google Cloud Account
- [ ] Go to https://console.cloud.google.com/
- [ ] Sign up (get **$300 free credits** for 90 days!)
- [ ] Create a new project (name: `rental-manager`)

#### Step 3.2: Enable Vision API
- [ ] In Cloud Console, go to **APIs & Services** → **Library**
- [ ] Search for "Cloud Vision API"
- [ ] Click **Enable**

#### Step 3.3: Create Service Account
- [ ] Go to **IAM & Admin** → **Service Accounts**
- [ ] Click **Create Service Account**
- [ ] Name: `rental-manager-vision`
- [ ] Role: **Cloud Vision API User**
- [ ] Click **Create and Continue** → **Done**

#### Step 3.4: Generate Credentials
- [ ] Click on the service account you created
- [ ] Go to **Keys** tab
- [ ] Click **Add Key** → **Create new key**
- [ ] Key type: **JSON**
- [ ] Click **Create**
- [ ] Save downloaded file as `/home/ubuntu/rental-manager-vision-key.json`

```bash
# Move key to correct location (if needed)
mv ~/Downloads/your-key-name.json /home/ubuntu/rental-manager-vision-key.json

# Set correct permissions
chmod 600 /home/ubuntu/rental-manager-vision-key.json
chown ubuntu:ubuntu /home/ubuntu/rental-manager-vision-key.json
```

#### Step 3.5: Configure Application
- [ ] Verify `.env` has correct path:
  ```bash
  GOOGLE_APPLICATION_CREDENTIALS=/home/ubuntu/rental-manager-vision-key.json
  ```

#### Step 3.6: Restart Application
```bash
cd /home/ubuntu/rental-manager
yarn build
pm2 restart rental-manager
```

#### Step 3.7: Verify Vision API is Working
```bash
# Check logs for Vision API initialization
pm2 logs rental-manager | grep Vision

# Should see: "✅ Google Vision API initialized"
# If you see warning instead, Vision API is disabled (not critical)
```

**Expected Result**: ✅ Vision API active, ready to analyze photos

**Next Steps** (do this after deployment):
1. Test with sample equipment photos
2. Calibrate damage thresholds for your equipment
3. Integrate into autonomous service (see `VISION_SETUP.md`)
4. Monitor accuracy and adjust as needed

---

## Post-Deployment Verification

### 1. Check All Services Are Running
```bash
pm2 list

# Should show:
# - rental-manager (running)
# - dspy-optimizer (running)
```

### 2. Verify Each Module

**Sentry**:
```bash
# Check Sentry dashboard: https://sentry.io/
# Should show zero or few events initially
```

**DSPy**:
```bash
curl http://localhost:5000/health
# Should return: {"status":"healthy"}
```

**Vision API**:
```bash
pm2 logs rental-manager --lines 20 | grep Vision
# Should see: "✅ Google Vision API initialized"
```

### 3. Monitor for Issues
```bash
# Watch logs for any errors
pm2 logs rental-manager --lines 50

# If you see any errors, check:
# - Environment variables: cat .env
# - File permissions: ls -la /home/ubuntu/rental-manager-vision-key.json
# - Service status: pm2 list
```

---

## Rollback Plan

If something goes wrong, you can rollback:

### Option 1: Disable Individual Features

**Disable Sentry** (if causing issues):
```bash
# Remove DSN from .env
sed -i 's/^SENTRY_DSN=.*$/SENTRY_DSN=/' /home/ubuntu/rental-manager/.env
pm2 restart rental-manager
```

**Disable DSPy** (if not needed yet):
```bash
pm2 stop dspy-optimizer
pm2 delete dspy-optimizer
```

**Disable Vision API** (if causing issues):
```bash
# Remove credentials path from .env
sed -i 's/^GOOGLE_APPLICATION_CREDENTIALS=.*$/GOOGLE_APPLICATION_CREDENTIALS=/' /home/ubuntu/rental-manager/.env
pm2 restart rental-manager
```

### Option 2: Full Rollback

```bash
# Restore from backup (if you created one)
cd /home/ubuntu
rm -rf rental-manager
cp -r rental-manager-backup rental-manager
cd rental-manager
yarn install
yarn build
pm2 restart rental-manager
```

**Note**: All new code is backward-compatible. If credentials are not provided, services will gracefully disable themselves without breaking existing functionality.

---

## Success Metrics (Track These)

### Week 1 (Initial Setup)
- [ ] Sentry capturing errors: Yes/No
- [ ] DSPy service running: Yes/No
- [ ] Vision API initialized: Yes/No
- [ ] No critical errors introduced: Yes/No

### Week 2-4 (Optimization)
- [ ] Optimized 1+ prompts with DSPy
- [ ] A/B tested optimized versions
- [ ] Measured token reduction: _____%
- [ ] Vision API tested with sample photos
- [ ] Damage detection accuracy: ____%

### Month 1 (ROI)
- [ ] Claude API cost reduction: $____ (target: $50-170)
- [ ] Manual photo review time saved: ____ hours (target: 10-20h)
- [ ] Errors caught by Sentry: ____
- [ ] Downtime prevented: ____ hours

### Month 2-3 (Scaling)
- [ ] All prompts optimized
- [ ] Vision API integrated into workflows
- [ ] Total monthly savings: £____ (target: £550-870)
- [ ] ROI achieved: Yes/No

---

## Cost Tracking

### Current Month Spend

| Service | Budget | Actual | Notes |
|---------|--------|--------|-------|
| Sentry | $0 | $____ | Free tier: 5,000 errors |
| DSPy | $0 | $____ | Free (uses Claude API) |
| Vision API | $0-30 | $____ | Free tier: 1,000 images |
| **TOTAL** | **$0-30** | **$____** | |

### Savings Achieved

| Category | Target | Actual | Notes |
|----------|--------|--------|-------|
| Claude API | -$50-170 | -$____ | Token reduction from DSPy |
| Manual work | -£400 | -£____ | Photo review automation |
| Downtime | -£100-300 | -£____ | Faster bug fixes |
| **TOTAL** | **£550-870** | **£____** | |

---

## Support & Resources

### Documentation
- **Quick Start**: `QUICK_START_OPTIMIZATIONS.md`
- **Sentry Setup**: `SENTRY_SETUP.md`
- **DSPy Workflow**: `DSPY_SETUP.md`
- **Vision API**: `VISION_SETUP.md`
- **Full Summary**: `IMPLEMENTATION_SUMMARY_PHASE1-2.md`

### External Resources
- Sentry Docs: https://docs.sentry.io/platforms/node/guides/nestjs/
- DSPy Docs: https://dspy-docs.vercel.app/
- Vision API Docs: https://cloud.google.com/vision/docs

### Getting Help
1. Check relevant documentation file
2. Review logs: `pm2 logs rental-manager`
3. Check service status: `pm2 list`
4. Verify environment variables: `cat .env`
5. Test individual endpoints/services

---

## Completion Checklist

### Pre-Deployment
- [x] Code implemented
- [x] Build successful
- [x] Documentation created
- [ ] Credentials obtained (Sentry, Google Cloud)

### Deployment
- [ ] Sentry configured
- [ ] DSPy service running
- [ ] Vision API credentials added
- [ ] Application restarted
- [ ] All services verified

### Post-Deployment
- [ ] Monitor for 24 hours
- [ ] No critical errors
- [ ] Begin prompt optimization
- [ ] Test Vision API with samples
- [ ] Track costs and savings

### Month 1
- [ ] Optimize high-priority prompts
- [ ] Integrate Vision API workflows
- [ ] Measure actual ROI
- [ ] Document lessons learned

---

## Status: Ready for Deployment ✅

**What's Complete**:
- ✅ All code implemented and tested
- ✅ Build successful (no errors)
- ✅ Documentation comprehensive
- ✅ Services ready for configuration

**What's Needed**:
- ⏳ Sentry account setup (10 min)
- ⏳ DSPy service start (5 min)
- ⏳ Google Cloud credentials (10 min)

**Estimated Time to Go Live**: 25-30 minutes

**Ready to deploy!** 🚀

Follow the steps above, or start with the Quick Start guide: `QUICK_START_OPTIMIZATIONS.md`
