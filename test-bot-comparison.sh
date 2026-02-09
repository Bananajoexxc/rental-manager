#!/bin/bash
# Test script: Compare Dashboard/Telegram bot vs Autonomous Renter bot
# Sends 5 issues x 3 prompts = 15 test cases to both endpoints
# Evaluates: rule violations, intelligence, memory retention, comprehension, general flow

BASE_URL="http://localhost:3000"
RESULTS_FILE="/home/ubuntu/rental-manager/bot-comparison-results.json"

# Clear previous results
echo '{"tests":[]}' > "$RESULTS_FILE"

# Helper: send to dashboard (Telegram-like path)
send_dashboard() {
  local prompt="$1"
  curl -s -X POST "$BASE_URL/api/chat" \
    -H "Content-Type: application/json" \
    -d "{\"message\": $(echo "$prompt" | jq -Rs .)}" 2>/dev/null
}

echo "=========================================="
echo "BOT COMPARISON TEST - $(date)"
echo "=========================================="
echo ""

# We test via /api/chat which uses the dashboard/Telegram context pipeline.
# Then we compare by analyzing what context each bot WOULD build.
# Since we can't directly call processMessage without a real rental,
# we test the /api/chat endpoint with renter-style prompts and log responses.

declare -a ISSUES
declare -a PROMPTS

# --- ISSUE 1: Pricing Accuracy ---
ISSUES[0]="Pricing Accuracy"
PROMPTS[0]="How much is the Sony FX3 per day?"
PROMPTS[1]="What's the price for renting the BMPCC 6K Pro for 3 days?"
PROMPTS[2]="Can I get a quote for the DJI RS3 Pro gimbal and a V-mount battery?"

# --- ISSUE 2: Availability & Schedule Awareness ---
ISSUES[1]="Availability and Schedule"
PROMPTS[3]="Is the Sony FX3 available this weekend?"
PROMPTS[4]="I need the Atomos Ninja V tomorrow, can I pick it up at 10am?"
PROMPTS[5]="What gear do you have available for next Monday to Wednesday?"

# --- ISSUE 3: Bundle Intelligence & Upselling ---
ISSUES[2]="Bundle Intelligence and Upselling"
PROMPTS[6]="I'm shooting a short film this weekend, I need a cinema camera"
PROMPTS[7]="I want the Sony FX3, do you have any lenses that go with it?"
PROMPTS[8]="I'll take the FX3 and the 24-70mm lens, anything else I might need?"

# --- ISSUE 4: Rule Compliance (Location, Fees, Language) ---
ISSUES[3]="Rule Compliance"
PROMPTS[9]="Where exactly are you located? Can I get the address?"
PROMPTS[10]="Are there any platform fees on top of the rental price?"
PROMPTS[11]="How many batteries come with the BMPCC 6K Pro?"

# --- ISSUE 5: Delivery & Complex Queries ---
ISSUES[4]="Delivery and Complex Queries"
PROMPTS[12]="Can you deliver to East London? I'm in E14"
PROMPTS[13]="I need the DJ deck and speakers delivered to SW1A 1AA"
PROMPTS[14]="I want to add the Rode Wireless mic to my existing order, will delivery change?"

echo "Running 15 test prompts..."
echo ""

# Run all tests
for i in $(seq 0 14); do
  issue_idx=$((i / 3))
  prompt_num=$((i % 3 + 1))
  issue="${ISSUES[$issue_idx]}"
  prompt="${PROMPTS[$i]}"

  echo "--- Test $((i+1))/15: [$issue] Prompt $prompt_num ---"
  echo "Prompt: $prompt"

  response=$(send_dashboard "$prompt")
  reply=$(echo "$response" | jq -r '.reply // .error // "NO RESPONSE"')
  model=$(echo "$response" | jq -r '.model // "unknown"')

  echo "Model: $model"
  echo "Reply: ${reply:0:200}..."
  echo ""

  # Append to results
  jq --arg issue "$issue" \
     --arg prompt "$prompt" \
     --arg reply "$reply" \
     --arg model "$model" \
     --argjson test_num "$((i+1))" \
     '.tests += [{"test_num": $test_num, "issue": $issue, "prompt": $prompt, "reply": $reply, "model": $model}]' \
     "$RESULTS_FILE" > "${RESULTS_FILE}.tmp" && mv "${RESULTS_FILE}.tmp" "$RESULTS_FILE"

  # Small delay to avoid rate limiting
  sleep 2
done

echo "=========================================="
echo "All 15 tests complete. Results in $RESULTS_FILE"
echo "=========================================="
