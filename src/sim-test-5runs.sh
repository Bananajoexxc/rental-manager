#!/bin/bash
# 5-scenario simulation test: 100 messages total (20 per scenario)
# Each scenario tests different rental situations

API="http://localhost:3000/api/chat"
RESULTS_DIR="/home/ubuntu/rental-manager/src/sim-results"
mkdir -p "$RESULTS_DIR"

clear_history() {
  node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.conversation.deleteMany({ where: { chat_id: 'dashboard' } }).then(() => prisma.\$disconnect());
"
  sleep 1
}

send_msg() {
  local num="$1"
  local renter_msg="$2"
  local file="$3"
  echo "=== MESSAGE $num ===" >> "$file"
  echo "RENTER: $renter_msg" >> "$file"

  local wrapped="SIMULATION TEST: A renter just sent this message on the DB Cinema Rentals Hygglo account. Draft the EXACT reply you would send to them as Daniel. Do NOT add any preamble or explanation, just the reply text itself. Renter message: ${renter_msg}"

  local payload
  payload=$(jq -n --arg m "$wrapped" '{message: $m}')

  local response
  response=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d "$payload" --max-time 60)
  local reply
  reply=$(echo "$response" | jq -r '.reply // .error // "NO RESPONSE"')

  echo "BOT REPLY: $reply" >> "$file"
  echo "" >> "$file"
}

# ═══════════════════════════════════════════════════════════════
# SCENARIO 1: Wedding Videographer
# High-value multi-day rental, FX3 + audio + gimbal, delivery
# Tests: pricing, contextual recs, delivery, no downselling
# ═══════════════════════════════════════════════════════════════
echo "=== SCENARIO 1: Wedding Videographer ==="
clear_history
FILE="$RESULTS_DIR/scenario1-wedding.txt"
> "$FILE"
echo "SCENARIO 1: Wedding Videographer - High-value multi-day" >> "$FILE"
echo "Started at $(date)" >> "$FILE"
echo "" >> "$FILE"

send_msg 1 "Hey, I need to rent camera gear for a wedding next weekend. Friday to Monday." "$FILE"
send_msg 2 "I was thinking the Sony FX3. What comes with it?" "$FILE"
send_msg 3 "How much would Friday to Monday be for the FX3?" "$FILE"
send_msg 4 "What lens do you recommend for wedding videography?" "$FILE"
send_msg 5 "I'll take the 24-70mm GM. Do you have a wireless mic too?" "$FILE"
send_msg 6 "Yeah add the Rode wireless. How much is everything together now?" "$FILE"
send_msg 7 "I also want a gimbal. Which one works with the FX3?" "$FILE"
send_msg 8 "Add the RS3 Pro. Can I pick up Thursday evening instead of Friday?" "$FILE"
send_msg 9 "What's the total now with the gimbal and Thursday pickup?" "$FILE"
send_msg 10 "I'm based in Canary Wharf. Can you deliver?" "$FILE"
send_msg 11 "What would delivery cost to E14?" "$FILE"
send_msg 12 "Actually I want to add a second camera. Do you have another FX3?" "$FILE"
send_msg 13 "What about adding some lighting for the reception?" "$FILE"
send_msg 14 "Add the interview lighting kit. Can I return Tuesday morning instead of Monday?" "$FILE"
send_msg 15 "The 3x batteries that come with the FX3 - I want more. Can I get extra NP-FZ100s?" "$FILE"
send_msg 16 "And V-mount for the second camera. Do I need a plate for that?" "$FILE"
send_msg 17 "My address is actually in Stratford E15, not Canary Wharf. Can you update?" "$FILE"
send_msg 18 "What time can I collect on Friday if I do pickup instead of delivery?" "$FILE"
send_msg 19 "If my shoot runs late Monday, can I return Tuesday evening instead of morning?" "$FILE"
send_msg 20 "OK let me book. Can I get a total breakdown of everything?" "$FILE"

echo "Scenario 1 done at $(date)" >> "$FILE"
echo "--- Scenario 1 complete ---"

# ═══════════════════════════════════════════════════════════════
# SCENARIO 2: Student Budget Rental (Under £40)
# Single cheap item, day-before pickup, tests 30% surcharge rule
# Tests: pricing under £40, day-before rules, budget-friendly
# ═══════════════════════════════════════════════════════════════
echo "=== SCENARIO 2: Student Budget Rental ==="
clear_history
FILE="$RESULTS_DIR/scenario2-student.txt"
> "$FILE"
echo "SCENARIO 2: Student Budget Rental - Under 40 pounds" >> "$FILE"
echo "Started at $(date)" >> "$FILE"
echo "" >> "$FILE"

send_msg 1 "Hi, I'm a film student and need to rent a single lens for Saturday. The Canon EF 24-105mm." "$FILE"
send_msg 2 "How much would that be for one day?" "$FILE"
send_msg 3 "Could I pick it up Friday evening so I can start early Saturday?" "$FILE"
send_msg 4 "That's a bit steep for just a lens. Is there any way to get it cheaper?" "$FILE"
send_msg 5 "Fine. What about returning Sunday morning instead of Saturday evening?" "$FILE"
send_msg 6 "Where do I pick up from? I'm based in Camden." "$FILE"
send_msg 7 "What time Saturday morning is earliest pickup?" "$FILE"
send_msg 8 "I'm shooting a student short film in a park. Do I need anything else?" "$FILE"
send_msg 9 "Nah just the lens is fine. I have my own camera body." "$FILE"
send_msg 10 "What if something goes wrong with the lens during my shoot?" "$FILE"
send_msg 11 "OK cool. Can I also rent just a single reflector or is that too cheap?" "$FILE"
send_msg 12 "How do the Hygglo fees work? They take a cut right?" "$FILE"
send_msg 13 "Can I pay in cash when I collect?" "$FILE"
send_msg 14 "What happens if I return it late? Like an hour late?" "$FILE"
send_msg 15 "My friend also wants to borrow it after me. Can I extend and pass it to them?" "$FILE"
send_msg 16 "OK understood. What if I want Sunday AND Monday? Two day rental." "$FILE"
send_msg 17 "For the two day rental, could I pick up Saturday evening instead?" "$FILE"
send_msg 18 "And return Tuesday morning? Would that be free or extra?" "$FILE"
send_msg 19 "Actually nevermind, I'll stick with Saturday to Saturday one day. How do I book?" "$FILE"
send_msg 20 "One last thing - do you have any student discounts?" "$FILE"

echo "Scenario 2 done at $(date)" >> "$FILE"
echo "--- Scenario 2 complete ---"

# ═══════════════════════════════════════════════════════════════
# SCENARIO 3: Corporate Event - DJ + Speakers
# Delivery mandatory, multiple heavy items, evening setup
# Tests: delivery mandatory, weight rules, possessive language
# ═══════════════════════════════════════════════════════════════
echo "=== SCENARIO 3: Corporate Event DJ ==="
clear_history
FILE="$RESULTS_DIR/scenario3-corporate.txt"
> "$FILE"
echo "SCENARIO 3: Corporate Event - DJ + Speakers" >> "$FILE"
echo "Started at $(date)" >> "$FILE"
echo "" >> "$FILE"

send_msg 1 "Hi, we're hosting a corporate party next Saturday. Need DJ decks and speakers." "$FILE"
send_msg 2 "What DJ equipment do you have?" "$FILE"
send_msg 3 "The Pioneer RX3 and JBL speakers, how much for Saturday evening only?" "$FILE"
send_msg 4 "Can I pick them up myself? I have a car." "$FILE"
send_msg 5 "Oh OK. How much would delivery be to SW1A 1AA?" "$FILE"
send_msg 6 "The party is 7pm-midnight. When would delivery arrive?" "$FILE"
send_msg 7 "Can you set up the equipment as well or just drop off?" "$FILE"
send_msg 8 "I need it collected Sunday morning. What time works?" "$FILE"
send_msg 9 "The event is at a hotel in Westminster. Is that in your delivery area?" "$FILE"
send_msg 10 "Do I need to bring my own cables and adapters?" "$FILE"
send_msg 11 "We also need some party lights. What do you have for lighting effects?" "$FILE"
send_msg 12 "How much for the full lighting kit with the DJ stuff?" "$FILE"
send_msg 13 "Our IT guy says he has his own DJ controller. Can we just rent the speakers alone?" "$FILE"
send_msg 14 "What if we damage a speaker accidentally? What's the policy?" "$FILE"
send_msg 15 "Can we do a trial run with the equipment before the event? Like pick up Friday?" "$FILE"
send_msg 16 "The venue wants us out by 11am Sunday. Can I do 10am Sunday return?" "$FILE"
send_msg 17 "Actually, can we keep the speakers until Monday? Our office is nearby." "$FILE"
send_msg 18 "How do I know all your equipment works properly? Has it been tested recently?" "$FILE"
send_msg 19 "OK I think we want: JBL speakers, DJ RX3, and lighting kit. Saturday to Saturday." "$FILE"
send_msg 20 "Great, I'll book on Hygglo. Do you need any info from me beforehand?" "$FILE"

echo "Scenario 3 done at $(date)" >> "$FILE"
echo "--- Scenario 3 complete ---"

# ═══════════════════════════════════════════════════════════════
# SCENARIO 4: Documentary Filmmaker - Week-long BMPCC
# Tests: BMPCC battery count, V-mount, weekly pricing, extensions
# ═══════════════════════════════════════════════════════════════
echo "=== SCENARIO 4: Documentary Filmmaker ==="
clear_history
FILE="$RESULTS_DIR/scenario4-documentary.txt"
> "$FILE"
echo "SCENARIO 4: Documentary Filmmaker - Week BMPCC rental" >> "$FILE"
echo "Started at $(date)" >> "$FILE"
echo "" >> "$FILE"

send_msg 1 "Hi, I need to rent a BMPCC 6K Pro for a documentary. Looking at a week-long rental starting Monday." "$FILE"
send_msg 2 "What batteries does the BMPCC come with? How many?" "$FILE"
send_msg 3 "I'll need longer battery life. What V-mount options do you have?" "$FILE"
send_msg 4 "Do I need to rent plates and adapters separately for the V-mount?" "$FILE"
send_msg 5 "How much for the BMPCC plus V-mount for a full week? Monday to Sunday." "$FILE"
send_msg 6 "What lens works best with the BMPCC for documentary work?" "$FILE"
send_msg 7 "I'll take the 24-105mm. Also need a good mic for interviews." "$FILE"
send_msg 8 "What about a monitor? The BMPCC screen is quite small." "$FILE"
send_msg 9 "Add the Atomos Ninja V. What time Monday morning for pickup?" "$FILE"
send_msg 10 "Can I pick up Sunday evening to prep on Monday morning?" "$FILE"
send_msg 11 "So pickup Sunday evening is free since this is over 40 quid?" "$FILE"
send_msg 12 "Great. And if my shoot runs until Monday of the following week, what happens?" "$FILE"
send_msg 13 "Could I return Monday morning instead of Sunday evening? Would that cost extra?" "$FILE"
send_msg 14 "I'm shooting in East London, Hackney area. E8 postcode." "$FILE"
send_msg 15 "Actually my producer says we might need a second camera. Do you have the BMPCC 6K Full Frame?" "$FILE"
send_msg 16 "What comes with the Full Frame version? Same batteries as the Pro?" "$FILE"
send_msg 17 "We need SSD storage too. What options do you have?" "$FILE"
send_msg 18 "My DP also wants a DJI RS3. How much extra is that for the week?" "$FILE"
send_msg 19 "Let me get a total: BMPCC 6K Pro, V-mount, 24-105mm, Rode mic, Ninja V, RS3 Pro for 7 days." "$FILE"
send_msg 20 "Perfect. I'll book through Hygglo now. Anything else I should know?" "$FILE"

echo "Scenario 4 done at $(date)" >> "$FILE"
echo "--- Scenario 4 complete ---"

# ═══════════════════════════════════════════════════════════════
# SCENARIO 5: Music Video - Tight Timeline
# Same-day request, multiple crew, location changes, evening work
# Tests: same-day rules, location lock, timing, sub-renting
# ═══════════════════════════════════════════════════════════════
echo "=== SCENARIO 5: Music Video Production ==="
clear_history
FILE="$RESULTS_DIR/scenario5-musicvideo.txt"
> "$FILE"
echo "SCENARIO 5: Music Video - Tight timeline" >> "$FILE"
echo "Started at $(date)" >> "$FILE"
echo "" >> "$FILE"

send_msg 1 "Hey, need gear ASAP for a music video shoot. Can I rent the FX3 starting today?" "$FILE"
send_msg 2 "OK what about tomorrow then? Need FX3 plus anamorphic lenses." "$FILE"
send_msg 3 "Which anamorphic set do you have? I want the cinematic look." "$FILE"
send_msg 4 "How much for the Great Joy set plus FX3 for two days?" "$FILE"
send_msg 5 "I need it Thursday and Friday. Pick up Thursday morning." "$FILE"
send_msg 6 "We're shooting in Brixton. Is that close to your location?" "$FILE"
send_msg 7 "The director wants some drone shots too. What drones do you have?" "$FILE"
send_msg 8 "The DJI Mavic 3 Pro - how much per day?" "$FILE"
send_msg 9 "Add the drone. We need a big light for night shots. Forza 300?" "$FILE"
send_msg 10 "Pavotube lights too. Can I get the full lighting kit?" "$FILE"
send_msg 11 "How much is everything together for Thursday-Friday?" "$FILE"
send_msg 12 "My cameraman wants to pick up his stuff separately. Can he collect from you under my booking?" "$FILE"
send_msg 13 "We finish shooting at midnight Friday. When is latest return?" "$FILE"
send_msg 14 "So returning Saturday morning is free since this is well over 40 quid right?" "$FILE"
send_msg 15 "What if we need to extend to Saturday for extra shots?" "$FILE"
send_msg 16 "Actually we're now shooting in Shoreditch not Brixton. Update the location." "$FILE"
send_msg 17 "Do you have smoke machines or haze machines for the music video?" "$FILE"
send_msg 18 "Need extra memory cards. What do you have?" "$FILE"
send_msg 19 "Can I get the 3-body FX3 kit instead of single? For backup cameras." "$FILE"
send_msg 20 "OK final list: FX3 3-body kit, Great Joy anamorphics, Mavic 3, full lighting kit, Thursday to Friday. Book it." "$FILE"

echo "Scenario 5 done at $(date)" >> "$FILE"
echo "--- Scenario 5 complete ---"

echo ""
echo "All 5 scenarios complete. Results in $RESULTS_DIR/"
