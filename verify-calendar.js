require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');

const p = new PrismaClient();
const CLIENT_ID = 'ngHyggloApp';
const CLIENT_SECRET = 'lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=';
const API_BASE = 'https://api.hygglo.com/api';
const COUNTRY = 'gb';

const accounts = [
  { name: 'dbcinema', email: process.env.HYGGLO_DBCINEMA_EMAIL, password: process.env.HYGGLO_DBCINEMA_PASSWORD },
  { name: 'leo', email: process.env.HYGGLO_LEO_EMAIL, password: process.env.HYGGLO_LEO_PASSWORD },
];

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: {
    'Accept': 'application/json',
    'Accept-Language': 'en',
    'User-Client': 'Hygglo-web',
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://www.hygglo.com',
    'Referer': 'https://www.hygglo.com/',
    'Country': COUNTRY,
  },
});

async function authenticate(account) {
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('username', account.email);
  params.append('password', account.password);
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  const resp = await client.post('/token?country=' + COUNTRY, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return resp.data.access_token;
}

async function fetchOrders(token, filter) {
  const resp = await client.get('/v4/my/orders', {
    headers: { Authorization: 'Bearer ' + token },
    params: { role: 'owner', filter, sort: 'order-start-date', offset: 0, limit: 100 }
  });
  const data = resp.data;
  return Array.isArray(data) ? data : (data.items || data.results || data.data || []);
}

async function fetchOrderDetail(token, orderId) {
  const resp = await client.get(`/v4/my/orders/${orderId}`, {
    headers: { Authorization: 'Bearer ' + token },
    params: { timezone: 'Europe/London' }
  });
  return resp.data;
}

async function main() {
  // Step 1: Get all confirmed bookings from our DB (future + recent)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30); // last 30 days

  const confirmedBookings = await p.booking.findMany({
    where: {
      status: 'confirmed',
      start_date: { gte: cutoff }
    },
    select: {
      id: true, item_name: true, renter_name: true, start_date: true, end_date: true,
      revenue: true, account: true, rental_id: true, status: true
    },
    orderBy: { start_date: 'asc' }
  });

  // Get rental statuses
  const rentalIds = [...new Set(confirmedBookings.map(b => b.rental_id).filter(Boolean))];
  const rentals = await p.rental.findMany({
    where: { id: { in: rentalIds } },
    select: { id: true, status: true, listing_id: true, renter_info: true, title: true, start_date: true, end_date: true }
  });
  const rentalMap = {};
  rentals.forEach(r => { rentalMap[r.id] = r; });

  console.log(`\n=== DB: ${confirmedBookings.length} confirmed bookings (last 30 days) ===\n`);

  // Step 2: Fetch all orders from Hygglo for each account
  const hyggloOrders = {}; // orderId -> { status, detail }

  for (const account of accounts) {
    console.log(`--- Fetching Hygglo data for ${account.name.toUpperCase()} ---`);
    try {
      const token = await authenticate(account);

      for (const filter of ['pending', 'future', 'current', 'completed']) {
        const orders = await fetchOrders(token, filter);
        console.log(`  ${filter}: ${orders.length} orders`);

        for (const order of orders) {
          const orderId = String(order.id);
          try {
            const detail = await fetchOrderDetail(token, orderId);
            const startDate = detail.rentalPeriod?.startDateUTC ? new Date(detail.rentalPeriod.startDateUTC).toISOString().split('T')[0] : '?';
            const endDate = detail.rentalPeriod?.endDateUTC ? new Date(detail.rentalPeriod.endDateUTC).toISOString().split('T')[0] : '?';
            const renter = detail.users?.otherPart?.name || order.labels?.otherPart || '?';
            const earnings = detail.price?.ownerEarnings || detail.price?.total || 0;
            const title = order.labels?.name || detail.labels?.name || '?';

            hyggloOrders[orderId] = {
              hyggloStatus: filter === 'future' ? 'upcoming' : filter === 'current' ? 'ongoing' : filter,
              renter,
              startDate,
              endDate,
              earnings,
              title: title.substring(0, 60),
              account: account.name
            };
          } catch (err) {
            console.log(`  Error fetching detail for ${orderId}: ${err.response?.status || err.message}`);
            hyggloOrders[orderId] = { hyggloStatus: filter, renter: '?', account: account.name };
          }
        }
      }
    } catch (e) {
      console.error(`${account.name} auth error:`, e.response?.status, e.response?.data?.message || e.message);
    }
  }

  console.log(`\nTotal Hygglo orders fetched: ${Object.keys(hyggloOrders).length}\n`);

  // Step 3: Cross-reference — check each confirmed booking's rental listing_id against Hygglo
  const problems = [];
  const verified = [];
  const unknown = [];

  for (const booking of confirmedBookings) {
    const rental = booking.rental_id ? rentalMap[booking.rental_id] : null;
    const listingId = rental?.listing_id;
    const start = booking.start_date ? booking.start_date.toISOString().split('T')[0] : '?';
    const end = booking.end_date ? booking.end_date.toISOString().split('T')[0] : '?';
    const line = `${(booking.renter_name || '?').padEnd(22)} ${start} - ${end}  £${String(booking.revenue || 0).padEnd(6)} ${(booking.item_name || '').substring(0, 40).padEnd(41)} ${booking.account}`;

    if (!listingId) {
      unknown.push({ line, reason: 'NO_LISTING_ID', rentalStatus: rental?.status || 'NO_RENTAL' });
      continue;
    }

    const hygglo = hyggloOrders[listingId];
    if (!hygglo) {
      // Not found in any Hygglo filter - might be very old completed
      if (rental?.status === 'completed') {
        verified.push({ line, hyggloStatus: 'completed (not in API - old)' });
      } else {
        unknown.push({ line, reason: 'NOT_IN_HYGGLO_API', rentalStatus: rental?.status, listingId });
      }
      continue;
    }

    if (hygglo.hyggloStatus === 'pending') {
      problems.push({ line, hyggloStatus: 'PENDING (NOT ACCEPTED!)', listingId, bookingId: booking.id, rentalId: booking.rental_id });
    } else if (['upcoming', 'ongoing', 'completed'].includes(hygglo.hyggloStatus)) {
      verified.push({ line, hyggloStatus: hygglo.hyggloStatus });
    } else {
      unknown.push({ line, reason: `UNEXPECTED_STATUS: ${hygglo.hyggloStatus}`, listingId });
    }
  }

  console.log(`=== VERIFIED OK (${verified.length}) ===`);
  verified.forEach(v => console.log(`  ✅ [${v.hyggloStatus}] ${v.line}`));

  console.log(`\n=== PROBLEMS - SHOULD NOT BE CONFIRMED (${problems.length}) ===`);
  problems.forEach(p => console.log(`  ❌ [${p.hyggloStatus}] ${p.line}  (listing=${p.listingId})`));

  console.log(`\n=== UNKNOWN - COULD NOT VERIFY (${unknown.length}) ===`);
  unknown.forEach(u => console.log(`  ⚠️  [${u.reason}] ${u.line}`));

  // Step 4: Show what's in Hygglo but NOT in our calendar (pending requests we're correctly ignoring)
  const calendarListingIds = new Set();
  confirmedBookings.forEach(b => {
    const r = b.rental_id ? rentalMap[b.rental_id] : null;
    if (r?.listing_id) calendarListingIds.add(r.listing_id);
  });

  const pendingNotInCal = Object.entries(hyggloOrders).filter(
    ([id, o]) => o.hyggloStatus === 'pending' && !calendarListingIds.has(id)
  );
  console.log(`\n=== PENDING ON HYGGLO, CORRECTLY NOT IN CALENDAR (${pendingNotInCal.length}) ===`);
  pendingNotInCal.forEach(([id, o]) => console.log(`  ⏳ ${(o.renter || '?').padEnd(22)} ${o.startDate || '?'} - ${o.endDate || '?'}  £${o.earnings || '?'}  ${(o.title || '').substring(0, 40)}  ${o.account}`));

  // Step 5: Auto-fix - demote problematic bookings
  if (problems.length > 0) {
    console.log(`\n=== AUTO-FIX: Demoting ${problems.length} wrong confirmed bookings ===`);
    for (const prob of problems) {
      await p.booking.updateMany({
        where: { id: prob.bookingId, status: 'confirmed' },
        data: { status: 'pending_review' }
      });
      // Also fix the rental status if it's wrong
      if (prob.rentalId) {
        await p.rental.updateMany({
          where: { id: prob.rentalId, status: { not: 'pending' } },
          data: { status: 'pending' }
        });
      }
      console.log(`  Fixed: ${prob.line}`);
    }
  }

  // Step 6: Also check rentals marked as ongoing/upcoming/completed that are actually pending on Hygglo
  console.log('\n=== CHECKING RENTAL STATUS MISMATCHES ===');
  const activeRentals = await p.rental.findMany({
    where: {
      status: { in: ['ongoing', 'upcoming'] },
      start_date: { gte: cutoff }
    },
    select: { id: true, listing_id: true, status: true, renter_info: true, title: true, start_date: true, end_date: true, rental_price: true, account: true }
  });

  let rentalMismatches = 0;
  for (const rental of activeRentals) {
    if (!rental.listing_id) continue;
    const hygglo = hyggloOrders[rental.listing_id];
    if (!hygglo) continue;

    if (hygglo.hyggloStatus === 'pending' && rental.status !== 'pending') {
      const start = rental.start_date ? rental.start_date.toISOString().split('T')[0] : '?';
      const end = rental.end_date ? rental.end_date.toISOString().split('T')[0] : '?';
      console.log(`  ❌ Rental ${rental.listing_id}: DB says "${rental.status}" but Hygglo says "pending"  ${rental.renter_info} ${start}-${end} £${rental.rental_price} ${rental.account}`);

      // Fix rental status
      await p.rental.update({ where: { id: rental.id }, data: { status: 'pending' } });
      // Demote any confirmed bookings
      const demoted = await p.$executeRaw`UPDATE booking SET status = 'pending_review' WHERE rental_id = ${rental.id} AND status = 'confirmed'`;
      console.log(`    → Fixed rental to pending, demoted ${demoted} bookings`);
      rentalMismatches++;
    }
  }

  if (rentalMismatches === 0) {
    console.log('  All active rental statuses match Hygglo ✅');
  }

  // Final calendar count
  const finalCal = await p.booking.count({ where: { status: 'confirmed', start_date: { gte: cutoff } } });
  console.log(`\n=== FINAL: ${finalCal} confirmed bookings in last 30 days ===`);

  await p.$disconnect();
}

main().catch(e => { console.error(e.message); process.exit(1); });
