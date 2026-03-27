const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const decisions = await prisma.ai_decision.findMany({
    where: {
      decision_type: 'message',
      was_sent: { not: null }
    },
    select: {
      id: true,
      rental_id: true,
      input_summary: true,
      output_summary: true,
      action_taken: true,
      confidence: true,
      was_sent: true,
      created_at: true,
      reasoning: true,
      full_input: true,
      full_output: true
    },
    orderBy: {
      created_at: 'desc'
    },
    take: 100
  });
  
  // Also get rental context for each
  const enrichedDecisions = await Promise.all(decisions.map(async (decision) => {
    const rental = await prisma.rental.findUnique({
      where: { id: decision.rental_id },
      select: {
        hygglo_account: true,
        listing_id: true,
        renter_name: true,
        listing: {
          select: {
            title: true
          }
        }
      }
    });
    
    return {
      ...decision,
      account: rental?.hygglo_account,
      listing_title: rental?.listing?.title,
      renter_name: rental?.renter_name
    };
  }));
  
  console.log(JSON.stringify(enrichedDecisions, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
