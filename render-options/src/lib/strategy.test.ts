import { describe, expect, it } from 'vitest';
import { compileBullCallSpread, normalizeTicker, parseOptionInstrument, payoffAtExpiry } from './strategy';

const long = parseOptionInstrument({
  instrument_name: 'ETH-20261127-2700-C',
  base_currency: 'ETH',
  instrument_type: 'option',
  is_active: true,
  amount_step: '0.01',
  minimum_amount: '0.10',
  maximum_amount: '100',
  tick_size: '0.01',
  option_details: { expiry: 1795766400, index: 'ETH-USD', option_type: 'call', strike: '2700' },
})!;

const short = parseOptionInstrument({
  instrument_name: 'ETH-20261127-3100-C',
  base_currency: 'ETH',
  instrument_type: 'option',
  is_active: true,
  amount_step: '0.01',
  minimum_amount: '0.10',
  maximum_amount: '100',
  tick_size: '0.01',
  option_details: { expiry: 1795766400, index: 'ETH-USD', option_type: 'call', strike: '3100' },
})!;

describe('Derive V3 normalization', () => {
  it('parses official option_details and second-based expiries', () => {
    expect(long.strike).toBe(2700);
    expect(long.side).toBe('call');
    expect(long.expiryMs).toBe(1795766400000);
    expect(long.amountStep).toBe(0.01);
    expect(long.minimumAmount).toBe(0.1);
  });

  it('reads ticker_slim prices and compact option greeks', () => {
    const ticker = normalizeTicker(long.name, {
      a: '131.2',
      b: '128.8',
      M: '130',
      I: '2703',
      option_pricing: { i: '0.72', d: '0.51' },
      t: 1790000000000,
    });
    expect(ticker.ask).toBe(131.2);
    expect(ticker.bid).toBe(128.8);
    expect(ticker.mark).toBe(130);
    expect(ticker.iv).toBe(0.72);
    expect(ticker.delta).toBe(0.51);
  });
});

describe('bull call spread compiler', () => {
  it('sizes to the requested max-profit intent and preserves bounded loss', () => {
    const tickers = new Map([
      [long.name, normalizeTicker(long.name, { a: '150', b: '148', M: '149', option_pricing: { i: '0.70', d: '0.52' } })],
      [short.name, normalizeTicker(short.name, { a: '25', b: '24', M: '24.5', option_pricing: { i: '0.74', d: '0.20' } })],
    ]);
    const preview = compileBullCallSpread({
      options: [long, short],
      tickers,
      spot: 2703,
      target: 3100,
      desiredProfit: 3000,
      expiryMs: long.expiryMs,
    });
    expect(preview).not.toBeNull();
    expect(preview!.long.strike).toBe(2700);
    expect(preview!.short.strike).toBe(3100);
    expect(preview!.quantity).toBeGreaterThanOrEqual(0.1);
    expect(preview!.maxLoss).toBeGreaterThan(0);
    expect(preview!.maxProfit).toBeGreaterThanOrEqual(3000);
    expect(payoffAtExpiry(preview!, 2500)).toBeCloseTo(-preview!.maxLoss, 8);
    expect(payoffAtExpiry(preview!, 3500)).toBeCloseTo(preview!.maxProfit, 8);
  });

  it('refuses a quantity above Derive maximum amount', () => {
    const tickers = new Map([
      [long.name, normalizeTicker(long.name, { a: '399', b: '398', M: '398.5' })],
      [short.name, normalizeTicker(short.name, { a: '1', b: '0.5', M: '0.75' })],
    ]);
    const preview = compileBullCallSpread({
      options: [long, short],
      tickers,
      spot: 2703,
      target: 3100,
      desiredProfit: 1_000_000,
      expiryMs: long.expiryMs,
    });
    expect(preview).toBeNull();
  });
});
