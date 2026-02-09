#!/bin/bash
# Simulation test: 20-message renter conversation via /api/chat
# Tests all 7 behavioral rules

API="http://localhost:3000/api/chat"
RESULTS_FILE="/home/ubuntu/rental-manager/src/sim-test-results.txt"

send_msg() {
  local num="$1"
  local renter_msg="$2"
  echo "=== MESSAGE $num ===" >> "$RESULTS_FILE"
  echo "RENTER: $renter_msg" >> "$RESULTS_FILE"

  local wrapped="SIMULATION TEST: A renter just sent this message on the DB Cinema Rentals Hygglo account. Draft the EXACT reply you would send to them as Daniel. Do NOT add any preamble or explanation, just the reply text itself. Renter message: ${renter_msg}"

  local payload
  payload=$(jq -n --arg m "$wrapped" '{message: $m}')

  local response
  response=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d "$payload" --max-time 60)
  local reply
  reply=$(echo "$response" | jq -r '.reply // .error // "NO RESPONSE"')

  echo "BOT REPLY: $reply" >> "$RESULTS_FILE"
  echo "" >> "$RESULTS_FILE"
  echo "--- Done message $num ---"
}

# Clear previous results
> "$RESULTS_FILE"
echo "Starting 20-message simulation test at $(date)" >> "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

# MSG 1: Initial inquiry about FX3
send_msg 1 "Hi! I'm interested in renting a Sony FX3. Is it available this weekend?"

# MSG 2: Pricing — should trigger contextual recommendation (what are you shooting?)
send_msg 2 "Yeah this weekend, Saturday to Sunday. How much would it be?"

# MSG 3: Location — should say Central London, NOT 'my items' or 'I have it here'
send_msg 3 "Cool, where would I pick it up from?"

# MSG 4: Pickup time — should offer 10am FIRST, not evening-before
send_msg 4 "I can come Saturday morning, what times work?"

# MSG 5: Extra batteries — should NOT downsell ('you already have enough')
send_msg 5 "Can I also get some extra batteries for the FX3? I want to make sure I have plenty of power."

# MSG 6: V-mount — should say plates/adapters INCLUDED
send_msg 6 "What about a V-mount battery? Would I need any adapters or plates for that?"

# MSG 7: Contextual recommendation — should ask what they're shooting
send_msg 7 "Actually do you think I need anything else for a good setup?"

# MSG 8: Shoot type after being asked
send_msg 8 "I'm shooting a short film, mostly outdoor scenes with some dialogue"

# MSG 9: Location change mid-convo — should LOCK to original Central London
send_msg 9 "Actually I just moved to Manchester, could I pick up from there instead?"

# MSG 10: Return timing — should suggest earliest slot
send_msg 10 "When should I return the gear on Sunday?"

# MSG 11: Late return — half-day rule should apply
send_msg 11 "What if I cant make it back Sunday evening? Could I return Monday evening instead?"

# MSG 12: No downselling on extra lens
send_msg 12 "I know the FX3 comes with stuff but I want to add the 70-200mm lens as well"

# MSG 13: Pricing
send_msg 13 "How much is this all going to cost me roughly?"

# MSG 14: Delivery test — should ask postcode
send_msg 14 "Could you deliver it to me instead of me picking up?"

# MSG 15: Evening before pickup — secondary option with +50%
send_msg 15 "Actually could I get it Friday evening instead of Saturday morning?"

# MSG 16: Possessive language test — reply must NOT use 'my gear' etc
send_msg 16 "Is all your equipment in good condition? Like well maintained?"

# MSG 17: BMPCC V-mount recommendation — plates included
send_msg 17 "My friend also needs a BMPCC 6K Pro for the same shoot. Does that need a V-mount too?"

# MSG 18: Second location change — should reference original location
send_msg 18 "Oh wait I think I gave you the wrong location earlier, I am actually in Birmingham"

# MSG 19: Gimbal add-on
send_msg 19 "Do you have a gimbal I could add? Something that works with the FX3"

# MSG 20: Closing — booking flow
send_msg 20 "Sounds great, how do I go ahead and book everything?"

echo "" >> "$RESULTS_FILE"
echo "Test completed at $(date)" >> "$RESULTS_FILE"
echo "All 20 messages sent. Results in $RESULTS_FILE"
