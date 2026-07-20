const USER_AGENT = 'BrossefTracker/0.1 personal-self-hosted-app';
const LEGACY_NASDAQ_SYMBOLS = new Set(['QQQ', 'QQQM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOG', 'GOOGL', 'TSLA', 'AVGO', 'COST']);
const LEGACY_NYSE_SYMBOLS = new Set(['SPY', 'VOO', 'VTI', 'IVV', 'DIA', 'IWM', 'SCHD', 'VT']);

function inferMarket(symbol, market) {
  const requested = String(market || '').trim().toUpperCase();
  if (requested) return requested;
  const clean = String(symbol || '').trim().toUpperCase();
  if (clean.endsWith('.TO')) return 'TSX';
  if (LEGACY_NASDAQ_SYMBOLS.has(clean)) return 'NASDAQ';
  if (LEGACY_NYSE_SYMBOLS.has(clean)) return 'NYSE';
  return 'TSX';
}

function marketSymbol(symbol, market) {
  const clean = String(symbol || '').trim().toUpperCase();
  if (!clean) return '';
  if (clean.startsWith('^') || clean.includes('.') || clean.includes('-') || clean.includes('=')) return clean;
  if (['NYSE', 'NASDAQ', 'US', 'S&P', 'S&P 500', 'SP500'].includes(inferMarket(clean, market))) return clean;
  return `${clean}.TO`;
}

async function fetchChart(symbol, market) {
  const ticker = marketSymbol(symbol, market);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=6mo`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Market data returned ${response.status} for ${ticker}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || `No market data for ${ticker}`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(Number.isFinite);
  const meta = result.meta || {};
  return {
    symbol: ticker,
    currency: meta.currency || 'CAD',
    exchange: meta.exchangeName || 'TSX',
    price: meta.regularMarketPrice || closes.at(-1) || 0,
    previousClose: meta.chartPreviousClose || closes.at(-2) || 0,
    closes,
    updatedAt: new Date((meta.regularMarketTime || Date.now() / 1000) * 1000).toISOString(),
    delayed: true
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function assessHolding(holding, quote, portfolioValue, cadRate = 1) {
  const closes = quote.closes;
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const start = closes[0] || quote.price;
  const momentum6m = start ? ((quote.price - start) / start) * 100 : 0;
  const conversionRate = quote.currency === 'USD' ? cadRate : 1;
  const marketValue = holding.shares * quote.price * conversionRate;
  const weight = portfolioValue ? (marketValue / portfolioValue) * 100 : 0;
  const diversifiedFund = /etf|fund|portfolio|index|global equity|asset allocation/i.test(`${holding.name || ''} ${holding.sector || ''}`);
  let score = 50;
  const reasons = [];
  if (quote.price > sma20) { score += 8; reasons.push('Price is above its 20-day average.'); }
  else { score -= 8; reasons.push('Price is below its 20-day average.'); }
  if (sma20 > sma50) { score += 10; reasons.push('The medium-term trend is positive.'); }
  else { score -= 10; reasons.push('The medium-term trend is weakening.'); }
  if (momentum6m > 10) { score += 8; reasons.push(`Six-month momentum is ${momentum6m.toFixed(1)}%.`); }
  if (momentum6m < -10) { score -= 8; reasons.push(`Six-month momentum is ${momentum6m.toFixed(1)}%.`); }
  if (!diversifiedFund && weight > 25) { score -= 18; reasons.push(`Position concentration is high at ${weight.toFixed(1)}% of the portfolio.`); }
  else if (!diversifiedFund && weight > 15) { score -= 7; reasons.push(`Position concentration is elevated at ${weight.toFixed(1)}%.`); }
  else if (diversifiedFund && weight > 25) { reasons.push('This appears to be a diversified fund, so its portfolio weight is not treated like a single-stock concentration.'); }
  const capped = Math.max(0, Math.min(100, Math.round(score)));
  const signal = capped >= 68 ? 'buy' : capped <= 35 ? 'sell' : 'hold';
  return {
    signal,
    score: capped,
    reasons,
    metrics: { sma20, sma50, momentum6m, weight },
    marketValue,
    gain: (quote.price - holding.costBasis) * holding.shares * conversionRate,
    gainPercent: holding.costBasis ? ((quote.price - holding.costBasis) / holding.costBasis) * 100 : 0
  };
}

async function refreshPortfolio(holdings) {
  const quoteResults = await Promise.allSettled(holdings.map((holding) => fetchChart(holding.symbol, holding.exchange)));
  const quotes = quoteResults.map((result, index) => result.status === 'fulfilled'
    ? { holding: holdings[index], quote: result.value }
    : { holding: holdings[index], error: result.reason.message });
  let cadPerUsd = 1;
  if (quotes.some((item) => item.quote?.currency === 'USD')) {
    cadPerUsd = (await fetchChart('CAD=X', 'FX')).price;
    if (!cadPerUsd) throw new Error('USD/CAD conversion rate is unavailable. Portfolio totals were not updated.');
  }
  const portfolioValue = quotes.reduce((sum, item) => {
    if (!item.quote) return sum;
    const rate = item.quote.currency === 'USD' ? cadPerUsd : 1;
    return sum + item.holding.shares * item.quote.price * rate;
  }, 0);
  const assessments = quotes.map((item) => item.quote
    ? { ...item.holding, quote: item.quote, assessment: assessHolding(item.holding, item.quote, portfolioValue, cadPerUsd) }
    : { ...item.holding, error: item.error });
  const benchmarkResults = await Promise.allSettled([fetchChart('^GSPTSE', 'INDEX'), fetchChart('^GSPC', 'INDEX')]);
  const benchmarks = {
    tsx: benchmarkResults[0].status === 'fulfilled' ? benchmarkResults[0].value : null,
    sp500: benchmarkResults[1].status === 'fulfilled' ? benchmarkResults[1].value : null
  };
  const concentration = assessments.filter((item) => item.assessment?.reasons.some((reason) => reason.includes('concentration is high')));
  const summary = concentration.length
    ? `Review concentration risk in ${concentration.map((item) => item.symbol).join(', ')} before adding exposure.`
    : 'No individual holding exceeds the 25% concentration alert threshold.';
  return { generatedAt: new Date().toISOString(), delayed: true, portfolioValue, cadPerUsd, benchmarks, holdings: assessments, summary };
}

module.exports = { inferMarket, marketSymbol, fetchChart, assessHolding, refreshPortfolio };
