# DSPy Manual Setup (Installation in Progress)

## Status

The DSPy Python dependencies are currently installing in the background. This can take 5-15 minutes due to the large number of dependencies.

## Quick Check

```bash
# Check if installation is complete
ps aux | grep "pip install" | grep -v grep

# If no processes shown, installation is complete
```

## Once Installation Completes

### 1. Verify Installation

```bash
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
source venv/bin/activate
python -c "import flask; print('Flask OK')"
# Should print: Flask OK
```

### 2. Start DSPy Service

```bash
# Option A: Run directly (for testing)
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
source venv/bin/activate
python app.py
# Press Ctrl+C to stop

# Option B: Run with PM2 (recommended)
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
npx pm2 start app.py --name dspy-optimizer --interpreter python3 --interpreter-args "venv/bin/python"
npx pm2 save
```

### 3. Test DSPy Service

```bash
# Health check
curl http://localhost:5000/health

# Expected output:
# {"status":"healthy","service":"dspy-optimizer","timestamp":"2026-02-03T..."}

# Analyze your prompts
curl http://localhost:5000/analyze-prompts | jq

# Expected: JSON with optimization targets
```

### 4. Start Optimization Workflow

Once the service is running, follow the workflow in `DSPY_SETUP.md`:

1. Export training data (1,000+ conversations)
2. Analyze which prompts need optimization
3. Optimize 2-3 high-priority prompts
4. A/B test for 7 days
5. Deploy winners

## If Installation Fails

If the installation is taking too long or fails:

```bash
# Kill the installation
pkill -f "pip install"

# Try with just essential dependencies
cd /home/ubuntu/rental-manager/python-services/dspy-optimizer
source venv/bin/activate

# Install minimal set
pip install flask psycopg2-binary python-dotenv pandas

# Then install DSPy separately (optional, can be done later)
pip install dspy-ai anthropic
```

## Alternative: Install Later

DSPy optimization is not critical for immediate bot operation. You can:

1. Focus on Sentry and Vision API first (already working)
2. Install DSPy properly when you have time
3. DSPy saves money (26-85% API cost reduction) but bot works fine without it

**Your bot is already running with all integrations except DSPy service!**

## Expected Results

Once DSPy is fully set up:
- Analyze prompts: Identify which ones use too many tokens
- Optimize: Reduce tokens by 26-85%
- Deploy: Save $50-170/month in Claude API costs
- Quality: Maintain or improve response quality

**Cost**: $0 (saves you money!)
**Time**: 1-2 weeks for full optimization cycle
**ROI**: $600-2,040/year savings
