const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dataFile = path.join(dataDir, 'finance.json');

const seed = {
  schemaVersion: 3,
  settings: {
    currency: 'CAD',
    payFrequency: 'biweekly',
    nextPayDate: '2026-07-23',
    incomePerPay: 0,
    budget: { needs: 50, wants: 30, savings: 20 },
    debtMethod: 'avalanche',
    benchmark: '^GSPTSE',
    marketRefreshHour: 18,
    notifications: true
  },
  accounts: [],
  transactions: [],
  merchantRules: [],
  importBatches: [],
  bills: [],
  goals: [],
  debts: [],
  holdings: [],
  portfolioSnapshots: [],
  marketReports: []
};

let state;
let writeQueue = Promise.resolve();

const legacyNasdaqSymbols = new Set(['QQQ', 'QQQM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOG', 'GOOGL', 'TSLA', 'AVGO', 'COST']);
const legacyNyseSymbols = new Set(['SPY', 'VOO', 'VTI', 'IVV', 'DIA', 'IWM', 'SCHD', 'VT']);
const managedInvestmentTypes = new Set(['TFSA Managed', 'RRSP Managed', 'LIRA']);

function normalizedInvestmentAccountType(value) {
  const type = String(value || '').trim().toUpperCase();
  const types = {
    TFSA: 'TFSA',
    'TFSA MANAGED': 'TFSA Managed',
    'MANAGED TFSA': 'TFSA Managed',
    RRSP: 'RRSP Managed',
    'RRSP MANAGED': 'RRSP Managed',
    'MANAGED RRSP': 'RRSP Managed',
    LIRA: 'LIRA'
  };
  return types[type] || value;
}

function normalizeLegacyHolding(holding) {
  const normalized = { ...holding };
  const symbol = String(normalized.symbol || '').trim().toUpperCase();
  normalized.symbol = symbol;
  if (!normalized.exchange) {
    normalized.exchange = symbol.endsWith('.TO') ? 'TSX' : legacyNasdaqSymbols.has(symbol) ? 'NASDAQ' : legacyNyseSymbols.has(symbol) ? 'NYSE' : 'TSX';
  } else normalized.exchange = String(normalized.exchange).trim().toUpperCase();
  normalized.accountType = normalizedInvestmentAccountType(normalized.accountType);
  return normalized;
}

function normalizeLegacyAccount(account) {
  const normalized = { ...account };
  normalized.type = normalizedInvestmentAccountType(normalized.type);
  return normalized;
}

function migrateManagedHoldings(targetState) {
  const managedHoldings = targetState.holdings.filter((holding) => managedInvestmentTypes.has(normalizedInvestmentAccountType(holding.accountType)));
  if (!managedHoldings.length) return 0;
  for (const type of managedInvestmentTypes) {
    const holdings = managedHoldings.filter((holding) => normalizedInvestmentAccountType(holding.accountType) === type);
    if (!holdings.length || targetState.accounts.some((account) => normalizedInvestmentAccountType(account.type) === type && account.kind !== 'liability')) continue;
    const balance = holdings.reduce((sum, holding) => sum + Number(holding.marketValue || (Number(holding.shares || 0) * Number(holding.price || holding.costBasis || 0))), 0);
    targetState.accounts.unshift({
      id: `account_${crypto.randomUUID()}`,
      name: `${type} balance`,
      institution: 'Wealthsimple',
      type,
      kind: 'asset',
      balance,
      includeInNetWorth: true,
      migratedFromLegacyHoldings: true,
      createdAt: new Date().toISOString()
    });
  }
  targetState.holdings = targetState.holdings.filter((holding) => !managedInvestmentTypes.has(normalizedInvestmentAccountType(holding.accountType)));
  return managedHoldings.length;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function load() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    state = clone(seed);
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const previousSchemaVersion = Number(parsed.schemaVersion || 0);
    state = { ...clone(seed), ...parsed, settings: { ...seed.settings, ...(parsed.settings || {}) } };
    const originalHoldings = JSON.stringify(state.holdings || []);
    const originalAccounts = JSON.stringify(state.accounts || []);
    state.holdings = (state.holdings || []).map(normalizeLegacyHolding);
    state.accounts = (state.accounts || []).map(normalizeLegacyAccount);
    const migratedManagedHoldings = previousSchemaVersion < 3 ? migrateManagedHoldings(state) : 0;
    const holdingsChanged = originalHoldings !== JSON.stringify(state.holdings);
    const accountsChanged = originalAccounts !== JSON.stringify(state.accounts);
    if (Number(state.schemaVersion || 0) < seed.schemaVersion || holdingsChanged || accountsChanged) {
      state.schemaVersion = seed.schemaVersion;
      if (previousSchemaVersion < 3 || holdingsChanged || migratedManagedHoldings) state.marketReports = [];
      fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
    }
  } catch (error) {
    const backup = `${dataFile}.corrupt-${Date.now()}`;
    fs.copyFileSync(dataFile, backup);
    state = clone(seed);
    fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
    console.error(`Data file was invalid and preserved at ${backup}`, error);
  }
}

async function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  const tempFile = `${dataFile}.tmp`;
  writeQueue = writeQueue.then(async () => {
    await fs.promises.writeFile(tempFile, snapshot);
    await fs.promises.rename(tempFile, dataFile);
  });
  return writeQueue;
}

function getState() {
  return clone(state);
}

async function mutate(mutator) {
  const result = mutator(state);
  await persist();
  return clone(result);
}

function id(prefix = 'item') {
  return `${prefix}_${crypto.randomUUID()}`;
}

load();

module.exports = { getState, mutate, id, dataFile, migrateManagedHoldings };
