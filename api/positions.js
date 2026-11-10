// Binance Positions API — Vercel Function (region Tokyo, lihat vercel.json)
// Environment Variables di Vercel: BINANCE_KEY, BINANCE_SECRET, ACCESS_TOKEN
const crypto = require('crypto');

const BASE = 'https://fapi.binance.com';
const TF = '15m';
const PER_PAGE = 4;

async function binance(path, signed) {
  let url = BASE + path;
  const headers = {};
  if (signed) {
    const q = `timestamp=${Date.now()}&recvWindow=10000`;
    const sig = crypto.createHmac('sha256', process.env.BINANCE_SECRET).update(q).digest('hex');
    url += (path.includes('?') ? '&' : '?') + `${q}&signature=${sig}`;
    headers['X-MBX-APIKEY'] = process.env.BINANCE_KEY;
  }
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Binance ${r.status}: ${text.slice(0, 120)}`); }
  if (!r.ok) throw new Error(`Binance ${r.status}${data && data.msg ? ': ' + data.msg : ''}`);
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers['x-token'] !== process.env.ACCESS_TOKEN) return res.status(401).json({ error: 'Token salah' });
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const raw = await binance('/fapi/v3/positionRisk', true);
    const all = raw.filter(p => Number(p.positionAmt) !== 0).map(p => {
      const amt = Number(p.positionAmt), entry = Number(p.entryPrice), mark = Number(p.markPrice);
      const pnl = Number(p.unRealizedProfit);
      const notional = Math.abs(Number(p.notional) || amt * mark);
      const im = Number(p.positionInitialMargin) || Number(p.initialMargin) || 0;
      const lev = p.leverage ? Number(p.leverage) : (im > 0 ? Math.max(1, Math.round(notional / im)) : 1);
      const entryMargin = entry * Math.abs(amt) / lev;
      return {
        symbol: p.symbol,
        coin: p.symbol.replace(/(USDT|USDC)$/, ''),
        long: amt > 0, lev, amt: Math.abs(amt), entry, mark, pnl, notional,
        roe: entryMargin > 0 ? pnl / entryMargin * 100 : 0,
      };
    });
    all.sort((a, b) => b.notional - a.notional);

    const start = (page - 1) * PER_PAGE;
    const positions = all.slice(start, start + PER_PAGE);
    await Promise.all(positions.map(async p => {
      const k = await binance(`/fapi/v1/klines?symbol=${p.symbol}&interval=${TF}&limit=40`, false);
      p.candles = k.map(c => [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])]);
    }));

    res.status(200).json({ page, start, count: all.length, total: all.reduce((s, p) => s + p.pnl, 0), positions });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
