const path = require('node:path');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const pdf = require('pdf-parse');

const DATE_KEYS = ['date', 'transaction date', 'posting date', 'settlement date', 'trade date'];
const DESC_KEYS = ['description', 'merchant', 'details', 'transaction', 'name', 'activity'];
const AMOUNT_KEYS = ['amount', 'transaction amount', 'total', 'value'];
const DEBIT_KEYS = ['debit', 'withdrawal', 'withdrawals', 'money out'];
const CREDIT_KEYS = ['credit', 'deposit', 'deposits', 'money in'];

function normaliseKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function excelDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  }
  const text = String(value || '').trim();
  const date = new Date(text);
  if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function money(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : 0;
}

function findValue(record, choices) {
  const entries = Object.entries(record);
  for (const choice of choices) {
    const match = entries.find(([key]) => normaliseKey(key) === choice);
    if (match) return match[1];
  }
  return undefined;
}

function rowToTransaction(record, source) {
  const date = findValue(record, DATE_KEYS);
  const description = findValue(record, DESC_KEYS);
  const direct = findValue(record, AMOUNT_KEYS);
  const debit = findValue(record, DEBIT_KEYS);
  const credit = findValue(record, CREDIT_KEYS);
  let amount = direct !== undefined ? money(direct) : money(debit) || -money(credit);
  const type = amount < 0 || (credit !== undefined && !debit) ? 'income' : 'expense';
  amount = Math.abs(amount);
  if (!description || !amount) return null;
  return {
    date: excelDate(date),
    description: String(description).trim(),
    amount: Math.round(amount * 100) / 100,
    type,
    category: type === 'income' ? 'income' : 'needs',
    subcategory: type === 'income' ? 'Income' : 'Uncategorised',
    account: source,
    confidence: 0.55
  };
}

async function workbookRecords(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const records = [];
  workbook.eachSheet((sheet) => {
    let headers = [];
    sheet.eachRow((row) => {
      const values = row.values.slice(1).map((value) => value && typeof value === 'object' && 'result' in value ? value.result : value);
      if (!headers.length) { headers = values.map((value) => String(value || '').trim()); return; }
      const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      records.push(record);
    });
  });
  return records;
}

async function parseWorkbook(buffer, filename) {
  return (await workbookRecords(buffer)).map((record) => rowToTransaction(record, filename)).filter(Boolean);
}

function delimitedRecords(buffer, filename) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const delimiter = path.extname(filename).toLowerCase() === '.tsv' ? '\t' : ',';
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true, delimiter, trim: true });
}

function parseDelimited(buffer, filename) {
  return delimitedRecords(buffer, filename).map((record) => rowToTransaction(record, filename)).filter(Boolean);
}

function parsePdfLines(text, filename) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const results = [];
  const patterns = [
    /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(.+?)\s+(-?\(?\$?[\d,]+\.\d{2}\)?)$/,
    /^(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s+(.+?)\s+(-?\(?\$?[\d,]+\.\d{2}\)?)$/,
    /^(\w{3}\s+\d{1,2})\s+(.+?)\s+(-?\(?\$?[\d,]+\.\d{2}\)?)$/i
  ];
  for (const line of lines) {
    let match;
    for (const pattern of patterns) {
      match = line.match(pattern);
      if (match) break;
    }
    if (!match) continue;
    const rawAmount = match[3];
    const amount = Math.abs(money(rawAmount));
    if (!amount) continue;
    const income = /^-/.test(rawAmount) || /^\(/.test(rawAmount) || /payment|deposit|interest paid/i.test(match[2]);
    results.push({
      date: excelDate(match[1]),
      description: match[2].trim(),
      amount,
      type: income ? 'income' : 'expense',
      category: income ? 'income' : 'needs',
      subcategory: income ? 'Income' : 'Uncategorised',
      account: filename,
      confidence: 0.4
    });
  }
  return results;
}

async function parseUpload(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.xlsx') return parseWorkbook(file.buffer, file.originalname);
  if (['.csv', '.tsv'].includes(extension)) return parseDelimited(file.buffer, file.originalname);
  if (extension === '.pdf') {
    const result = await pdf(file.buffer);
    return parsePdfLines(result.text, file.originalname);
  }
  throw new Error('Unsupported file. Upload PDF, XLSX, CSV, or TSV.');
}

async function parseHoldingsUpload(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  let records;
  if (extension === '.xlsx') records = await workbookRecords(file.buffer);
  else if (['.csv', '.tsv'].includes(extension)) records = delimitedRecords(file.buffer, file.originalname);
  else throw new Error('Holdings upload supports XLSX, CSV, or TSV files.');
  return records.map((record) => {
    const symbol = findValue(record, ['symbol', 'ticker', 'security symbol']);
    const name = findValue(record, ['name', 'security name', 'description', 'security']);
    const shares = money(findValue(record, ['shares', 'quantity', 'units']));
    const averageCost = money(findValue(record, ['average cost', 'avg cost', 'cost basis', 'average price', 'book price']));
    const bookValue = money(findValue(record, ['book value', 'total cost']));
    const accountType = findValue(record, ['account type', 'account', 'type']) || 'TFSA';
    const exchange = findValue(record, ['exchange', 'market', 'listing']) || 'TSX';
    if (!symbol || !shares) return null;
    return { symbol: String(symbol).trim().toUpperCase(), name: String(name || symbol).trim(), shares, costBasis: averageCost || (bookValue ? bookValue / shares : 0), exchange: String(exchange).trim().toUpperCase(), accountType: String(accountType).trim(), sector: '' };
  }).filter(Boolean);
}

function applyRules(rows, rules) {
  return rows.map((row) => {
    const description = row.description.toLowerCase();
    const rule = rules.find((item) => description.includes(item.pattern.toLowerCase()));
    return rule ? { ...row, category: rule.category, subcategory: rule.subcategory, confidence: 0.95 } : row;
  });
}

module.exports = { parseUpload, parseHoldingsUpload, applyRules, money, excelDate };
