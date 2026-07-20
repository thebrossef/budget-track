const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { getState, mutate, id, dataFile } = require('./src/store');
const { parseUpload, parseHoldingsUpload, applyRules } = require('./src/importers');
const { refreshPortfolio } = require('./src/market');

const app = express();
const port = Number(process.env.PORT || 3000);
const appVersion = process.env.APP_VERSION || '2026.07.20.4';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const collections = new Set(['accounts', 'transactions', 'bills', 'goals', 'debts', 'holdings']);
const managedInvestmentTypes = new Set(['TFSA MANAGED', 'RRSP MANAGED', 'LIRA']);

function normalizedAccountType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (type === 'MANAGED TFSA') return 'TFSA MANAGED';
  if (type === 'RRSP' || type === 'MANAGED RRSP') return 'RRSP MANAGED';
  return type;
}
function isManagedInvestmentType(value) { return managedInvestmentTypes.has(normalizedAccountType(value)); }

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  response.setHeader('X-BrossefTracker-Version', appVersion);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders(response) { response.setHeader('Cache-Control', 'no-cache, must-revalidate'); }
}));

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }

function payPeriod(anchorText, date = new Date()) {
  const anchor = new Date(`${anchorText}T12:00:00`);
  const target = new Date(date);
  target.setHours(12, 0, 0, 0);
  const days = Math.floor((target - anchor) / 86400000);
  const periods = Math.floor(days / 14);
  const start = new Date(anchor);
  start.setDate(anchor.getDate() + periods * 14);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);
  const nextPay = new Date(start);
  nextPay.setDate(start.getDate() + 14);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    nextPay: nextPay.toISOString().slice(0, 10)
  };
}

function dashboard(state) {
  const period = payPeriod(state.settings.nextPayDate);
  const periodTransactions = state.transactions.filter((item) => item.approved !== false && item.date >= period.start && item.date <= period.end);
  const spending = { needs: 0, wants: 0, savings: 0 };
  let importedIncome = 0;
  for (const item of periodTransactions) {
    if (item.type === 'income') importedIncome += Number(item.amount) || 0;
    else if (spending[item.category] !== undefined) spending[item.category] += Number(item.amount) || 0;
  }
  Object.keys(spending).forEach((key) => { spending[key] = round(spending[key]); });
  const income = round(state.settings.incomePerPay || importedIncome);
  const targets = Object.fromEntries(Object.entries(state.settings.budget).map(([key, percent]) => [key, round(income * percent / 100)]));
  const accountAssets = state.accounts.filter((item) => item.kind !== 'liability' && item.includeInNetWorth !== false).reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const accountLiabilities = state.accounts.filter((item) => item.kind === 'liability' && item.includeInNetWorth !== false).reduce((sum, item) => sum + Math.abs(Number(item.balance || 0)), 0);
  const marketHoldings = state.holdings.filter((item) => !isManagedInvestmentType(item.accountType));
  const quotedHoldingsValue = state.marketReports[0]?.portfolioValue;
  const holdingsValue = quotedHoldingsValue ?? marketHoldings.reduce((sum, item) => sum + Number(item.shares || 0) * Number(item.price || item.costBasis || 0), 0);
  const managedInvestmentValue = state.accounts.filter((item) => isManagedInvestmentType(item.type) && item.kind !== 'liability').reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const portfolioValue = round(holdingsValue + managedInvestmentValue);
  const debts = state.debts.reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const assets = round(accountAssets + holdingsValue);
  const liabilities = round(accountLiabilities + debts);
  const sortedDebts = [...state.debts].sort(state.settings.debtMethod === 'snowball'
    ? (a, b) => Number(a.balance) - Number(b.balance)
    : (a, b) => Number(b.rate) - Number(a.rate));
  return {
    period,
    income,
    spending,
    targets,
    remaining: round(income - Object.values(spending).reduce((sum, value) => sum + value, 0)),
    assets,
    liabilities,
    netWorth: round(assets - liabilities),
    portfolioValue,
    marketHoldingsValue: round(holdingsValue),
    managedInvestmentValue: round(managedInvestmentValue),
    portfolioGain: round(state.marketReports[0]?.holdings?.reduce((sum, item) => sum + Number(item.assessment?.gain || 0), 0) || 0),
    goalsSaved: round(state.goals.reduce((sum, item) => sum + Number(item.current || 0), 0)),
    nextDebt: sortedDebts[0] || null,
    billsDue: [...state.bills].filter((item) => item.dueDate >= today()).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 5),
    recentTransactions: [...state.transactions].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8),
    pendingImports: state.importBatches.filter((item) => item.status === 'pending').length,
    latestReport: state.marketReports[0] || null
  };
}

app.get('/api/health', (request, response) => response.json({ status: 'ok', version: appVersion, time: new Date().toISOString() }));
app.get('/api/state', (request, response) => {
  const state = getState();
  response.json({ ...state, dashboard: dashboard(state), dataFile: path.basename(dataFile) });
});
app.get('/api/dashboard', (request, response) => {
  const state = getState();
  response.json(dashboard(state));
});

app.put('/api/settings', async (request, response, next) => {
  try {
    const budget = request.body.budget;
    if (budget && round(Number(budget.needs) + Number(budget.wants) + Number(budget.savings)) !== 100) {
      return response.status(400).json({ error: 'Budget percentages must total 100%.' });
    }
    const settings = await mutate((state) => {
      state.settings = { ...state.settings, ...request.body, budget: budget ? { ...state.settings.budget, ...budget } : state.settings.budget };
      return state.settings;
    });
    response.json(settings);
  } catch (error) { next(error); }
});

app.post('/api/:collection', async (request, response, next) => {
  try {
    const { collection } = request.params;
    if (!collections.has(collection)) return next();
    if (collection === 'holdings' && isManagedInvestmentType(request.body.accountType)) return response.status(400).json({ error: 'Managed accounts use a static balance. Add this value from the managed account section instead.' });
    const item = await mutate((state) => {
      const created = { ...request.body, id: id(collection.slice(0, -1)), createdAt: new Date().toISOString() };
      state[collection].unshift(created);
      return created;
    });
    response.status(201).json(item);
  } catch (error) { next(error); }
});

app.put('/api/:collection/:itemId', async (request, response, next) => {
  try {
    const { collection, itemId } = request.params;
    if (!collections.has(collection)) return next();
    if (collection === 'holdings' && isManagedInvestmentType(request.body.accountType)) return response.status(400).json({ error: 'Managed accounts use a static balance. Add this value from the managed account section instead.' });
    const item = await mutate((state) => {
      const index = state[collection].findIndex((entry) => entry.id === itemId);
      if (index < 0) return null;
      state[collection][index] = { ...state[collection][index], ...request.body, id: itemId, updatedAt: new Date().toISOString() };
      return state[collection][index];
    });
    if (!item) return response.status(404).json({ error: 'Item not found.' });
    response.json(item);
  } catch (error) { next(error); }
});

app.delete('/api/:collection/:itemId', async (request, response, next) => {
  try {
    const { collection, itemId } = request.params;
    if (!collections.has(collection)) return next();
    const removed = await mutate((state) => {
      const index = state[collection].findIndex((entry) => entry.id === itemId);
      if (index < 0) return false;
      state[collection].splice(index, 1);
      return true;
    });
    response.status(removed ? 204 : 404).end();
  } catch (error) { next(error); }
});

app.post('/api/imports', upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a file to import.' });
    const state = getState();
    const parsed = await parseUpload(request.file);
    const rows = applyRules(parsed, state.merchantRules).map((row) => ({ ...row, id: id('row') }));
    const batch = await mutate((current) => {
      const created = { id: id('import'), filename: request.file.originalname, institution: request.body.institution || '', status: 'pending', rows, createdAt: new Date().toISOString() };
      current.importBatches.unshift(created);
      return created;
    });
    response.status(201).json(batch);
  } catch (error) { next(error); }
});

app.put('/api/imports/:batchId', async (request, response, next) => {
  try {
    const batch = await mutate((state) => {
      const found = state.importBatches.find((item) => item.id === request.params.batchId);
      if (!found || found.status !== 'pending') return null;
      found.rows = request.body.rows || found.rows;
      return found;
    });
    if (!batch) return response.status(404).json({ error: 'Pending import not found.' });
    response.json(batch);
  } catch (error) { next(error); }
});

app.post('/api/imports/:batchId/approve', async (request, response, next) => {
  try {
    const result = await mutate((state) => {
      const batch = state.importBatches.find((item) => item.id === request.params.batchId);
      if (!batch || batch.status !== 'pending') return null;
      const approvedRows = (request.body.rows || batch.rows).filter((row) => row.include !== false);
      for (const row of approvedRows) {
        state.transactions.unshift({ ...row, id: id('transaction'), source: batch.filename, approved: true, importedAt: new Date().toISOString() });
        if (row.learnRule && row.description) {
          const pattern = row.description.trim().toLowerCase();
          const existing = state.merchantRules.find((rule) => rule.pattern === pattern);
          if (existing) Object.assign(existing, { category: row.category, subcategory: row.subcategory });
          else state.merchantRules.push({ id: id('rule'), pattern, category: row.category, subcategory: row.subcategory });
        }
      }
      batch.status = 'approved';
      batch.approvedAt = new Date().toISOString();
      batch.approvedCount = approvedRows.length;
      delete batch.rows;
      return { imported: approvedRows.length };
    });
    if (!result) return response.status(404).json({ error: 'Pending import not found.' });
    response.json(result);
  } catch (error) { next(error); }
});

app.delete('/api/imports/:batchId', async (request, response, next) => {
  try {
    const removed = await mutate((state) => {
      const index = state.importBatches.findIndex((item) => item.id === request.params.batchId);
      if (index < 0) return false;
      state.importBatches.splice(index, 1);
      return true;
    });
    response.status(removed ? 204 : 404).end();
  } catch (error) { next(error); }
});

app.post('/api/holdings/import', upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: 'Choose a holdings file.' });
    const rows = (await parseHoldingsUpload(request.file)).map((row) => ({ ...row, id: id('holding-row') }));
    response.json({ filename: request.file.originalname, rows });
  } catch (error) { next(error); }
});

app.post('/api/holdings/import/approve', async (request, response, next) => {
  try {
    const rows = (request.body.rows || []).filter((row) => row.include !== false && row.symbol && Number(row.shares) > 0);
    if (rows.some((row) => isManagedInvestmentType(row.accountType))) return response.status(400).json({ error: 'Managed accounts cannot import ticker holdings. Enter their current total as a static managed balance.' });
    const imported = await mutate((state) => {
      for (const row of rows) state.holdings.unshift({ ...row, id: id('holding'), createdAt: new Date().toISOString() });
      return rows.length;
    });
    response.json({ imported });
  } catch (error) { next(error); }
});

let marketRefreshPromise = null;
async function runMarketRefresh() {
  if (marketRefreshPromise) return marketRefreshPromise;
  marketRefreshPromise = (async () => {
    const state = getState();
    const marketHoldings = state.holdings.filter((holding) => !isManagedInvestmentType(holding.accountType));
    if (!marketHoldings.length) throw new Error('Add at least one self-directed stock or ETF before refreshing market data. Managed balances do not need market lookup.');
    const report = await refreshPortfolio(marketHoldings, state.settings.benchmark);
    await mutate((current) => {
      current.marketReports.unshift(report);
      current.marketReports = current.marketReports.slice(0, 90);
      current.portfolioSnapshots.unshift({ date: today(), value: report.portfolioValue });
      current.portfolioSnapshots = current.portfolioSnapshots.filter((item, index, list) => list.findIndex((candidate) => candidate.date === item.date) === index).slice(0, 365);
      for (const assessed of report.holdings) {
        const holding = current.holdings.find((item) => item.id === assessed.id);
        if (holding && assessed.quote) Object.assign(holding, { price: assessed.quote.price, marketValue: assessed.assessment.marketValue, updatedAt: assessed.quote.updatedAt });
      }
    });
    return report;
  })().finally(() => { marketRefreshPromise = null; });
  return marketRefreshPromise;
}

app.post('/api/market/refresh', async (request, response, next) => {
  try { response.json(await runMarketRefresh()); } catch (error) { next(error); }
});

let lastAutomaticRefresh = '';
setInterval(() => {
  const state = getState();
  const date = today();
  const hour = new Date().getHours();
  if (state.holdings.some((holding) => !isManagedInvestmentType(holding.accountType)) && hour >= Number(state.settings.marketRefreshHour || 18) && lastAutomaticRefresh !== date) {
    lastAutomaticRefresh = date;
    runMarketRefresh().catch((error) => console.error('Automatic market refresh failed:', error.message));
  }
}, 30 * 60 * 1000).unref();

app.use((request, response, next) => {
  if (request.method === 'GET') return response.sendFile(path.join(__dirname, 'public', 'index.html'));
  response.status(404).json({ error: 'Route not found.' });
});
app.use((error, request, response, next) => {
  console.error(error);
  const message = error.code === 'LIMIT_FILE_SIZE' ? 'File is larger than the 20 MB limit.' : error.message || 'Unexpected server error.';
  response.status(error.status || 500).json({ error: message });
});

if (require.main === module) {
  app.listen(port, '0.0.0.0', () => console.log(`BrossefTracker is running on http://0.0.0.0:${port}`));
}

module.exports = { app, dashboard, payPeriod, isManagedInvestmentType };
