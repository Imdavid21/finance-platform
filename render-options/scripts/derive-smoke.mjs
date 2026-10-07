const base = 'https://testnet.api.derive.xyz/v3';
const origin = 'https://intent-options-v3.onrender.com';

async function post(path, body) {
  const res = await fetch(base + '/' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': origin,
      'user-agent': 'intent-options-smoke/1.0',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(JSON.stringify({
    path,
    status: res.status,
    allowOrigin: res.headers.get('access-control-allow-origin'),
    allowHeaders: res.headers.get('access-control-allow-headers'),
    preview: typeof data === 'string' ? data.slice(0, 300) : data,
  }, null, 2));
  if (!res.ok || data?.error) process.exitCode = 1;
  return data;
}

const currencies = await post('public/get_all_currencies', {});
const eth = Array.isArray(currencies?.result) ? currencies.result.find((x) => x.currency === 'ETH') : null;
if (!eth?.spot_price) {
  console.error('ETH missing from get_all_currencies');
  process.exitCode = 1;
}

const tickers = await post('public/get_tickers', { instrument_type: 'option', currency: 'ETH' });
const tickerMap = tickers?.result?.tickers ?? {};
const names = Object.keys(tickerMap);
console.log('ETH option ticker count:', names.length, 'sample:', names.slice(0, 5));
if (names.length < 2) {
  console.error('Not enough ETH option tickers for builder');
  process.exitCode = 1;
}

const opt = await fetch(base + '/public/get_all_instruments', {
  method: 'OPTIONS',
  headers: {
    origin,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
  },
});
console.log(JSON.stringify({
  path: 'OPTIONS public/get_all_instruments',
  status: opt.status,
  allowOrigin: opt.headers.get('access-control-allow-origin'),
  allowMethods: opt.headers.get('access-control-allow-methods'),
  allowHeaders: opt.headers.get('access-control-allow-headers'),
}, null, 2));
