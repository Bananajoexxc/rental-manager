import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) { console.log('No key'); return; }

  // Simple prompt without full inventory
  const prompt = `Match this rental listing title to camera/video equipment items:

TITLE: "BMPCC 6K Pro Ultimate Short Film Set – Full Blackmagic Cinema Camera Kit with Canon 24-105mm Lens, DJI Gimbal, Atomos Monitor, RGB Lighting & Wireless Mics | Professional Filmmaking Package"

Extract ONLY items explicitly named in the title. Ignore descriptive words (Ultimate, Professional, Package, etc.)

Return ONLY a JSON array: [{"item": "item name", "qty": 1}]`;

  console.log('Testing simplified prompt...');
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 256 }),
  });
  console.log('Status:', res.status);
  const data = await res.json() as any;
  console.log('Response:', JSON.stringify(data, null, 2));

  // Now test with llama3.1-8b using the same prompt
  console.log('\nTesting with llama3.1-8b...');
  const res2 = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.1-8b', messages: [{ role: 'user', content: prompt }], max_tokens: 256 }),
  });
  console.log('Status:', res2.status);
  const data2 = await res2.json() as any;
  console.log('Response:', JSON.stringify(data2.choices?.[0]?.message?.content));
}

main().catch(console.error);
