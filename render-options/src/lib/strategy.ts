export type OptionSide = 'call' | 'put';

export interface OptionContract {
  name: string;
  currency: string;
  expiryMs: number;
  strike: number;
  side: OptionSide;
  tickSize: number;
  amountStep: number;
}

export interface TickerPoint {
  instrumentName: string;
  mark: number;
  bid: number;
  ask: number;
  iv?: number;
  delta?: number;
  timestamp?: number;
}

export interface SpreadPreview {
  long: OptionContract;
  short: OptionContract;
  quantity: number;
  debitPerUnit: number;
  estimatedDebit: number;
  maxProfit: number;
  maxLoss: number;
  breakEven: number;
  target: number;
  probability: number;
  probabilityMethod: string;
  width: number;
}

const num = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeEpoch(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const n = num(value);
  if (!n) return 0;
  if (n < 10_000_000_000) return n * 1000;
  return n;
}

function parseDateToken(token: string): number {
  if (/^\d{8}$/.test(token)) {
    const y = Number(token.slice(0, 4));
    const m = Number(token.slice(4, 6));
    const d = Number(token.slice(6, 8));
    return Date.UTC(y, m - 1, d, 8, 0, 0);
  }
  if (/^\d{1,2}[A-Za-z]{3}\d{2}$/.test(token)) {
    const d = Number(token.slice(0, token.length - 5));
    const mon = token.slice(token.length - 5, token.length - 2);
    const y = 2000 + Number(token.slice(-2));
    const parsed = Date.parse(d + ' ' + mon + ' ' + y + ' UTC');
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function parseOptionInstrument(raw: any): OptionContract | null {
  const name = String(raw?.instrument_name ?? raw?.instrumentName ?? '');
  if (!name) return null;

  const upper = name.toUpperCase();
  let side: OptionSide | null = null;
  const rawType = String(raw?.option_type ?? raw?.optionType ?? raw?.option_details?.option_type ?? '').toLowerCase();
  if (rawType.includes('call')) side = 'call';
  if (rawType.includes('put')) side = 'put';
  if (!side && /-C$/.test(upper)) side = 'call';
  if (!side && /-P$/.test(upper)) side = 'put';
  if (!side) return null;

  const explicitStrike = raw?.strike ?? raw?.strike_price ?? raw?.strikePrice ?? raw?.option_details?.strike;
  let strike = num(explicitStrike);
  if (!strike) {
    const parts = name.split('-');
    const suffixIndex = parts.length - 1;
    for (let i = suffixIndex - 1; i >= 1; i -= 1) {
      const candidate = Number(parts[i]);
      if (Number.isFinite(candidate) && candidate > 0) {
        strike = candidate;
        break;
      }
    }
  }
  if (!strike) return null;

  let expiryMs = normalizeEpoch(
    raw?.expiry_date ?? raw?.expiryDate ?? raw?.expiry ?? raw?.expiration_timestamp ?? raw?.option_details?.expiry,
  );
  if (!expiryMs) {
    for (const token of name.split('-')) {
      const parsed = parseDateToken(token);
      if (parsed) {
        expiryMs = parsed;
        break;
      }
    }
  }
  if (!expiryMs) return null;

  const currency = String(raw?.currency ?? raw?.base_currency ?? name.split('-')[0] ?? '').toUpperCase();
  return {
    name,
    currency,
    expiryMs,
    strike,
    side,
    tickSize: Math.max(num(raw?.tick_size ?? raw?.tickSize, 0.01), 0.00000001),
    amountStep: Math.max(num(raw?.amount_step ?? raw?.amountStep, 0.01), 0.00000001),
  };
}

export function normalizeTicker(name: string, raw: any): TickerPoint {
  const pick = (...values: unknown[]) => {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  let iv = pick(raw?.iv, raw?.mark_iv, raw?.markIv, raw?.option_pricing?.i, raw?.option_pricing?.iv, raw?.greeks?.iv);
  if (iv > 3) iv /= 100;
  return {
    instrumentName: name,
    mark: pick(raw?.M, raw?.mark_price, raw?.markPrice, raw?.mark),
    bid: pick(raw?.b, raw?.best_bid_price, raw?.bestBidPrice, raw?.bid),
    ask: pick(raw?.a, raw?.best_ask_price, raw?.bestAskPrice, raw?.ask),
    iv: iv || undefined,
    delta: pick(raw?.option_pricing?.d, raw?.delta, raw?.greeks?.delta) || undefined,
    timestamp: pick(raw?.t, raw?.timestamp) || undefined,
  };
}

export function normalizeTickers(raw: any): Map<string, TickerPoint> {
  const map = new Map<string, TickerPoint>();
  const source = raw?.tickers ?? raw?.data ?? raw;
  if (Array.isArray(source)) {
    for (const item of source) {
      const name = String(item?.instrument_name ?? item?.instrumentName ?? '');
      if (name) map.set(name, normalizeTicker(name, item));
    }
  } else if (source && typeof source === 'object') {
    for (const [name, item] of Object.entries(source)) {
      map.set(name, normalizeTicker(name, item));
    }
  }
  return map;
}

export function uniqueExpiries(options: OptionContract[]): number[] {
  return [...new Set(options.filter((o) => o.side === 'call' && o.expiryMs > Date.now()).map((o) => o.expiryMs))].sort(
    (a, b) => a - b,
  );
}

export function nearestStrike(strikes: number[], value: number): number {
  return strikes.reduce((best, strike) => (Math.abs(strike - value) < Math.abs(best - value) ? strike : best), strikes[0]);
}

function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return step;
  return Math.ceil((value - 1e-12) / step) * step;
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function riskNeutralFinishProbability(spot: number, strike: number, expiryMs: number, iv?: number, delta?: number) {
  const years = Math.max((expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 365.25);
  if (iv && iv > 0.01 && spot > 0 && strike > 0) {
    const rate = 0.04;
    const d2 = (Math.log(spot / strike) + (rate - 0.5 * iv * iv) * years) / (iv * Math.sqrt(years));
    return { value: Math.max(0.001, Math.min(0.999, normalCdf(d2))), method: 'IV-derived risk-neutral' };
  }
  if (delta != null && Number.isFinite(delta)) {
    return { value: Math.max(0.001, Math.min(0.999, Math.abs(delta))), method: 'option-delta proxy' };
  }
  const move = Math.abs(Math.log(strike / Math.max(spot, 1e-9)));
  const annualVol = 0.65;
  const z = move / (annualVol * Math.sqrt(years));
  return { value: Math.max(0.01, Math.min(0.99, 1 - normalCdf(z))), method: 'fallback volatility estimate' };
}

export function compileBullCallSpread(args: {
  options: OptionContract[];
  tickers: Map<string, TickerPoint>;
  spot: number;
  target: number;
  desiredProfit: number;
  expiryMs: number;
}): SpreadPreview | null {
  const calls = args.options
    .filter((o) => o.side === 'call' && o.expiryMs === args.expiryMs)
    .sort((a, b) => a.strike - b.strike);
  if (calls.length < 2 || args.spot <= 0 || args.target <= args.spot || args.desiredProfit <= 0) return null;

  const strikes = calls.map((c) => c.strike);
  const longStrike = nearestStrike(strikes, args.spot);
  const shortCandidates = strikes.filter((s) => s > longStrike);
  if (!shortCandidates.length) return null;
  const shortStrike = nearestStrike(shortCandidates, args.target);

  const long = calls.find((c) => c.strike === longStrike)!;
  const short = calls.find((c) => c.strike === shortStrike)!;
  const longTicker = args.tickers.get(long.name);
  const shortTicker = args.tickers.get(short.name);

  const longPx = longTicker?.ask || longTicker?.mark || 0;
  const shortPx = shortTicker?.bid || shortTicker?.mark || 0;
  if (longPx <= 0 || shortPx < 0) return null;

  const debitPerUnit = Math.max(longPx - shortPx, long.tickSize);
  const width = short.strike - long.strike;
  const maxProfitPerUnit = width - debitPerUnit;
  if (maxProfitPerUnit <= 0) return null;

  const step = Math.max(long.amountStep, short.amountStep);
  const quantity = ceilToStep(args.desiredProfit / maxProfitPerUnit, step);
  const estimatedDebit = debitPerUnit * quantity;
  const maxProfit = maxProfitPerUnit * quantity;
  const probability = riskNeutralFinishProbability(
    args.spot,
    short.strike,
    short.expiryMs,
    shortTicker?.iv ?? longTicker?.iv,
    shortTicker?.delta,
  );

  return {
    long,
    short,
    quantity,
    debitPerUnit,
    estimatedDebit,
    maxProfit,
    maxLoss: estimatedDebit,
    breakEven: long.strike + debitPerUnit,
    target: args.target,
    probability: probability.value,
    probabilityMethod: probability.method,
    width,
  };
}

export function payoffAtExpiry(preview: SpreadPreview, price: number): number {
  const longValue = Math.max(price - preview.long.strike, 0);
  const shortValue = Math.max(price - preview.short.strike, 0);
  return (longValue - shortValue - preview.debitPerUnit) * preview.quantity;
}
