// IslandCut install counter - a Cloudflare Worker (free plan is plenty).
// Needs one KV namespace bound as STATS. Optional secret STATS_KEY protects the dashboard.
//   POST /ping   {id, event: "install"|"open", version, os}   <- sent by the app
//   GET  /       dashboard (add ?key=YOUR_KEY if you set STATS_KEY)
//   GET  /stats  same numbers as JSON
// Stored per install: only the random id, date, app version and OS family. No IP addresses.

const DAY = 86400;

async function countPrefix(kv, prefix) {
  let n = 0;
  let cursor;
  do {
    const r = await kv.list({ prefix, cursor, limit: 1000 });
    n += r.keys.length;
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return n;
}

const today = (offset = 0) => new Date(Date.now() - offset * DAY * 1000).toISOString().slice(0, 10);

async function stats(env) {
  const installs = await countPrefix(env.STATS, 'i:');
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = today(i);
    days.push({ date: d, active: await countPrefix(env.STATS, `d:${d}:`), newInstalls: await countPrefix(env.STATS, `n:${d}:`) });
  }
  return { installs, activeToday: days[days.length - 1].active, days };
}

function page(s) {
  const max = Math.max(1, ...s.days.map((d) => d.active));
  const bars = s.days
    .map((d) => `<div class="bar" title="${d.date}: ${d.active} active, ${d.newInstalls} new"><i style="height:${(d.active / max) * 100}%"></i><span>${d.date.slice(5)}</span></div>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IslandCut installs</title>
<style>body{margin:0;background:#050506;color:#eee;font:15px system-ui,sans-serif;padding:28px}h1{font-size:18px;font-weight:600;margin:0 0 22px}
.cards{display:flex;gap:14px;flex-wrap:wrap}.card{background:#111114;border:1px solid #222;border-radius:12px;padding:16px 20px;min-width:150px}
.card b{display:block;font-size:34px;margin-top:4px}.chart{display:flex;gap:6px;align-items:flex-end;height:160px;margin-top:28px;max-width:720px}
.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-size:10px;color:#888}.bar i{display:block;width:100%;background:#4f8cff;border-radius:4px 4px 0 0;min-height:2px}</style>
<h1>IslandCut</h1><div class="cards"><div class="card">Total installs<b>${s.installs}</b></div><div class="card">Active today<b>${s.activeToday}</b></div>
<div class="card">New last 14 days<b>${s.days.reduce((a, d) => a + d.newInstalls, 0)}</b></div></div>
<div class="chart">${bars}</div><p style="color:#777;font-size:12px">Daily active installs, last 14 days.</p>`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/ping') {
      let b;
      try {
        b = await req.json();
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const id = String(b.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('bad id', { status: 400 });
      const meta = JSON.stringify({ v: String(b.version || '').slice(0, 20), os: String(b.os || '').slice(0, 12) });
      const d = today();
      if (b.event === 'install' && !(await env.STATS.get(`i:${id}`))) {
        await env.STATS.put(`i:${id}`, meta);
        await env.STATS.put(`n:${d}:${id}`, '1', { expirationTtl: 40 * DAY });
      }
      if (b.event === 'install' || b.event === 'open') await env.STATS.put(`d:${d}:${id}`, '1', { expirationTtl: 40 * DAY });
      return new Response('ok');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/stats')) {
      if (env.STATS_KEY && url.searchParams.get('key') !== env.STATS_KEY) return new Response('add ?key=YOUR_KEY to the address', { status: 401 });
      const s = await stats(env);
      if (url.pathname === '/stats') return Response.json(s, { headers: { 'access-control-allow-origin': '*' } });
      return new Response(page(s), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('IslandCut stats', { status: 404 });
  },
};
