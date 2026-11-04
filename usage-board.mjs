// Usage board for a small external screen. Run: node usage-board.mjs  ->  http://localhost:7777  (?accent=RRGGBB to retint)
// Reads local CLI auth/session files read-only; never refreshes tokens (that could log the CLIs out).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7777;
const TTL = { default: 30_000, Claude: 300_000 }; // Claude's usage endpoint is undocumented and rate-limits (429) when polled often
const RETRY_AFTER_FAIL = 120_000;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const getJson = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (r.status === 401) throw new Error('auth rejected - token expired?');
  if (r.status === 429) throw new Error('rate limited - retrying shortly');
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
      // A window that already reset has nothing used and nothing left to count down to.
      const bar = (w) => {
        const over = w.resets_at * 1000 < Date.now();
        return { label: winLabel(w.window_minutes), pct: over ? 0 : w.used_percent, resets: over ? null : w.resets_at * 1000 };
      };
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
  if (!key) throw new Error('no API key - set OPENROUTER_API_KEY in .env next to this file');
  const auth = { Authorization: 'Bearer ' + key };
  const { data: k } = await getJson('https://openrouter.ai/api/v1/key', auth);
  const credits = await getJson('https://openrouter.ai/api/v1/credits', auth).catch(() => null);
  const balance = k.limit_remaining ?? (credits ? credits.data.total_credits - credits.data.total_usage : null);
  return { spend: { today: k.usage_daily, week: k.usage_weekly, month: k.usage_monthly, total: k.usage }, balance };
}

const sources = { Claude: claude, Codex: codex, Kimi: kimi, OpenRouter: openrouter };
const cache = {};
const lastGood = {};
// A failed refresh keeps the last good reading, flagged stale, so the screen never shows a bare error where numbers used to be.
const load = async (name) => {
  const hit = cache[name];
  if (hit && Date.now() < hit.until) return hit.val;
  let val;
  let failed = false;
  try {
    val = { name, ...(await sources[name]()), at: Date.now() };
    lastGood[name] = val;
  } catch (e) {
    failed = true;
    val = lastGood[name] ? { ...lastGood[name], stale: e.message } : { name, error: e.message };
  }
  cache[name] = { until: Date.now() + (failed ? RETRY_AFTER_FAIL : TTL[name] ?? TTL.default), val };
  return val;
};

const PAGE = `<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content=dark><title>Usage Board</title>
<style>
:root{--accent:#6ea8ff;--fg:#f2f5fb;--dim:#aab4c8;--ok:#4ade80;--warn:#f5b73d;--bad:#ff6b6b;
  --glass:linear-gradient(160deg,rgba(255,255,255,.13),rgba(255,255,255,.04));--edge:rgba(255,255,255,.16);
  --num:Bahnschrift,"Segoe UI Variable Display","SF Pro Display",system-ui,sans-serif;--ui:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}
html{font-size:clamp(12px,3.6vmin,48px);background:#070912}
body{margin:0;height:100vh;display:grid;grid-template-rows:minmax(0,1fr) auto;overflow:hidden;color:var(--fg);font:1rem/1.25 var(--ui)}
::selection{background:color-mix(in srgb,var(--accent) 55%,transparent);color:#fff}
body::before{content:"";position:fixed;inset:-25vmax;z-index:-1;animation:drift 70s ease-in-out infinite alternate;
  background:radial-gradient(closest-side at 22% 18%,color-mix(in srgb,var(--accent) 50%,transparent),transparent),
    radial-gradient(closest-side at 82% 86%,rgba(110,70,255,.42),transparent),
    radial-gradient(closest-side at 78% 14%,color-mix(in srgb,var(--accent) 22%,transparent),transparent)}
@keyframes drift{to{transform:translate3d(4vmax,-3vmax,0) rotate(9deg) scale(1.1)}}
main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:.6rem;padding:.6rem .6rem 0;transition:opacity .4s}
@media (max-aspect-ratio:1/1){main{grid-template-columns:minmax(0,1fr)}}
.card{background:var(--glass);border:1px solid var(--edge);border-radius:.9rem;padding:.8em 1em;display:flex;flex-direction:column;gap:.5em;overflow:hidden;
  backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);
  box-shadow:0 .5em 1.6em rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.2)}
.body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:safe center;gap:.5em}
h2{margin:0;font:600 .95em var(--ui);letter-spacing:.06em;text-transform:uppercase;display:flex;align-items:center;gap:.55em}
h2::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--accent)}
h2 small{margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:var(--dim);font-size:.85em}
.top{display:flex;justify-content:space-between;align-items:baseline}
.lbl{color:var(--dim);font-size:.8em;letter-spacing:.08em;text-transform:uppercase}
.pct,.mid{font-family:var(--num);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.05}
.pct{font-size:2.1em}.dense .pct{font-size:1.5em}
.track{height:.55em;margin:.15em 0 .25em;background:rgba(255,255,255,.14);border-radius:.3em;box-shadow:inset 0 0 0 1px rgba(255,255,255,.34);overflow:hidden}
.fill{height:100%;border-radius:.3em;background:var(--c);box-shadow:0 .1em .35em color-mix(in srgb,var(--c) 60%,transparent)}
.dim{color:var(--dim);font-size:.8em}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:.5em}
.mid{font-size:1.9em}
h2 small.warn{color:var(--warn)}
.stale .row{opacity:.55}
.bad{border-color:rgba(255,107,107,.4)}
.msg b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--bad);font-weight:600}
.msg code{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:.35em;color:var(--dim);font:.8em ui-monospace,"Cascadia Mono",monospace}
footer{display:flex;justify-content:flex-end;align-items:center;gap:.5em;padding:.3em .8rem .45em;color:var(--dim);font-size:.8rem}
.dot{width:.5em;height:.5em;border-radius:50%;background:var(--ok);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.3}}
body.off main{opacity:.45}body.off .dot{background:var(--bad);animation:none}
@media (prefers-reduced-motion:reduce){body::before,.dot{animation:none}}
</style>
<main id=m aria-live=off></main><footer><i class=dot></i><span id=f>loading…</span></footer>
<script>
const q=new URLSearchParams(location.search).get('accent');
if(/^[0-9a-f]{3,8}$/i.test(q||''))document.documentElement.style.setProperty('--accent','#'+q);
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const col=p=>p>=85?'var(--bad)':p>=60?'var(--warn)':'var(--ok)';
const fmt=o=>new Intl.NumberFormat([],{style:'currency',currency:'USD',...o});
const usd=fmt({}),usd0=fmt({maximumFractionDigits:0}),usdK=fmt({notation:'compact',maximumFractionDigits:1});
const money=n=>n==null?'–':(n>=1e4?usdK:n>=100?usd0:usd).format(n);
const ago=ms=>{const m=Math.max(0,Math.round((Date.now()-ms)/6e4));return m<1?'just now':m<60?m+'m ago':Math.round(m/60)+'h ago'};
function eta(ms){if(!ms)return'';const d=ms-Date.now();if(d<=0)return'resetting';const m=Math.round(d/6e4);
  if(m<60)return'resets in '+m+'m';if(m<1440)return'resets in '+Math.floor(m/60)+'h '+(m%60)+'m';
  return'resets '+new Date(ms).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}
function card(s){
  const c=el('section','card'),h=el('h2',0,s.name),body=el('div','body');
  if(s.plan||s.stale){const sm=el('small',s.stale?'warn':0,[s.plan,s.stale&&'stale '+ago(s.at)].filter(Boolean).join(' · '));
    if(s.stale)sm.title=s.stale;h.append(sm)}
  c.append(h,body);
  if(s.error){c.classList.add('bad');const[head,hint]=s.error.split(' - '),m=el('div','msg');
    m.append(el('b',0,head));if(hint)m.append(el('code',0,hint.replace(/\\x60/g,'')));body.append(m);return c}
  if(s.stale)c.classList.add('stale');
  const dense=(s.bars||[]).length>2;if(dense)c.classList.add('dense');
  for(const b of s.bars||[]){
    const n=Math.round(Number(b.pct))||0,r=el('div','row'),t=el('div','top');
    t.append(el('span','lbl',dense&&b.resets?b.label+' · '+eta(b.resets):b.label),el('span','pct',n+'%'));
    const tr=el('div','track'),f=el('div','fill');
    tr.setAttribute('role','progressbar');tr.setAttribute('aria-label',s.name+' '+b.label);
    tr.setAttribute('aria-valuenow',n);tr.setAttribute('aria-valuemin',0);tr.setAttribute('aria-valuemax',100);
    f.style.width=Math.min(100,n)+'%';f.style.setProperty('--c',col(n));tr.append(f);
    r.append(t,tr);if(!dense)r.append(el('div','dim',eta(b.resets)));body.append(r)}
  if(s.asOf)body.append(el('div','dim','last activity '+new Date(s.asOf).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})));
  if(s.spend){const g=el('div','trio');
    for(const k of['today','week','month']){const d=el('div');d.append(el('div','mid',money(s.spend[k])),el('div','lbl',k));g.append(d)}
    body.append(g,el('div','dim','all-time '+money(s.spend.total)+'  ·  balance '+money(s.balance)))}
  return c}
async function tick(){try{const r=await fetch('/api');if(!r.ok)throw 0;const d=await r.json();
  document.getElementById('m').replaceChildren(...d.map(card));document.body.classList.remove('off');
  document.getElementById('f').textContent='updated '+new Date().toLocaleTimeString()}
  catch{document.body.classList.add('off');document.getElementById('f').textContent='offline · retrying'}}
tick();setInterval(tick,15000);
</script>`;

if (process.argv.includes('--check')) {
  const assert = (await import('node:assert')).strict;
  assert.equal(winLabel(300), '5h');
  assert.equal(winLabel(10080), '7d');
  assert.equal(winLabel(45), '45m');
  // a failing refresh must keep the last good reading, flagged stale, instead of replacing it with a bare error
  let fail = false;
  sources.T = async () => { if (fail) throw new Error('boom'); return { bars: [] }; };
  const ok = await load('T');
  assert.equal(ok.stale, undefined);
  fail = true;
  delete cache.T;
  const bad = await load('T');
  assert.equal(bad.stale, 'boom');
  assert.equal(bad.at, ok.at);
  delete cache.T; delete lastGood.T;
  sources.T = async () => { throw new Error('first run'); };
  assert.equal((await load('T')).error, 'first run');
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
