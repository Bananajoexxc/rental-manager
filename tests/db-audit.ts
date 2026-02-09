import * as dotenv from 'dotenv';
dotenv.config({ path: '/home/ubuntu/rental-manager/.env' });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`DATABASE AUDIT — ${new Date().toISOString()}`);
  console.log(`Today: ${today.toISOString().split('T')[0]}`);
  console.log(`${'='.repeat(80)}\n`);

  // ─── 1. CONFIRMED ONGOING (start_date <= today AND end_date >= today) by account ───
  console.log('─── 1. CONFIRMED ONGOING BOOKINGS (by account) ───');
  const ongoing = await prisma.booking.groupBy({
    by: ['account'],
    where: {
      status: 'confirmed',
      start_date: { lte: todayEnd },
      end_date: { gte: today },
    },
    _count: true,
  });
  ongoing.forEach(r => console.log(`  ${r.account}: ${r._count}`));
  const totalOngoing = ongoing.reduce((s, r) => s + r._count, 0);
  console.log(`  TOTAL: ${totalOngoing}\n`);

  // ─── 2. CONFIRMED UPCOMING (start_date > today) by account ───
  console.log('─── 2. CONFIRMED UPCOMING BOOKINGS (by account) ───');
  const upcoming = await prisma.booking.groupBy({
    by: ['account'],
    where: {
      status: 'confirmed',
      start_date: { gt: todayEnd },
    },
    _count: true,
  });
  upcoming.forEach(r => console.log(`  ${r.account}: ${r._count}`));
  const totalUpcoming = upcoming.reduce((s, r) => s + r._count, 0);
  console.log(`  TOTAL: ${totalUpcoming}\n`);

  // ─── 3. ALL BOOKINGS grouped by status ───
  console.log('─── 3. ALL BOOKINGS BY STATUS ───');
  const byStatus = await prisma.booking.groupBy({
    by: ['status'],
    _count: true,
  });
  byStatus.forEach(r => console.log(`  ${r.status}: ${r._count}`));
  const totalAll = byStatus.reduce((s, r) => s + r._count, 0);
  console.log(`  TOTAL: ${totalAll}\n`);

  // ─── 4. February 2026 revenue (CONFIRMED only) ───
  console.log('─── 4. FEBRUARY 2026 REVENUE (confirmed bookings) ───');
  const feb2026Start = new Date('2026-02-01T00:00:00.000Z');
  const feb2026End = new Date('2026-02-28T23:59:59.999Z');
  const febRevRaw = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { gte: feb2026Start, lte: feb2026End },
    },
    select: { item_name: true, renter_name: true, start_date: true, revenue: true, account: true },
  });
  // Deduplicate by item_name + renter_name + start_date (keep highest revenue)
  const febDeduped = dedup(febRevRaw);
  const febTotalRev = febDeduped.reduce((s, r) => s + (r.revenue || 0), 0);
  console.log(`  Raw count: ${febRevRaw.length}, Deduped count: ${febDeduped.length}`);
  console.log(`  Total revenue (deduped): £${febTotalRev.toFixed(2)}`);
  // By account
  const febByAccount: Record<string, number> = {};
  febDeduped.forEach(r => {
    febByAccount[r.account] = (febByAccount[r.account] || 0) + (r.revenue || 0);
  });
  Object.entries(febByAccount).forEach(([a, v]) => console.log(`    ${a}: £${v.toFixed(2)}`));
  console.log();

  // ─── 5. January + December revenue ───
  console.log('─── 5. JANUARY + DECEMBER REVENUE (confirmed bookings) ───');
  const jan2026Start = new Date('2026-01-01T00:00:00.000Z');
  const jan2026End = new Date('2026-01-31T23:59:59.999Z');
  const janRevRaw = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { gte: jan2026Start, lte: jan2026End },
    },
    select: { item_name: true, renter_name: true, start_date: true, revenue: true, account: true },
  });
  const janDeduped = dedup(janRevRaw);
  const janTotal = janDeduped.reduce((s, r) => s + (r.revenue || 0), 0);
  console.log(`  January 2026: £${janTotal.toFixed(2)} (${janDeduped.length} bookings, ${janRevRaw.length} raw)`);

  const dec2025Start = new Date('2025-12-01T00:00:00.000Z');
  const dec2025End = new Date('2025-12-31T23:59:59.999Z');
  const decRevRaw = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { gte: dec2025Start, lte: dec2025End },
    },
    select: { item_name: true, renter_name: true, start_date: true, revenue: true, account: true },
  });
  const decDeduped = dedup(decRevRaw);
  const decTotal = decDeduped.reduce((s, r) => s + (r.revenue || 0), 0);
  console.log(`  December 2025: £${decTotal.toFixed(2)} (${decDeduped.length} bookings, ${decRevRaw.length} raw)\n`);

  // ─── 6. LIST ONGOING RENTALS (confirmed, start <= today, end >= today) ───
  console.log('─── 6. ONGOING RENTALS (detailed) ───');
  const ongoingList = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { lte: todayEnd },
      end_date: { gte: today },
    },
    select: { item_name: true, renter_name: true, start_date: true, end_date: true, revenue: true, account: true },
    orderBy: [{ account: 'asc' }, { start_date: 'asc' }],
  });
  let currentAccount = '';
  ongoingList.forEach(b => {
    if (b.account !== currentAccount) {
      currentAccount = b.account;
      console.log(`\n  === ${b.account.toUpperCase()} ===`);
    }
    const sd = b.start_date.toISOString().split('T')[0];
    const ed = b.end_date.toISOString().split('T')[0];
    console.log(`  ${b.item_name.padEnd(35)} | ${b.renter_name.padEnd(20)} | ${sd} → ${ed} | £${(b.revenue || 0).toFixed(2)}`);
  });
  console.log();

  // ─── 7. LIST UPCOMING RENTALS (confirmed, start > today) ───
  console.log('─── 7. UPCOMING RENTALS (detailed) ───');
  const upcomingList = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { gt: todayEnd },
    },
    select: { item_name: true, renter_name: true, start_date: true, end_date: true, revenue: true, account: true },
    orderBy: [{ account: 'asc' }, { start_date: 'asc' }],
  });
  currentAccount = '';
  upcomingList.forEach(b => {
    if (b.account !== currentAccount) {
      currentAccount = b.account;
      console.log(`\n  === ${b.account.toUpperCase()} ===`);
    }
    const sd = b.start_date.toISOString().split('T')[0];
    const ed = b.end_date.toISOString().split('T')[0];
    console.log(`  ${b.item_name.padEnd(35)} | ${b.renter_name.padEnd(20)} | ${sd} → ${ed} | £${(b.revenue || 0).toFixed(2)}`);
  });
  console.log();

  // ─── 8. DUPLICATE BOOKINGS (same item_name + renter_name + start_date) ───
  console.log('─── 8. DUPLICATE BOOKINGS ───');
  const allBookings = await prisma.booking.findMany({
    select: { id: true, item_name: true, renter_name: true, start_date: true, status: true, revenue: true, account: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });
  const seen = new Map<string, typeof allBookings>();
  allBookings.forEach(b => {
    const key = `${b.item_name}|${b.renter_name}|${b.start_date.toISOString().split('T')[0]}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key)!.push(b);
  });
  let dupCount = 0;
  seen.forEach((group, key) => {
    if (group.length > 1) {
      dupCount++;
      console.log(`\n  DUPLICATE SET: ${key}`);
      group.forEach(b => {
        console.log(`    id=${b.id.substring(0,8)}... status=${b.status} rev=£${(b.revenue||0).toFixed(2)} account=${b.account} created=${b.created_at.toISOString()}`);
      });
    }
  });
  if (dupCount === 0) console.log('  No duplicates found.');
  console.log(`\n  Total duplicate sets: ${dupCount}`);

  // ─── SUMMARY ───
  console.log(`\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(80)}`);
  console.log(`  Ongoing (confirmed, date-based): ${totalOngoing}`);
  console.log(`  Upcoming (confirmed, date-based): ${totalUpcoming}`);
  console.log(`  Total bookings in DB: ${totalAll}`);
  byStatus.forEach(r => console.log(`    - ${r.status}: ${r._count}`));
  console.log(`  Feb 2026 revenue (deduped): £${febTotalRev.toFixed(2)}`);
  console.log(`  Jan 2026 revenue (deduped): £${janTotal.toFixed(2)}`);
  console.log(`  Dec 2025 revenue (deduped): £${decTotal.toFixed(2)}`);
  console.log(`  Duplicate booking sets: ${dupCount}`);
  console.log(`${'='.repeat(80)}\n`);
}

function dedup(rows: { item_name: string; renter_name: string; start_date: Date; revenue: number | null; account: string }[]) {
  const map = new Map<string, typeof rows[0]>();
  rows.forEach(r => {
    const key = `${r.item_name}|${r.renter_name}|${r.start_date.toISOString().split('T')[0]}`;
    const existing = map.get(key);
    if (!existing || (r.revenue || 0) > (existing.revenue || 0)) {
      map.set(key, r);
    }
  });
  return Array.from(map.values());
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
