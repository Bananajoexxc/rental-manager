require('dotenv').config();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const API = 'https://api.hygglo.com/api';
const CLIENT_ID = 'ngHyggloApp';
const CLIENT_SECRET = 'lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=';

async function login(email, password) {
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('username', email);
  params.append('password', password);
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);

  const res = await axios.post(`${API}/token?country=GB`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.data.access_token;
}

async function fetchOrder(token, orderId) {
  const res = await axios.get(`${API}/v4/my/orders/${orderId}`, {
    params: { timezone: 'Europe/London' },
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'en',
      'User-Client': 'Hygglo-web',
      Country: 'GB',
      Origin: 'https://www.hygglo.com',
      Referer: 'https://www.hygglo.com/',
    },
  });
  return res.data;
}

function printOrder(label, d) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${label} ===`);
  console.log(`${'='.repeat(60)}`);
  console.log('status:', d.status);
  console.log('statusLabel:', d.statusLabel);
  console.log('state:', d.state);
  console.log('type:', d.type);
  console.log('verificationRequired:', d.verificationRequired);
  console.log('verificationComplete:', d.verificationComplete);
  console.log('verified:', d.verified);
  console.log('otherPart.verified:', d.users?.otherPart?.verified);
  console.log('otherPart.name:', d.users?.otherPart?.name);
  console.log('accepted:', d.accepted);
  console.log('acceptedAt:', d.acceptedAt);
  console.log('confirmedAt:', d.confirmedAt);
  console.log('approved:', d.approved);
  console.log('');
  console.log('TOP-LEVEL KEYS:', Object.keys(d).sort().join(', '));
  if (d.labels) console.log('LABELS:', JSON.stringify(d.labels, null, 2));
  if (d.statusDetails) console.log('STATUS DETAILS:', JSON.stringify(d.statusDetails, null, 2));
  if (d.orderStatus) console.log('ORDER STATUS:', JSON.stringify(d.orderStatus, null, 2));
  console.log('');
  if (d.activities && d.activities.length > 0) {
    console.log('ACTIVITIES (' + d.activities.length + '):');
    for (const a of d.activities) {
      const content = a.chatMessage?.text?.content || '';
      const type = a.type || '';
      const author = a.chatMessage?.author || a.author || '';
      const label2 = a.label || '';
      console.log(`  [type=${type}] [author=${author}] [label=${label2}]`, content.substring(0, 300));
    }
  }
}

(async () => {
  const p = new PrismaClient();

  console.log('Logging in...');
  const leoToken = await login(process.env.HYGGLO_LEO_EMAIL, process.env.HYGGLO_LEO_PASSWORD);
  const dbToken = await login(process.env.HYGGLO_DBCINEMA_EMAIL, process.env.HYGGLO_DBCINEMA_PASSWORD);
  console.log('Logged in.');

  // Nafeesa's rental on Leo (listing 3741515) — KNOWN PENDING
  const nafeesa = await fetchOrder(leoToken, '3741515');
  printOrder('NAFEESA (listing 3741515, Leo) - KNOWN PENDING', nafeesa);

  // Second Nafeesa rental
  try {
    const nafeesa2 = await fetchOrder(leoToken, '3742424');
    printOrder('NAFEESA 2 (listing 3742424, Leo) - KNOWN PENDING', nafeesa2);
  } catch (e) { console.log('Could not fetch 3742424:', e.message); }

  // Comparison: a regular UNRESPONDED pending rental on Leo
  const otherLeo = await p.rental.findFirst({
    where: { status: 'pending', account: 'leo', start_date: { gte: new Date() },
      renter_info: { not: { contains: 'Nafeesa' } } },
    select: { listing_id: true, renter_info: true },
    orderBy: { start_date: 'asc' },
  });
  if (otherLeo) {
    try {
      const comp = await fetchOrder(leoToken, otherLeo.listing_id);
      printOrder(`COMPARISON (Leo, UNRESPONDED): ${otherLeo.renter_info} (listing ${otherLeo.listing_id})`, comp);
    } catch (e) { console.log(`Could not fetch ${otherLeo.listing_id}:`, e.message); }
  }

  // Comparison: an ACCEPTED upcoming rental on Leo
  const upcomingLeo = await p.rental.findFirst({
    where: { status: 'upcoming', account: 'leo', start_date: { gte: new Date() } },
    select: { listing_id: true, renter_info: true },
    orderBy: { start_date: 'asc' },
  });
  if (upcomingLeo) {
    try {
      const comp2 = await fetchOrder(leoToken, upcomingLeo.listing_id);
      printOrder(`COMPARISON (Leo, ACCEPTED/UPCOMING): ${upcomingLeo.renter_info} (listing ${upcomingLeo.listing_id})`, comp2);
    } catch (e) { console.log(`Could not fetch ${upcomingLeo.listing_id}:`, e.message); }
  }

  await p.$disconnect();
})();
