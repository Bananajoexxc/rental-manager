require('dotenv').config();
const axios = require('axios');

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
      Authorization: `Bearer ${token}`, Accept: 'application/json',
      'Accept-Language': 'en', 'User-Client': 'Hygglo-web', Country: 'GB',
      Origin: 'https://www.hygglo.com', Referer: 'https://www.hygglo.com/',
    },
  });
  return res.data;
}

(async () => {
  const token = await login(process.env.HYGGLO_LEO_EMAIL, process.env.HYGGLO_LEO_PASSWORD);

  // Nafeesa (PENDING VERIFICATION) vs Nafeesa 2 (UNRESPONDED)
  for (const id of ['3741515', '3742424']) {
    const d = await fetchOrder(token, id);
    console.log(`\n=== ORDER ${id} ===`);
    console.log('steps:', JSON.stringify(d.steps, null, 2));
    console.log('actions:', JSON.stringify(d.actions, null, 2));
    console.log('disabledActions:', JSON.stringify(d.disabledActions, null, 2));
    console.log('extraInfo:', JSON.stringify(d.extraInfo, null, 2));
    console.log('users:', JSON.stringify(d.users, null, 2));
    console.log('price:', JSON.stringify(d.price, null, 2));
  }
})();
