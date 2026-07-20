const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const dataFile = path.join(dataDir, 'finance.json');

const seed = {
  schemaVersion: 1,
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
    state = { ...clone(seed), ...parsed, settings: { ...seed.settings, ...(parsed.settings || {}) } };
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

module.exports = { getState, mutate, id, dataFile };
