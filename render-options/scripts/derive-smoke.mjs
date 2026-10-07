const base = 'https://testnet.api.derive.xyz/v3';
const origin = 'https://intent-options-v3.onrender.com';

async function post(path, body) {
  const res = await fetch(base + '/' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
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
    error: data?.error ?? null,
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

const instruments = await post('public/get_all_instruments', {
  instrument_type: 'option',
  expired: false,
  currency: 'ETH',
  page: 1,
  page_size: 100,
});
const rows = instruments?.result?.instruments ?? [];
console.log('ETH option instrument count on page:', rows.length);
if (rows.length < 2) {
  console.error('Not enough ETH option instruments');
  process.exitCode = 1;
}

const expiry = rows.find((row) => row?.option_details?.expiry)?.option_details?.expiry;
if (!expiry) {
  console.error('No option expiry discovered');
  process.exitCode = 1;
} else {
  const date = new Date(Number(expiry) * 1000);
  const expiryDate = Number(
    String(date.getUTCFullYear()) +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0')
  );
  const tickers = await post('public/get_tickers', {
    instrument_type: 'option',
    currency: 'ETH',
    expiry_date: expiryDate,
  });
  const names = Object.keys(tickers?.result?.tickers ?? {});
  console.log('ETH option ticker count for expiry', expiryDate, ':', names.length, 'sample:', names.slice(0, 5));
  if (names.length < 2) {
    console.error('Not enough ETH option tickers for selected expiry');
    process.exitCode = 1;
  }
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
  note: 'Direct browser REST is intentionally not used by the app; Render gateway supplies CORS.',
}, null, 2));


const gateway = 'https://intent-options-api.onrender.com';
async function gatewayPost(path, body) {
  const res = await fetch(gateway + '/derive/' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const allowOrigin = res.headers.get('access-control-allow-origin');
  console.log(JSON.stringify({
    gatewayPath: path,
    status: res.status,
    allowOrigin,
    error: data?.error ?? null,
  }, null, 2));
  if (!res.ok || data?.error) {
    console.error('Gateway request failed:', path);
    process.exitCode = 1;
  }
  if (allowOrigin !== origin) {
    console.error('Gateway CORS mismatch:', allowOrigin, 'expected', origin);
    process.exitCode = 1;
  }
  return data?.result;
}

const gatewayCurrencies = await gatewayPost('public/get_all_currencies', {});
const gatewayEth = Array.isArray(gatewayCurrencies)
  ? gatewayCurrencies.find((x) => x.currency === 'ETH')
  : null;
if (!gatewayEth?.spot_price) {
  console.error('Gateway did not return ETH spot data');
  process.exitCode = 1;
}

const gatewayInstruments = await gatewayPost('public/get_all_instruments', {
  instrument_type: 'option',
  expired: false,
  currency: 'ETH',
  page: 1,
  page_size: 100,
});
const gatewayRows = gatewayInstruments?.instruments ?? [];
const gatewayExpiry = gatewayRows.find((row) => row?.option_details?.expiry)?.option_details?.expiry;
if (!gatewayExpiry) {
  console.error('Gateway did not return an ETH option expiry');
  process.exitCode = 1;
} else {
  const date = new Date(Number(gatewayExpiry) * 1000);
  const expiryDate = Number(
    String(date.getUTCFullYear()) +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0')
  );
  const gatewayTickers = await gatewayPost('public/get_tickers', {
    instrument_type: 'option',
    currency: 'ETH',
    expiry_date: expiryDate,
  });
  const names = Object.keys(gatewayTickers?.tickers ?? {});
  console.log('Gateway ETH option ticker count:', names.length);
  if (names.length < 2) {
    console.error('Gateway returned insufficient option ticker data');
    process.exitCode = 1;
  }
}
