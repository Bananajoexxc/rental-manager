require('dotenv').config();
const axios = require('axios');

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

async function fetchBookings(token, filter) {
  const resp = await client.get('/bookings', {
    headers: { Authorization: 'Bearer ' + token },
    params: { filter, maxResults: 30, country: COUNTRY }
  });
  return resp.data;
}

async function main() {
  for (const account of accounts) {
    console.log('=== ' + account.name.toUpperCase() + ' ===');
    try {
      const token = await authenticate(account);

      for (const filter of ['upcoming', 'ongoing']) {
        const bookings = await fetchBookings(token, filter);
        console.log(filter.toUpperCase() + ' (' + bookings.length + '):');
        bookings.forEach(b => {
          const start = b.fromDate ? new Date(b.fromDate).toISOString().split('T')[0] : '?';
          const end = b.toDate ? new Date(b.toDate).toISOString().split('T')[0] : '?';
          const price = b.price?.ownerEarnings || b.price?.total || '?';
          const renter = b.bookerName || b.fromUser?.firstName || '?';
          console.log('  ' + renter.padEnd(22) + start + ' - ' + end + '  £' + price + '  ' + (b.adTitle || '').substring(0, 55));
        });
      }
    } catch (e) {
      console.error(account.name + ' error:', e.response?.status, e.response?.data?.message || e.message);
    }
    console.log('');
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
