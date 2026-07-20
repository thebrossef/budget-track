const test = require('node:test');
const assert = require('node:assert/strict');
const { payPeriod, dashboard } = require('../server');
const ExcelJS = require('exceljs');
const { applyRules, money, parseUpload, parseHoldingsUpload } = require('../src/importers');
const { marketSymbol, assessHolding } = require('../src/market');

test('pay cycle uses the July 23, 2026 Thursday anchor', () => {
  const period = payPeriod('2026-07-23', new Date('2026-07-20T12:00:00'));
  assert.deepEqual(period, { start: '2026-07-09', end: '2026-07-22', nextPay: '2026-07-23' });
});

test('Canadian ticker symbols default to Toronto', () => {
  assert.equal(marketSymbol('xeqt'), 'XEQT.TO');
  assert.equal(marketSymbol('QQQ'), 'QQQ');
  assert.equal(marketSymbol('QQQ', 'NASDAQ'), 'QQQ');
  assert.equal(marketSymbol('IBM', 'NYSE'), 'IBM');
  assert.equal(marketSymbol('SHOP.TO'), 'SHOP.TO');
  assert.equal(marketSymbol('^GSPTSE'), '^GSPTSE');
});

test('merchant rules provide review suggestions', () => {
  const [row] = applyRules([{ description: 'LOBLAWS #101', category: 'needs', subcategory: 'Uncategorised' }], [{ pattern: 'loblaws', category: 'needs', subcategory: 'Groceries' }]);
  assert.equal(row.subcategory, 'Groceries');
  assert.equal(row.confidence, 0.95);
});

test('money handles Canadian statement formats', () => {
  assert.equal(money('$1,234.56'), 1234.56);
  assert.equal(money('(42.10)'), -42.1);
});

test('portfolio assessment flags concentrated positions', () => {
  const holding = { shares: 100, costBasis: 10 };
  const quote = { price: 20, closes: Array.from({ length: 60 }, (_, i) => 10 + i / 6) };
  const result = assessHolding(holding, quote, 2000);
  assert.equal(result.signal, 'hold');
  assert.ok(result.reasons.some((reason) => reason.includes('concentration')));
});

test('diversified ETFs are not treated like concentrated single stocks', () => {
  const holding = { name: 'Global Equity ETF Portfolio', sector: 'Global equity', shares: 100, costBasis: 10 };
  const quote = { price: 20, closes: Array.from({ length: 60 }, (_, i) => 10 + i / 6) };
  const result = assessHolding(holding, quote, 2000);
  assert.ok(result.reasons.some((reason) => reason.includes('diversified fund')));
  assert.ok(!result.reasons.some((reason) => reason.includes('concentration is high')));
});

test('USD holdings convert to CAD for portfolio totals', () => {
  const holding = { name: 'US ETF', sector: 'ETF', shares: 10, costBasis: 400 };
  const quote = { currency: 'USD', price: 500, closes: Array.from({ length: 60 }, (_, i) => 450 + i) };
  const result = assessHolding(holding, quote, 6850, 1.37);
  assert.equal(Math.round(result.marketValue), 6850);
  assert.equal(Math.round(result.gain), 1370);
});

test('modern Excel statements parse into review rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Transactions');
  sheet.addRow(['Date', 'Description', 'Debit', 'Credit']);
  sheet.addRow(['2026-07-18', 'BMO test purchase', 12.34, '']);
  const buffer = await workbook.xlsx.writeBuffer();
  const rows = await parseUpload({ originalname: 'statement.xlsx', buffer: Buffer.from(buffer) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'BMO test purchase');
  assert.equal(rows[0].amount, 12.34);
});

test('Wealthsimple-style holdings parse for approval', async () => {
  const buffer = Buffer.from('Symbol,Security Name,Quantity,Average Cost,Account Type\nXEQT,iShares Core Equity ETF,12.5,31.25,TFSA');
  const rows = await parseHoldingsUpload({ originalname: 'holdings.csv', buffer });
  assert.deepEqual(rows[0], { symbol: 'XEQT', name: 'iShares Core Equity ETF', shares: 12.5, costBasis: 31.25, exchange: 'TSX', accountType: 'TFSA', sector: '' });
});

test('dashboard respects the three category rule', () => {
  const state = { settings: { nextPayDate: '2026-07-23', incomePerPay: 2000, budget: { needs: 50, wants: 30, savings: 20 }, debtMethod: 'avalanche' }, accounts: [], transactions: [], bills: [], goals: [], debts: [], holdings: [], marketReports: [], importBatches: [] };
  const result = dashboard(state);
  assert.deepEqual(result.targets, { needs: 1000, wants: 600, savings: 400 });
});
