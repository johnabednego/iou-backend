/**
 * Backend currency rounding and formatting helpers.
 * - GHS: 1 decimal place
 * - USD: nearest whole number (0 decimal places)
 * - Other currencies (e.g. EUR, GBP): 2 decimal places
 */

function normalizeCurrencyCode(currency) {
  return String(currency || 'GHS').toUpperCase().trim() || 'GHS';
}

function getCurrencyDecimals(currency = 'GHS') {
  const code = normalizeCurrencyCode(currency);
  if (code === 'USD') return 0;
  if (code === 'GHS') return 1;
  return 2;
}

function roundCurrencyAmount(amount, currency = 'GHS') {
  const num = Number(amount);
  if (!Number.isFinite(num)) return 0;

  const decimals = getCurrencyDecimals(currency);
  const sign = num < 0 ? -1 : 1;
  const abs = Math.abs(num);

  let rounded;
  if (decimals === 0) {
    rounded = sign * Math.round(abs + 1e-12);
  } else {
    const factor = 10 ** decimals;
    rounded = sign * (Math.round(abs * factor + 1e-9) / factor);
  }

  return rounded === 0 ? 0 : rounded;
}

function formatCurrencyText(amount, currency = 'GHS') {
  const code = normalizeCurrencyCode(currency);
  const decimals = getCurrencyDecimals(code);
  const rounded = roundCurrencyAmount(amount, code);
  const formattedNumber = rounded.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  return `${code} ${formattedNumber}`;
}

function getExcelCurrencyNumFmt(currency = 'GHS') {
  const decimals = getCurrencyDecimals(currency);
  if (decimals === 0) return '#,##0';
  if (decimals === 1) return '#,##0.0';
  return '#,##0.00';
}

module.exports = {
  normalizeCurrencyCode,
  getCurrencyDecimals,
  roundCurrencyAmount,
  formatCurrencyText,
  getExcelCurrencyNumFmt
};
