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
      created_at: true
    },
    orderBy: {
      created_at: 'desc'
    },
    take: 100
  });
  
  console.log(JSON.stringify(decisions, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
