// Usage board for a small external screen. Run: node usage-board.mjs  ->  http://localhost:7777
// Reads local CLI auth/session files read-only; never refreshes tokens (that could log the CLIs out).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7777;
const TTL = 30_000;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const getJson = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) throw new Error('auth rejected (token expired?)');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

export const winLabel = (minutes) =>
  minutes >= 1440 && minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm';

// Codex logs its real plan limits into every session file; the newest log line is the freshest reading.
function codex() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
      if (files.length >= 8) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(path.join(H, '.codex/sessions'));
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"primary":{')) continue;
      const j = JSON.parse(lines[i]);
      const rl = j.payload?.rate_limits;
      if (!rl?.primary) continue;
      // A window that already reset has nothing used, whatever the old log line says.
      const bar = (w) => ({
        label: winLabel(w.window_minutes),
        pct: w.resets_at * 1000 < Date.now() ? 0 : w.used_percent,
        resets: w.resets_at * 1000,
      });
      return { plan: rl.plan_type, bars: [bar(rl.primary), bar(rl.secondary)], asOf: Date.parse(j.timestamp) };
    }
  }
  throw new Error('no Codex rate-limit data found');
}

async function claude() {
  const c = readJson(path.join(H, '.claude/.credentials.json')).claudeAiOauth;
  if (c.expiresAt < Date.now()) throw new Error('token expired - open Claude Code once');
  // Undocumented endpoint the Claude Code /usage screen uses; may change without notice.
  const u = await getJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: 'Bearer ' + c.accessToken,
    'anthropic-beta': 'oauth-2025-04-20',
  });
  const bars = [['five_hour', '5h'], ['seven_day', 'week'], ['seven_day_opus', 'week opus'], ['seven_day_sonnet', 'week sonnet']]
    .filter(([k]) => u[k])
    .map(([k, label]) => ({ label, pct: u[k].utilization, resets: Date.parse(u[k].resets_at) }));
  return { plan: c.subscriptionType, bars };
}

async function kimi() {
  const t = readJson(path.join(H, '.kimi/credentials/kimi-code.json'));
  if (t.expires_at * 1000 < Date.now()) throw new Error('login expired - run `kimi` once to re-login');
  // shortcut: response shape taken from memory of kimi-cli, unverified against a live login; unknown shapes show the raw JSON.
  const u = await getJson('https://api.kimi.com/coding/v1/usages', { Authorization: 'Bearer ' + t.access_token });
  const bars = [];
  const add = (label, d) => {
    const limit = Number(d?.limit);
    if (limit > 0) bars.push({ label, pct: ((limit - Number(d.remaining)) / limit) * 100, resets: Date.parse(d.resetTime) || null });
  };
  add('plan', u.usage);
  for (const l of u.limits ?? []) {
    const unit = String(l.window?.timeUnit ?? '');
    const mult = unit.includes('HOUR') ? 60 : unit.includes('DAY') ? 1440 : 1;
    add(winLabel(Number(l.window?.duration) * mult), l.detail);
  }
  if (!bars.length) throw new Error('unrecognised response: ' + JSON.stringify(u).slice(0, 160));
  return { bars };
}

async function openrouter() {
  let key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    try { key = fs.readFileSync(path.join(HERE, '.env'), 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m)?.[1].trim(); } catch { /* no .env */ }
  }
  if (!key) throw new Error('set OPENROUTER_API_KEY (env or .env next to this file)');
  const auth = { Authorization: 'Bearer ' + key };
  const { data: k } = await getJson('https://openrouter.ai/api/v1/key', auth);
  const credits = await getJson('https://openrouter.ai/api/v1/credits', auth).catch(() => null);
  const balance = k.limit_remaining ?? (credits ? credits.data.total_credits - credits.data.total_usage : null);
  return { spend: { today: k.usage_daily, week: k.usage_weekly, month: k.usage_monthly, total: k.usage }, balance };
}

const sources = { Claude: claude, Codex: codex, Kimi: kimi, OpenRouter: openrouter };
const cache = {};
const load = async (name) => {
  const hit = cache[name];
  if (hit && Date.now() - hit.at < TTL) return hit.val;
  let val;
  try { val = { name, ...(await sources[name]()) }; } catch (e) { val = { name, error: e.message }; }
  cache[name] = { at: Date.now(), val };
  return val;
};

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Usage Board</title>
<style>
:root{--bg:#0d0f12;--card:#171a20;--fg:#eef1f5;--dim:#8b93a1;--ok:#3ecf8e;--warn:#f5b73d;--bad:#ff5d5d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:clamp(13px,2.2vw,18px)/1.3 system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;cursor:none}
main{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:10px;padding:10px}
.card{background:var(--card);border-radius:12px;padding:12px 14px}
h2{margin:0 0 8px;font-size:1.1em;display:flex;justify-content:space-between;align-items:baseline}
h2 small{color:var(--dim);font-weight:400;font-size:.75em}
.row{margin:8px 0}.top{display:flex;justify-content:space-between}
.pct{font-size:1.6em;font-weight:700;font-variant-numeric:tabular-nums}
.track{height:10px;background:#262b34;border-radius:5px;overflow:hidden}
.fill{height:100%;border-radius:5px;transition:width .6s}
.dim{color:var(--dim);font-size:.8em}.err{color:var(--bad)}
.big{font-size:1.6em;font-weight:700;font-variant-numeric:tabular-nums}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
footer{padding:0 12px 8px;color:var(--dim);font-size:.7em;text-align:right}
</style>
<main id=m></main><footer id=f>loading…</footer>
<script>
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const col=p=>p>=85?'var(--bad)':p>=60?'var(--warn)':'var(--ok)';
const money=n=>n==null?'–':'$'+(n<10?n.toFixed(2):n.toFixed(0));
function eta(ms){if(!ms)return'';const d=ms-Date.now();if(d<=0)return'reset';const m=Math.round(d/6e4);
  if(m<60)return'resets in '+m+'m';if(m<1440)return'resets in '+Math.floor(m/60)+'h '+(m%60)+'m';
  return'resets '+new Date(ms).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}
function card(s){
  const c=el('div','card'),h=el('h2',0,s.name);
  if(s.plan)h.append(el('small',0,s.plan));c.append(h);
  if(s.error){c.append(el('div','err',s.error));return c}
  for(const b of s.bars||[]){const r=el('div','row'),t=el('div','top');
    t.append(el('span',0,b.label),el('span','pct',Math.round(b.pct)+'%'));
    const tr=el('div','track'),f=el('div','fill');f.style.width=Math.min(100,b.pct)+'%';f.style.background=col(b.pct);tr.append(f);
    r.append(t,tr,el('div','dim',eta(b.resets)));c.append(r)}
  if(s.asOf)c.append(el('div','dim','last activity '+new Date(s.asOf).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})));
  if(s.spend){const g=el('div','grid3');
    for(const k of['today','week','month']){const d=el('div');d.append(el('div','big',money(s.spend[k])),el('div','dim',k));g.append(d)}
    c.append(g,el('div','dim','all-time '+money(s.spend.total)+'  ·  balance '+money(s.balance)))}
  return c}
async function tick(){try{const d=await (await fetch('/api')).json();
  document.getElementById('m').replaceChildren(...d.map(card));
  document.getElementById('f').textContent='updated '+new Date().toLocaleTimeString()}
  catch{document.getElementById('f').textContent='offline - retrying'}}
tick();setInterval(tick,15000);
</script>`;

if (process.argv.includes('--check')) {
  const assert = (await import('node:assert')).strict;
  assert.equal(winLabel(300), '5h');
  assert.equal(winLabel(10080), '7d');
  assert.equal(winLabel(45), '45m');
  console.log('ok');
} else {
  http.createServer(async (req, res) => {
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await Promise.all(Object.keys(sources).map(load))));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    }
  }).listen(PORT, '127.0.0.1', () => console.log('Usage board: http://localhost:' + PORT));
}
