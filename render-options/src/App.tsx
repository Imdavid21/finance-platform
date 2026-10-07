import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TESTNET_APP_URL,
  connectTradingSession,
  disconnectTradingSession,
  executeFirmQuote,
  loadAssetCatalog,
  loadExpiryTickers,
  loadMarket,
  requestFirmQuote,
  restoreTradingSession,
  subscribeSpot,
  type AssetSummary,
  type FirmQuote,
  type MarketState,
  type TradingSession,
} from './lib/derive';
import {
  compileBullCallSpread,
  nearestStrike,
  payoffAtExpiry,
  uniqueExpiries,
  type SpreadPreview,
} from './lib/strategy';

type Panel = 'profit' | 'asset' | 'target' | 'expiry' | null;
type Phase = 'builder' | 'review' | 'filled';

const money = (value: number, digits = 0) =>
  Number(value || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const number = (value: number, digits = 0) =>
  Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const compact = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

const dateLabel = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(ms);

const fullDateLabel = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(ms);

const dte = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000));

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function SmoothSlider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  marks?: number[];
  format?: (v: number) => string;
  onPreview?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const { value, min, max, step = 1, marks = [], format = (v) => String(v), onPreview, onCommit } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const frame = useRef<number | null>(null);
  const pending = useRef(value);
  const [visual, setVisual] = useState(value);

  useEffect(() => {
    if (!dragging.current) setVisual(value);
  }, [value]);

  const snap = (raw: number) => {
    if (marks.length) return nearestStrike(marks, raw);
    return Math.round(raw / step) * step;
  };

  const schedule = (raw: number) => {
    pending.current = clamp(raw, min, max);
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setVisual(pending.current);
      onPreview?.(pending.current);
    });
  };

  const fromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    schedule(min + pct * (max - min));
  };

  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const next = clamp(snap(pending.current), min, max);
    setVisual(next);
    onCommit(next);
  };

  const pct = max === min ? 0 : ((visual - min) / (max - min)) * 100;

  return (
    <div className="smooth-slider">
      <div
        className={'slider-track' + (dragging.current ? ' dragging' : '')}
        ref={trackRef}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e.clientX);
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
      >
        <div className="slider-fill" style={{ width: pct + '%' }} />
        {marks.slice(0, 40).map((mark) => {
          const left = ((mark - min) / Math.max(max - min, 1e-9)) * 100;
          if (left < 0 || left > 100) return null;
          return <span className="strike-mark" style={{ left: left + '%' }} key={mark} />;
        })}
        <div
          className="slider-thumb"
          style={{ left: pct + '%' }}
          role="slider"
          tabIndex={0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={visual}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const direction = e.key === 'ArrowRight' ? 1 : -1;
            const nextRaw = clamp(visual + direction * step, min, max);
            const next = snap(nextRaw);
            setVisual(next);
            onPreview?.(next);
            onCommit(next);
          }}
        >
          <span>{format(visual)}</span>
        </div>
      </div>
      <div className="slider-labels">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

function LoadingLines() {
  return (
    <div className="loading-lines">
      <span />
      <span />
      <span />
    </div>
  );
}

function App() {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [asset, setAsset] = useState('ETH');
  const [market, setMarket] = useState<MarketState | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [marketError, setMarketError] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [desiredProfit, setDesiredProfit] = useState(3000);
  const [target, setTarget] = useState(0);
  const [expiry, setExpiry] = useState(0);
  const [phase, setPhase] = useState<Phase>('builder');
  const [session, setSession] = useState<TradingSession | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [firm, setFirm] = useState<FirmQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [executeBusy, setExecuteBusy] = useState(false);
  const [fill, setFill] = useState<any>(null);
  const [clock, setClock] = useState(Date.now());
  const initializedForAsset = useRef<string>('');

  useEffect(() => {
    let active = true;
    loadAssetCatalog()
      .then((rows) => {
        if (!active) return;
        setAssets(rows);
        if (rows.length && !rows.some((row) => row.symbol === asset)) setAsset(rows[0].symbol);
      })
      .catch((error) => {
        if (active) setMarketError(error instanceof Error ? error.message : 'Could not load Derive markets.');
      });
    restoreTradingSession().then((restored) => {
      if (active && restored) setSession(restored);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingMarket(true);
    setMarketError('');
    loadMarket(asset)
      .then((next) => {
        if (!active) return;
        setMarket(next);
        const expiries = uniqueExpiries(next.options);
        if (expiries.length) {
          const ideal = Date.now() + 45 * 86_400_000;
          const selected = expiries.reduce((best, item) =>
            Math.abs(item - ideal) < Math.abs(best - ideal) ? item : best,
          );
          setExpiry((current) => (current && expiries.includes(current) ? current : selected));
          const calls = next.options
            .filter((o) => o.side === 'call' && o.expiryMs === selected && o.strike > next.spot)
            .map((o) => o.strike)
            .sort((a, b) => a - b);
          if (calls.length) {
            const initial = nearestStrike(calls, next.spot * 1.15);
            if (initializedForAsset.current !== asset) {
              initializedForAsset.current = asset;
              setTarget(initial);
            }
          }
        }
      })
      .catch((error) => {
        if (active) setMarketError(error instanceof Error ? error.message : 'Could not load Derive option chain.');
      })
      .finally(() => {
        if (active) setLoadingMarket(false);
      });

    let stop: (() => void) | undefined;
    subscribeSpot(asset, (price) => {
      if (active) setMarket((current) => (current ? { ...current, spot: price } : current));
    }).then((cleanup) => {
      stop = cleanup;
    });

    return () => {
      active = false;
      stop?.();
    };
  }, [asset]);

  useEffect(() => {
    if (!expiry) return;
    let active = true;
    setPricingLoading(true);
    loadExpiryTickers(asset, expiry)
      .then((tickers) => {
        if (!active) return;
        setMarket((current) => {
          if (!current || current.asset !== asset) return current;
          return { ...current, tickers };
        });
      })
      .catch((error) => {
        if (active) setMarketError(error instanceof Error ? error.message : 'Could not load Derive option prices.');
      })
      .finally(() => {
        if (active) setPricingLoading(false);
      });
    return () => {
      active = false;
    };
  }, [asset, expiry]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const expiries = useMemo(() => (market ? uniqueExpiries(market.options) : []), [market]);
  const targetStrikes = useMemo(() => {
    if (!market || !expiry) return [];
    return market.options
      .filter((o) => o.side === 'call' && o.expiryMs === expiry && o.strike > market.spot)
      .map((o) => o.strike)
      .sort((a, b) => a - b);
  }, [market, expiry]);

  const preview = useMemo(() => {
    if (!market || !expiry || !target) return null;
    return compileBullCallSpread({
      options: market.options,
      tickers: market.tickers,
      spot: market.spot,
      target,
      desiredProfit,
      expiryMs: expiry,
    });
  }, [market, expiry, target, desiredProfit]);

  const finalEconomics = useMemo(() => {
    if (!preview) return null;
    if (!firm || !firm.debit) {
      return {
        debit: preview.estimatedDebit,
        maxProfit: preview.maxProfit,
        maxLoss: preview.maxLoss,
        breakEven: preview.breakEven,
        debitPerUnit: preview.debitPerUnit,
      };
    }
    const debitPerUnit = firm.debit / preview.quantity;
    return {
      debit: firm.debit,
      maxProfit: Math.max(0, preview.width * preview.quantity - firm.debit),
      maxLoss: firm.debit,
      breakEven: preview.long.strike + debitPerUnit,
      debitPerUnit,
    };
  }, [preview, firm]);

  const quoteExpired = Boolean(firm && firm.validUntil <= clock);
  const quoteSeconds = firm ? Math.max(0, Math.ceil((firm.validUntil - clock) / 1000)) : 0;

  const connect = async () => {
    setSessionBusy(true);
    setQuoteError('');
    try {
      const next = await connectTradingSession();
      setSession(next);
      return next;
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Wallet connection failed.');
      return null;
    } finally {
      setSessionBusy(false);
    }
  };

  const requestQuote = async (existingSession?: TradingSession | null) => {
    if (!preview) return;
    setQuoteBusy(true);
    setQuoteError('');
    setFirm(null);
    setRiskAccepted(false);
    try {
      const activeSession = existingSession ?? session ?? (await connect());
      if (!activeSession) return;
      const next = await requestFirmQuote(activeSession, preview);
      setFirm(next);
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Could not get a Derive RFQ.');
    } finally {
      setQuoteBusy(false);
    }
  };

  const execute = async () => {
    if (!session || !firm || !riskAccepted || quoteExpired) return;
    setExecuteBusy(true);
    setQuoteError('');
    try {
      const result = await executeFirmQuote(session, firm);
      setFill(result);
      setPhase('filled');
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Execution failed.');
    } finally {
      setExecuteBusy(false);
    }
  };

  if (phase === 'filled' && preview && finalEconomics) {
    return (
      <main className="app-shell result-screen">
        <div className="result-card">
          <div className="success-orb">✓</div>
          <p className="eyebrow">DERIVE V3 TESTNET</p>
          <h1>Spread submitted.</h1>
          <p>
            {number(preview.quantity, 4)}× {preview.long.name} / {preview.short.name}
          </p>
          <div className="result-grid">
            <div><span>Debit</span><strong>{money(finalEconomics.debit, 2)}</strong></div>
            <div><span>Max profit</span><strong>{money(finalEconomics.maxProfit, 2)}</strong></div>
            <div><span>Status</span><strong>{String(fill?.status ?? 'submitted')}</strong></div>
          </div>
          <pre className="fill-json">{JSON.stringify(fill, null, 2)}</pre>
          <button className="primary wide" onClick={() => {
            setPhase('builder');
            setFirm(null);
            setFill(null);
            setRiskAccepted(false);
          }}>Build another trade</button>
        </div>
      </main>
    );
  }

  if (phase === 'review' && preview && finalEconomics) {
    const prices = [
      Math.max(0, preview.long.strike * 0.82),
      preview.long.strike,
      finalEconomics.breakEven,
      preview.short.strike,
      preview.short.strike * 1.12,
    ];
    const payoffs = prices.map((price) => {
      const adjusted: SpreadPreview = { ...preview, debitPerUnit: finalEconomics.debitPerUnit };
      return payoffAtExpiry(adjusted, price);
    });
    const maxAbs = Math.max(...payoffs.map((p) => Math.abs(p)), 1);

    return (
      <main className="app-shell">
        <Header session={session} onConnect={connect} onDisconnect={async () => {
          await disconnectTradingSession();
          setSession(null);
          setFirm(null);
        }} busy={sessionBusy} />
        <section className="review-grid">
          <div className="review-card">
            <div className="review-heading">
              <div>
                <p className="eyebrow">DEFINED-RISK CALL SPREAD</p>
                <h1>
                  Make up to <mark className="profit-mark">{money(finalEconomics.maxProfit)}</mark> if {asset} ends above{' '}
                  <mark className="target-mark">{money(preview.short.strike)}</mark> on{' '}
                  <mark className="expiry-mark">{fullDateLabel(expiry)}</mark>.
                </h1>
              </div>
              <button className="secondary" onClick={() => {
                setPhase('builder');
                setFirm(null);
                setRiskAccepted(false);
              }}>Edit</button>
            </div>

            <div className="scenario-list">
              <div><span className="scenario-dot good">↑</span><span>At or above {money(preview.short.strike)}</span><strong className="good-text">+{money(finalEconomics.maxProfit)}</strong></div>
              <div><span className="scenario-dot neutral">•</span><span>At breakeven {money(finalEconomics.breakEven)}</span><strong>{money(0)}</strong></div>
              <div><span className="scenario-dot bad">↓</span><span>At or below {money(preview.long.strike)}</span><strong className="bad-text">−{money(finalEconomics.maxLoss)}</strong></div>
            </div>

            <div className="payoff">
              <div className="payoff-zero" />
              {payoffs.map((pnl, index) => (
                <div className="payoff-column" key={prices[index]}>
                  <div className={'payoff-bar ' + (pnl >= 0 ? 'positive' : 'negative')} style={{
                    height: Math.max(4, Math.abs(pnl) / maxAbs * 76) + 'px',
                    transform: pnl >= 0 ? 'translateY(-100%)' : 'translateY(0)',
                  }} />
                  <span>{money(prices[index])}</span>
                </div>
              ))}
            </div>

            <details className="contracts">
              <summary>Exact contracts <span>{number(preview.quantity, 4)} per leg</span></summary>
              <div className="contract-row"><span>Buy call</span><strong>{preview.long.name}</strong></div>
              <div className="contract-row"><span>Sell call</span><strong>{preview.short.name}</strong></div>
              <div className="contract-row"><span>Spread width</span><strong>{money(preview.width)}</strong></div>
            </details>
          </div>

          <aside className="quote-panel">
            <div className="quote-top">
              <div>
                <p className="eyebrow">EXECUTION</p>
                <h2>{firm ? 'Firm Derive RFQ' : 'Indicative preview'}</h2>
              </div>
              <span className={'network-badge ' + (firm ? 'live' : '')}>{firm ? 'QUOTE LIVE' : 'TESTNET'}</span>
            </div>

            <QuoteRow label="Wallet" value={session ? session.ownerAddress.slice(0, 6) + '…' + session.ownerAddress.slice(-4) : 'Not connected'} />
            <QuoteRow label="Subaccount" value={session ? '#' + session.subaccountId : '—'} />
            <QuoteRow label="Contracts" value={number(preview.quantity, 4) + ' × 2 legs'} />
            <QuoteRow label="Maximum debit" value={money(finalEconomics.debit, 2)} strong />
            <QuoteRow label="Maximum profit" value={money(finalEconomics.maxProfit, 2)} />
            <QuoteRow label="Maximum loss" value={money(finalEconomics.maxLoss, 2)} />
            <QuoteRow label="Breakeven" value={money(finalEconomics.breakEven, 2)} />
            <QuoteRow label="Expiry" value={fullDateLabel(expiry)} />
            <QuoteRow label="Margin after" value={firm?.marginAfter ? money(firm.marginAfter, 2) : 'Calculated on quote'} />

            {quoteError && <div className="inline-error">{quoteError}</div>}

            {!firm && (
              <button className="primary wide" disabled={quoteBusy || sessionBusy} onClick={() => requestQuote()}>
                {quoteBusy ? 'Waiting for Derive makers…' : sessionBusy ? 'Connecting wallet…' : session ? 'Get firm Derive quote' : 'Connect wallet & get quote'}
              </button>
            )}

            {firm && (
              <>
                <div className={'quote-timer ' + (quoteExpired ? 'expired' : '')}>
                  {quoteExpired ? 'Quote expired' : 'RFQ valid for ' + quoteSeconds + 's'}
                </div>
                <label className="risk-check">
                  <input type="checkbox" checked={riskAccepted} onChange={(e) => setRiskAccepted(e.target.checked)} />
                  <span>I understand the maximum loss is {money(finalEconomics.maxLoss, 2)} and this is a real Derive testnet trade.</span>
                </label>
                {quoteExpired ? (
                  <button className="primary wide" onClick={() => requestQuote(session)} disabled={quoteBusy}>
                    {quoteBusy ? 'Refreshing…' : 'Refresh quote'}
                  </button>
                ) : (
                  <button className="primary wide" disabled={!riskAccepted || executeBusy} onClick={execute}>
                    {executeBusy ? 'Signing & executing…' : 'Confirm trade'}
                  </button>
                )}
              </>
            )}
          </aside>
        </section>
      </main>
    );
  }

  const selectedAsset = assets.find((row) => row.symbol === asset);
  const targetMin = targetStrikes[0] ?? (market?.spot ?? 0) * 1.02;
  const targetMax = targetStrikes[targetStrikes.length - 1] ?? (market?.spot ?? 0) * 1.6;

  return (
    <main className="app-shell">
      <Header session={session} onConnect={connect} onDisconnect={async () => {
        await disconnectTradingSession();
        setSession(null);
      }} busy={sessionBusy} />

      <section className="builder">
        <div className="builder-meta">
          <div className="meta-cluster">
            <span className="strategy-pill">Call spread</span>
            <span className="live-pill"><i /> Derive V3 testnet</span>
          </div>
          <div className="feed-state">{loadingMarket ? 'Syncing option chain…' : pricingLoading ? 'Pricing selected expiry…' : marketError ? 'Feed issue' : 'Live market data'}</div>
        </div>

        <div className="sentence">
          <span>I want to make</span>
          <button className={'intent-chip profit ' + (panel === 'profit' ? 'active' : '')} onClick={() => setPanel(panel === 'profit' ? null : 'profit')}>
            {money(desiredProfit)} <small>⌄</small>
          </button>
          <span>if</span>
          <button className={'intent-chip asset ' + (panel === 'asset' ? 'active' : '')} onClick={() => setPanel(panel === 'asset' ? null : 'asset')}>
            {asset} <small>⌄</small>
          </button>
          <span>ends above</span>
          <button className={'intent-chip target ' + (panel === 'target' ? 'active' : '')} onClick={() => setPanel(panel === 'target' ? null : 'target')}>
            {target ? money(target) : '…'} <small>⌄</small>
          </button>
          <span>on</span>
          <button className={'intent-chip expiry ' + (panel === 'expiry' ? 'active' : '')} onClick={() => setPanel(panel === 'expiry' ? null : 'expiry')}>
            {expiry ? dateLabel(expiry) : '…'} <small>⌄</small>
          </button>
        </div>

        <div className="panel-stage">
          {panel === 'profit' && (
            <div className="control-panel profit-panel">
              <div className="panel-head">
                <div><span>Desired max profit</span><strong>{money(desiredProfit)}</strong></div>
                <span className="mini-note">Position size adjusts automatically</span>
              </div>
              <div className="numeric-input">
                <span>$</span>
                <input
                  value={desiredProfit}
                  inputMode="numeric"
                  onChange={(e) => setDesiredProfit(clamp(Number(e.target.value) || 0, 100, 100000))}
                />
              </div>
              <SmoothSlider
                value={desiredProfit}
                min={100}
                max={Math.max(10000, desiredProfit * 1.5)}
                step={100}
                format={(v) => '$' + compact(v)}
                onCommit={(v) => setDesiredProfit(v)}
              />
              <div className="panel-foot">
                <span>Indicative debit</span>
                <strong>{preview ? money(preview.estimatedDebit, 2) : '—'}</strong>
              </div>
            </div>
          )}

          {panel === 'asset' && (
            <div className="control-panel asset-panel">
              <div className="panel-title">Options markets</div>
              {!assets.length ? <LoadingLines /> : assets.map((row) => (
                <button className={'asset-row ' + (asset === row.symbol ? 'selected' : '')} key={row.symbol} onClick={() => {
                  setAsset(row.symbol);
                  setPanel(null);
                  setFirm(null);
                }}>
                  <strong>{row.symbol}</strong>
                  <span>{money(row.spot, row.spot < 10 ? 3 : 0)}</span>
                  <span className={row.change24h >= 0 ? 'positive-text' : 'negative-text'}>
                    {row.change24h ? (row.change24h > 0 ? '+' : '') + row.change24h.toFixed(1) + '%' : 'live'}
                  </span>
                  <small>{row.optionCount ? row.optionCount + ' options' : 'options'}</small>
                </button>
              ))}
            </div>
          )}

          {panel === 'target' && (
            <div className="control-panel target-panel">
              <div className="panel-head">
                <div><span>Target settlement price</span><strong>{target ? money(target) : '—'}</strong></div>
                <span className="mini-note">Spot {market ? money(market.spot, market.spot < 10 ? 3 : 0) : '—'}</span>
              </div>
              <div className="price-readout">
                <div>
                  <span>Move from spot</span>
                  <strong>{market && target ? ((target / market.spot - 1) * 100).toFixed(1) + '%' : '—'}</strong>
                </div>
                <div>
                  <span>Executable short strike</span>
                  <strong>{preview ? money(preview.short.strike) : '—'}</strong>
                </div>
              </div>
              {targetStrikes.length ? (
                <SmoothSlider
                  value={target || targetMin}
                  min={targetMin}
                  max={targetMax}
                  step={Math.max((targetMax - targetMin) / 120, 1)}
                  marks={targetStrikes}
                  format={(v) => '$' + number(v, v < 10 ? 2 : 0)}
                  onPreview={(v) => setTarget(v)}
                  onCommit={(v) => setTarget(v)}
                />
              ) : <LoadingLines />}
              <div className="panel-foot">
                <span>Market-implied probability</span>
                <strong>{preview ? Math.round(preview.probability * 100) + '%' : '—'}</strong>
              </div>
              {preview && <div className="method-note">{preview.probabilityMethod}. Final strike snaps only when the gesture completes.</div>}
            </div>
          )}

          {panel === 'expiry' && (
            <div className="control-panel expiry-panel">
              <div className="panel-title">Choose settlement date</div>
              <div className="expiry-list">
                {expiries.slice(0, 10).map((item) => {
                  const isSelected = expiry === item;
                  return (
                    <button className={'expiry-row ' + (isSelected ? 'selected' : '')} key={item} onClick={() => {
                      setExpiry(item);
                      setPanel(null);
                      setFirm(null);
                    }}>
                      <span><strong>{dateLabel(item)}</strong><small>{dte(item)} days</small></span>
                      <span><small>Prob.</small><strong>{isSelected && preview ? Math.round(preview.probability * 100) + '%' : 'price on select'}</strong></span>
                      <span><small>Cost</small><strong>{isSelected && preview ? money(preview.estimatedDebit) : '—'}</strong></span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {marketError && <div className="market-error">{marketError}</div>}

        <div className="derived-strip">
          <div><span>Reference</span><strong>{market ? money(market.spot, market.spot < 10 ? 3 : 0) : '—'}</strong></div>
          <div><span>Long call</span><strong>{preview ? money(preview.long.strike) : '—'}</strong></div>
          <div><span>Short call</span><strong>{preview ? money(preview.short.strike) : '—'}</strong></div>
          <div><span>Probability</span><strong>{preview ? Math.round(preview.probability * 100) + '%' : '—'}</strong></div>
        </div>
      </section>

      <div className="bottom-dock">
        <div className="dock-copy">
          <span>Indicative debit</span>
          <strong>{preview ? money(preview.estimatedDebit, 2) : (loadingMarket || pricingLoading) ? 'Loading…' : 'Unavailable'}</strong>
        </div>
        <button
          className="buy-button"
          disabled={!preview || loadingMarket || pricingLoading}
          onClick={() => {
            setPanel(null);
            setFirm(null);
            setRiskAccepted(false);
            setPhase('review');
          }}
        >
          Review trade <span>→</span>
        </button>
      </div>
    </main>
  );
}

function Header(props: {
  session: TradingSession | null;
  onConnect: () => Promise<TradingSession | null>;
  onDisconnect: () => Promise<void>;
  busy: boolean;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-orb" />
        <span>Intent</span>
        <small>Derive V3</small>
      </div>
      <div className="network-status"><i /> Testnet</div>
      {props.session ? (
        <button className="wallet-button connected" onClick={props.onDisconnect}>
          {props.session.ownerAddress.slice(0, 6)}…{props.session.ownerAddress.slice(-4)}
        </button>
      ) : (
        <button className="wallet-button" onClick={props.onConnect} disabled={props.busy}>
          {props.busy ? 'Connecting…' : 'Connect wallet'}
        </button>
      )}
    </header>
  );
}

function QuoteRow(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="quote-row">
      <span>{props.label}</span>
      <strong className={props.strong ? 'emphasis' : ''}>{props.value}</strong>
    </div>
  );
}

export default App;
