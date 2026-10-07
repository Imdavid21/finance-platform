import {
  DeriveClient,
  NETWORKS,
  channel,
  randomNonce,
  type RfqLeg,
} from '@derivexyz/derive-ts';
import { AbiCoder, BrowserProvider, Wallet, getAddress, type JsonRpcSigner } from 'ethers';
import {
  normalizeTickers,
  parseOptionInstrument,
  type OptionContract,
  type SpreadPreview,
  type TickerPoint,
} from './strategy';

export const NETWORK = 'testnet' as const;
export const TESTNET_APP_URL = 'https://testnet.app.derive.xyz/developers';

export interface AssetSummary {
  symbol: string;
  spot: number;
  change24h: number;
  optionCount: number;
}

export interface MarketState {
  asset: string;
  spot: number;
  options: OptionContract[];
  tickers: Map<string, TickerPoint>;
}

export interface TradingSession {
  ownerAddress: string;
  sessionPrivateKey: string;
  subaccountId: number;
  client: DeriveClient;
}

export interface FirmQuote {
  rfqId: string;
  validUntil: number;
  rawQuote: any;
  debit: number;
  longPrice: number;
  shortPrice: number;
  marginAfter?: number;
}

declare global {
  interface Window {
    ethereum?: any;
  }
}

const publicClient = new DeriveClient({ network: NETWORK });
let publicWsConnected = false;
let tradingSession: TradingSession | null = null;

const CANDIDATES = ['ETH', 'BTC', 'SOL', 'HYPE', 'SFP', 'DOGE'];

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function optionCount(currency: string): Promise<number> {
  try {
    const result = await publicClient.marketData.getInstruments({
      instrumentType: 'option',
      currency,
      pageSize: 1,
    });
    return n((result as any)?.pagination?.count, (result as any)?.instruments?.length ?? 0);
  } catch {
    return 0;
  }
}

export async function loadAssetCatalog(): Promise<AssetSummary[]> {
  const currencies = await publicClient.marketData.getAllCurrencies();
  const priceMap = new Map<string, any>(currencies.map((c: any) => [String(c.currency).toUpperCase(), c]));
  const counts = await Promise.all(CANDIDATES.map((symbol) => optionCount(symbol)));
  return CANDIDATES.map((symbol, index) => {
    const row = priceMap.get(symbol);
    return {
      symbol,
      spot: n(row?.spot_price),
      change24h: n(row?.spot_change_24h ?? row?.change_24h ?? row?.stats?.price_change),
      optionCount: counts[index],
    };
  }).filter((asset) => asset.optionCount > 0 && asset.spot > 0);
}

async function fetchAllOptions(asset: string): Promise<OptionContract[]> {
  const all: OptionContract[] = [];
  let page = 1;
  for (let safety = 0; safety < 20; safety += 1) {
    const result: any = await publicClient.marketData.getInstruments({
      instrumentType: 'option',
      currency: asset,
      page,
      pageSize: 250,
    });
    for (const raw of result?.instruments ?? []) {
      const parsed = parseOptionInstrument(raw);
      if (parsed) all.push(parsed);
    }
    const pagination = result?.pagination ?? {};
    const count = n(pagination.count);
    const pageSize = n(pagination.page_size ?? pagination.pageSize, 250);
    if (!count || all.length >= count || (result?.instruments?.length ?? 0) < pageSize) break;
    page += 1;
  }
  return all;
}

export async function loadMarket(asset: string): Promise<MarketState> {
  const [currencies, options, rawTickers] = await Promise.all([
    publicClient.marketData.getAllCurrencies(),
    fetchAllOptions(asset),
    publicClient.marketData.getTickers({ instrumentType: 'option', currency: asset }),
  ]);
  const currency = (currencies as any[]).find((c) => String(c.currency).toUpperCase() === asset);
  return {
    asset,
    spot: n(currency?.spot_price),
    options,
    tickers: normalizeTickers(rawTickers),
  };
}

export async function subscribeSpot(asset: string, onPrice: (price: number) => void): Promise<() => void> {
  let stopped = false;
  let subscription: any;
  let timer: ReturnType<typeof setInterval> | undefined;

  const poll = async () => {
    if (stopped) return;
    try {
      const ticker: any = await publicClient.marketData.getTicker(asset + '-PERP');
      const price = n(ticker?.I ?? ticker?.M);
      if (price) onPrice(price);
    } catch {
      // Keep the last known price and retry on the next interval.
    }
  };

  try {
    if (!publicWsConnected) {
      await publicClient.connect();
      publicWsConnected = true;
    }
    const tickerChannel = (channel as any)('ticker_slim.{instrument_name}.{interval}', {
      instrument_name: asset + '-PERP',
      interval: '100',
    });
    subscription = await publicClient.subscriptions.subscribe(tickerChannel, (ticker: any) => {
      const price = n(ticker?.I ?? ticker?.M);
      if (price) onPrice(price);
    });
  } catch {
    await poll();
    timer = setInterval(poll, 4000);
  }

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    if (subscription) void subscription.unsubscribe();
  };
}

function randomNanoNonce(): string {
  const random = BigInt(Math.floor(Math.random() * 1_000_000));
  return (BigInt(Date.now()) * 1_000_000n + random).toString();
}

async function authHeaders(signer: JsonRpcSigner, ownerAddress: string) {
  const timestamp = Date.now().toString();
  const signature = await signer.signMessage(timestamp);
  return {
    'Content-Type': 'application/json',
    'X-DeriveWallet': ownerAddress,
    'X-DeriveTimestamp': timestamp,
    'X-DeriveSignature': signature,
  };
}

async function rpcWithOwner(signer: JsonRpcSigner, ownerAddress: string, method: string, params: any) {
  const response = await fetch(NETWORKS.testnet.httpUrl, {
    method: 'POST',
    headers: await authHeaders(signer, ownerAddress),
    body: JSON.stringify({ id: Date.now(), method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message ?? payload?.error?.data ?? 'Derive request failed');
  }
  return payload.result;
}

async function ensureSepolia() {
  if (!window.ethereum) throw new Error('No browser wallet found.');
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0xaa36a7' }],
    });
  } catch (error: any) {
    if (error?.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0xaa36a7',
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        }],
      });
      return;
    }
    throw error;
  }
}

async function registerSessionKey(signer: JsonRpcSigner, ownerAddress: string, sessionWallet: { address: string; privateKey: string }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const keyExpiry = nowSec + 6 * 60 * 60;
  const signatureExpiry = nowSec + 10 * 60;
  const nonce = randomNanoNonce();
  const scopeCode = 10; // trade:rfq:option

  const data = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256[]', 'uint256[]'],
    [sessionWallet.address, keyExpiry, [scopeCode], []],
  );

  const domain = {
    name: 'Matching',
    version: '1.0',
    chainId: NETWORKS.testnet.chainId,
    verifyingContract: '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD',
  };
  const types = {
    Action: [
      { name: 'subaccountId', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'expiry', type: 'uint256' },
      { name: 'owner', type: 'address' },
      { name: 'signer', type: 'address' },
    ],
  };
  const value = {
    subaccountId: 0,
    nonce,
    module: NETWORKS.testnet.modules.setSessionKey,
    data,
    expiry: signatureExpiry,
    owner: ownerAddress,
    signer: ownerAddress,
  };

  const signature = await signer.signTypedData(domain, types, value);
  await rpcWithOwner(signer, ownerAddress, 'private/set_session_key', {
    wallet: ownerAddress,
    public_session_key: sessionWallet.address,
    expiry_sec: keyExpiry,
    subaccount_ids: null,
    nonce,
    signer: ownerAddress,
    signature,
    signature_expiry_sec: signatureExpiry,
    protocol_scopes: ['trade:rfq:option'],
    offchain_scopes: ['account_info'],
    label: 'intent-options-web',
  });
}

async function loginWithSession(ownerAddress: string, privateKey: string): Promise<TradingSession> {
  const client = new DeriveClient({
    network: NETWORK,
    sessionKey: privateKey,
    ownerAddress,
  });
  await client.connect();
  const ids = await client.login();
  const subaccountId = ids[0];
  if (subaccountId == null) {
    await client.close();
    throw new Error('This wallet has no Derive subaccount yet. Fund a Derive testnet account first.');
  }
  tradingSession = { ownerAddress, sessionPrivateKey: privateKey, subaccountId, client };
  return tradingSession;
}

export async function restoreTradingSession(): Promise<TradingSession | null> {
  const owner = sessionStorage.getItem('derive_owner');
  const key = sessionStorage.getItem('derive_session_key');
  if (!owner || !key) return null;
  try {
    return await loginWithSession(owner, key);
  } catch {
    sessionStorage.removeItem('derive_owner');
    sessionStorage.removeItem('derive_session_key');
    return null;
  }
}

export async function connectTradingSession(): Promise<TradingSession> {
  if (tradingSession) return tradingSession;
  if (!window.ethereum) throw new Error('Install or open an EVM browser wallet to continue.');

  await ensureSepolia();
  const provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const signer = await provider.getSigner();
  const ownerAddress = getAddress(await signer.getAddress());

  const sessionWallet = Wallet.createRandom();
  await registerSessionKey(signer, ownerAddress, sessionWallet);
  sessionStorage.setItem('derive_owner', ownerAddress);
  sessionStorage.setItem('derive_session_key', sessionWallet.privateKey);
  return loginWithSession(ownerAddress, sessionWallet.privateKey);
}

export async function disconnectTradingSession() {
  if (tradingSession) await tradingSession.client.close();
  tradingSession = null;
  sessionStorage.removeItem('derive_owner');
  sessionStorage.removeItem('derive_session_key');
}

function quoteDebit(quote: any, preview: SpreadPreview): { debit: number; longPrice: number; shortPrice: number } {
  const legs = quote?.legs ?? [];
  const longLeg = legs.find((leg: any) => leg.instrument_name === preview.long.name);
  const shortLeg = legs.find((leg: any) => leg.instrument_name === preview.short.name);
  const longPrice = n(longLeg?.price);
  const shortPrice = n(shortLeg?.price);
  return {
    debit: Math.max(0, (longPrice - shortPrice) * preview.quantity),
    longPrice,
    shortPrice,
  };
}

export async function requestFirmQuote(session: TradingSession, preview: SpreadPreview): Promise<FirmQuote> {
  const legs: RfqLeg[] = [
    { instrumentName: preview.long.name, amount: preview.quantity.toString(), direction: 'buy' },
    { instrumentName: preview.short.name, amount: preview.quantity.toString(), direction: 'sell' },
  ];

  const rfq: any = await session.client.rfq.sendRfq({
    subaccountId: session.subaccountId,
    legs,
    maxTotalCost: Math.max(preview.estimatedDebit * 1.12, preview.estimatedDebit + 10).toFixed(6),
    label: 'intent-options-web',
  });

  let quote: any = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 700 : 1200));
    const result: any = await session.client.rfq.pollQuotes({
      subaccountId: session.subaccountId,
      rfqId: rfq.rfq_id,
      status: 'open',
    });
    const executable = (result?.quotes ?? []).filter((candidate: any) => candidate.direction === 'sell');
    if (executable.length) {
      quote = executable.reduce((best: any, candidate: any) => {
        const candidateDebit = quoteDebit(candidate, preview).debit;
        const bestDebit = quoteDebit(best, preview).debit;
        return candidateDebit > 0 && (bestDebit <= 0 || candidateDebit < bestDebit) ? candidate : best;
      });
      break;
    }
  }

  if (!quote) {
    await session.client.rfq.cancelRfq({ subaccountId: session.subaccountId, rfqId: rfq.rfq_id });
    throw new Error('No Derive RFQ maker returned an executable quote. Try another expiry or target.');
  }

  const prices = quoteDebit(quote, preview);
  let marginAfter: number | undefined;
  try {
    const margin: any = await session.client.subaccounts.getMargin({
      subaccountId: session.subaccountId,
      simulatedPositionChanges: [
        { instrumentName: preview.long.name, amount: preview.quantity.toString() },
        { instrumentName: preview.short.name, amount: (-preview.quantity).toString() },
      ],
    });
    marginAfter = n(
      margin?.initial_margin ??
      margin?.initial_margin_requirement ??
      margin?.margin?.initial_margin ??
      margin?.margin_requirement,
    ) || undefined;
  } catch {
    marginAfter = undefined;
  }

  return {
    rfqId: rfq.rfq_id,
    validUntil: n(rfq.valid_until, Date.now() + 30_000),
    rawQuote: quote,
    debit: prices.debit,
    longPrice: prices.longPrice,
    shortPrice: prices.shortPrice,
    marginAfter,
  };
}

export async function executeFirmQuote(session: TradingSession, firm: FirmQuote) {
  return session.client.rfq.executeQuote({
    subaccountId: session.subaccountId,
    quote: firm.rawQuote,
    maxFee: '25',
    enableTakerProtection: true,
    label: 'intent-options-web',
  });
}

export async function getPortfolio(session: TradingSession) {
  return session.client.subaccounts.get(session.subaccountId);
}
