// Binance Positions Worker — Cloudflare Worker
// Perantara antara widget Scriptable dan Binance USDⓈ-M Futures.
// Secrets yang perlu diisi di Settings → Variables and Secrets:
//   BINANCE_KEY    = API Key Binance (read-only)
//   BINANCE_SECRET = Secret Key Binance
//   ACCESS_TOKEN   = token bebas (string acak panjang), juga diisi di Scriptable

const BASE = 'https://fapi.binance.com';
const TF = '15m';
const PER_PAGE = 4;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function binance(path, env, signed) {
  let url = BASE + path;
  const headers = {};
  if (signed) {
    const q = `timestamp=${Date.now()}&recvWindow=10000`;
    url += (path.includes('?') ? '&' : '?') + `${q}&signature=${await hmacHex(env.BINANCE_SECRET, q)}`;
    headers['X-MBX-APIKEY'] = env.BINANCE_KEY;
  }
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Binance ${r.status}: ${text.slice(0, 120)}`); }
  if (!r.ok) throw new Error(`Binance ${r.status}${data && data.msg ? ': ' + data.msg : ''}`);
  return data;
}

export default {
  async fetch(req, env) {
    if (req.headers.get('x-token') !== env.ACCESS_TOKEN) return json({ error: 'Token salah' }, 401);
    try {
      const page = Math.max(1, parseInt(new URL(req.url).searchParams.get('page')) || 1);
      const raw = await binance('/fapi/v3/positionRisk', env, true);
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
        const k = await binance(`/fapi/v1/klines?symbol=${p.symbol}&interval=${TF}&limit=40`, env, false);
        p.candles = k.map(c => [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])]);
      }));

      return json({
        page, start, count: all.length,
        total: all.reduce((s, p) => s + p.pnl, 0),
        positions,
      });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },
};
