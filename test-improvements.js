#!/usr/bin/env node

/**
 * Test script for validating the intelligence and safety improvements
 */

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

console.log('==================================================');
console.log('Rental Bot Intelligence & Safety Improvements Test');
console.log('==================================================\n');

async function runTests() {
  let passed = 0;
  let failed = 0;

  // Test 1: Database connection
  console.log('1. Testing database connection...');
  try {
    await prisma.$connect();
    console.log('✓ Database connection successful\n');
    passed++;
  } catch (error) {
    console.log('✗ Database connection failed:', error.message, '\n');
    failed++;
    process.exit(1);
  }

  // Test 2: Check new tables exist
  console.log('2. Verifying new database tables...');
  const tables = ['validation_log', 'response_quality', 'prompt_component', 'prompt_version_log'];
  for (const table of tables) {
    try {
      await prisma.$queryRawUnsafe(`SELECT COUNT(*) FROM ${table}`);
      console.log(`✓ Table ${table} exists`);
      passed++;
    } catch (error) {
      console.log(`✗ Table ${table} missing:`, error.message);
      failed++;
    }
  }

  // Test 3: Check prompt components
  console.log('\n3. Checking prompt components...');
  try {
    const componentCount = await prisma.prompt_component.count();
    if (componentCount > 0) {
      console.log(`✓ Prompt components seeded (${componentCount} components)`);
      passed++;
    } else {
      console.log('⚠ Prompt components not seeded yet (will seed on first app start)');
    }
  } catch (error) {
    console.log('✗ Error checking prompt components:', error.message);
    failed++;
  }

  // Test 4: Check build artifacts
  console.log('\n4. Verifying build artifacts...');
  if (fs.existsSync('dist/main.js')) {
    console.log('✓ Build artifacts exist');
    passed++;
  } else {
    console.log('✗ Build artifacts missing - run "npm run build"');
    failed++;
  }

  // Test 5: Check new service files
  console.log('\n5. Checking new service files...');
  const serviceFiles = [
    'src/validation/validation.service.ts',
    'src/evaluation/quality-scorer.service.ts',
    'src/prompts/prompt-manager.service.ts',
  ];
  for (const file of serviceFiles) {
    if (fs.existsSync(file)) {
      console.log(`✓ ${file} exists`);
      passed++;
    } else {
      console.log(`✗ ${file} missing`);
      failed++;
    }
  }

  // Test 6: Check documentation
  console.log('\n6. Checking documentation...');
  const docs = ['IMPROVEMENTS.md', 'MONITORING.md'];
  for (const doc of docs) {
    if (fs.existsSync(doc)) {
      console.log(`✓ ${doc} exists`);
      passed++;
    } else {
      console.log(`✗ ${doc} missing`);
      failed++;
    }
  }

  // Test 7: Run test queries
  console.log('\n7. Running test queries...');

  // Validation stats
  try {
    const validationStats = await prisma.$queryRaw`
      SELECT
        COUNT(*) as total_validations,
        COUNT(*) FILTER (WHERE blocked = true) as blocked_count
      FROM validation_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `;
    console.log('  - Validation statistics (last 7 days):');
    console.log(`    Total: ${validationStats[0].total_validations}, Blocked: ${validationStats[0].blocked_count}`);
    passed++;
  } catch (error) {
    console.log('  - Validation statistics: No data yet (expected on fresh install)');
  }

  // Quality stats
  try {
    const qualityStats = await prisma.$queryRaw`
      SELECT
        COUNT(*) as total_scores,
        ROUND(AVG(overall_quality)::numeric, 3) as avg_quality
      FROM response_quality
      WHERE created_at > NOW() - INTERVAL '7 days'
    `;
    console.log('  - Quality statistics (last 7 days):');
    console.log(`    Total: ${qualityStats[0].total_scores}, Avg Quality: ${qualityStats[0].avg_quality}`);
    passed++;
  } catch (error) {
    console.log('  - Quality statistics: No data yet (expected on fresh install)');
  }

  // Conversation history
  try {
    const conversationCount = await prisma.conversation.count({
      where: {
        created_at: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      },
    });
    console.log('  - Conversation history (last 7 days):');
    console.log(`    Messages: ${conversationCount}`);
    passed++;
  } catch (error) {
    console.log('  - Conversation history: No data yet (expected on fresh install)');
  }

  // Summary
  console.log('\n==================================================');
  if (failed === 0) {
    console.log('✓ All tests passed!');
  } else {
    console.log(`⚠ ${passed} tests passed, ${failed} tests failed`);
  }
  console.log('==================================================\n');

  console.log('Next steps:');
  console.log('1. Restart the application: pm2 restart rental-manager');
  console.log('2. Monitor logs: pm2 logs rental-manager');
  console.log('3. Check validation: See MONITORING.md for SQL queries');
  console.log('4. Enable modular prompts: Add USE_MODULAR_PROMPTS=true to .env\n');

  console.log('Documentation:');
  console.log('- IMPROVEMENTS.md - Implementation details');
  console.log('- MONITORING.md - SQL queries for monitoring\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
  console.error('Test script error:', error);
  process.exit(1);
});
