import express from "express";
import { authRouter } from "./routes/auth.js";
import { bindRouter } from "./routes/bind.js";
import { launchesRouter } from "./routes/launches.js";
import { claimablesRouter } from "./routes/claimables.js";
import { feedRouter } from "./routes/feed.js";
import { adminRouter } from "./routes/admin.js";
import { payoutsRouter } from "./routes/payouts.js";
import { offrampsRouter } from "./routes/offramps.js";
import { config } from "./config.js";
import { account } from "./chain.js";

export function createServer() {
  const app = express();
  app.use(express.json());

  // CORS — the static frontend (hoodcash.site + www) POSTs to /launches/submit.
  // Allow the configured origin(s) (comma-separated ok) plus any *.hoodcash.site and the apex.
  const allowList = config.frontendUrl.split(",").map((s) => s.trim()).filter(Boolean);
  const isAllowed = (origin: string) =>
    config.frontendUrl === "*" ||
    allowList.includes(origin) ||
    /^https:\/\/([a-z0-9-]+\.)?hoodcash\.site$/.test(origin);
  app.use((req, res, next) => {
    const origin = req.header("origin") ?? "";
    const allow = config.frontendUrl === "*" ? (origin || "*") : (isAllowed(origin) ? origin : allowList[0] || "");
    res.header("Access-Control-Allow-Origin", allow);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "content-type, authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, keeper: account.address }));

  app.use("/auth", authRouter);         // GET /auth/x/start, GET /auth/x/callback
  app.use("/bind", bindRouter);         // POST /bind, GET /bind/message
  app.use("/launches", launchesRouter); // POST /launches/submit (public, verified) | POST /launches (admin)
  app.use("/claimables", claimablesRouter); // GET /claimables?handle=..
  app.use("/feed", feedRouter);         // GET /feed   (public payout stream + leaderboard)
  app.use("/payouts", payoutsRouter);
  app.use("/offramps", offrampsRouter); // GET /offramps/recent (public) | POST /offramps/log (admin)   // GET /payouts (admin worklist) | POST /payouts/bank-link
  app.use("/admin", adminRouter);       // POST /admin/collect | /sync | /push-fees | /push-allocation

  // ---- operator dashboard (manual X Money / bank payouts) ----
  app.get("/ops", (_req, res) => {
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>HoodCash Ops</title>
<style>
:root{color-scheme:dark}
body{margin:0 auto;max-width:820px;background:#0a0b0a;color:#e8ffe8;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:20px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#8aa08a;font-size:13px;margin:0 0 18px}
input,button,select{font:inherit;border-radius:10px;border:1px solid #22331f;background:#0f130d;color:#e8ffe8;padding:9px 11px}
button{background:#c6ff2e;color:#08120a;border:none;font-weight:700;cursor:pointer}
button.ghost{background:#0f130d;color:#e8ffe8;border:1px solid #22331f;font-weight:500}
.card{background:#0d100c;border:1px solid #1c271a;border-radius:14px;padding:16px;margin:12px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px}
th{color:#8aa08a;font-weight:500;border-bottom:1px solid #1c271a}td{border-bottom:1px solid #12180f}
.tag{font-size:11px;padding:2px 7px;border-radius:999px;background:#12351a;color:#c6ff2e}
.tag.bank{background:#1a2740;color:#7db0ff}
.muted{color:#6f846f}.err{color:#ff7b7b}.ok{color:#c6ff2e}
</style></head><body>
<h1>HoodCash — Ops</h1>
<p class="sub">Private. See what's owed, off-ramp + send via X Money yourself, then log it here.</p>
<div class="card"><div class="row">
  <input id="tok" type="password" placeholder="Admin token" style="flex:1;min-width:200px">
  <button id="btnSave">Save</button><button class="ghost" id="btnRefresh">Refresh</button>
</div><div id="msg" class="sub" style="margin:8px 0 0"></div></div>
<div class="card"><b>Creator fees — escrow pool</b>
  <div id="escstat" class="sub" style="margin:8px 0">Enter token + Refresh.</div>
  <button id="btnClaimEsc">Claim all to custody</button>
  <div id="escmsg" class="sub" style="margin-top:8px"></div>
</div>
<div class="card"><b>Owed to handles</b><div id="worklist" class="muted" style="margin-top:8px">Enter your token and Refresh.</div></div>
<div class="card"><b>Log a payout</b>
  <div class="row" style="margin-top:10px">
    <input id="h" placeholder="handle (e.g. alon)" style="flex:1">
    <input id="usd" placeholder="USD sent (e.g. 25)" style="width:150px">
    <select id="rail"><option value="xmoney">X Money</option><option value="bank">Bank</option></select>
  </div>
  <div class="row" style="margin-top:10px">
    <input id="note" placeholder="note / X Money ref (optional)" style="flex:1">
    <button id="btnPay">Mark paid</button>
  </div><div id="pmsg" class="sub" style="margin-top:8px"></div>
</div>
<div class="card"><b>Log an off-ramp</b>
  <div class="row" style="margin-top:10px">
    <select id="okind"><option value="ach">ACH — USD → X Money</option><option value="deposit">Deposit — ETH → Kraken (manual)</option></select>
    <input id="oamt" placeholder="amount (USD for ACH, ETH for deposit)" style="flex:1;min-width:180px">
  </div>
  <div class="row" style="margin-top:10px">
    <input id="onote" placeholder="note / tx hash (optional)" style="flex:1">
    <button id="btnOff">Log off-ramp</button>
  </div><div id="omsg" class="sub" style="margin-top:8px"></div>
</div>
<div class="card"><b>Protocol fees (15%)</b>
  <div id="pfstat" class="sub" style="margin-top:8px">—</div>
  <button id="btnClaim" style="margin-top:6px;display:none">Claim 15% to keeper</button>
  <div id="cmsg" class="sub" style="margin-top:8px"></div>
</div>
<div class="card"><b>Recent payouts</b><div id="recent" class="muted" style="margin-top:8px">—</div></div>
<div class="card"><b>Recent off-ramps</b><div id="orecent" class="muted" style="margin-top:8px">—</div></div>
<script>
(function(){
  var $=function(id){return document.getElementById(id);};
  var T=localStorage.getItem('hc_ops_tok')||'';
  if(T)$('tok').value=T;
  function msg(t,e){var m=$('msg');m.textContent=t;m.className='sub '+(e?'err':'ok');}
  function H(){return {authorization:'Bearer '+T,'content-type':'application/json'};}
  function usd(c){return c==null?'—':'$'+(c/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
  function esc(x){return String(x==null?'':x).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  $('btnSave').onclick=function(){T=$('tok').value.trim();localStorage.setItem('hc_ops_tok',T);msg('Saved.');load();};
  $('btnRefresh').onclick=load;
  $('btnPay').onclick=markPaid;
  $('btnOff').onclick=logOfframp;
  $('btnClaim').onclick=claimProtocol;
  $('btnClaimEsc').onclick=claimEscrow;
  $('worklist').addEventListener('click',async function(e){
    var sw=e.target.closest('button[data-sweep]');
    if(sw){ var hh=sw.getAttribute('data-sweep'); sw.disabled=true; sw.textContent='Sweeping…';
      try{ var r=await fetch('/payouts/sweep',{method:'POST',headers:H(),body:JSON.stringify({handle:hh})}); var j=await r.json();
        if(j.ok){ msg('Swept '+(+j.amount).toFixed(6)+' WETH for @'+hh+' to keeper.'); load(); }
        else { msg(j.error||'Sweep failed.',1); sw.disabled=false; sw.textContent='Sweep 85%'; }
      }catch(_){ msg('Network error.',1); sw.disabled=false; sw.textContent='Sweep 85%'; }
      return;
    }
    var b=e.target.closest('button[data-h]'); if(!b)return;
    $('h').value=b.getAttribute('data-h');
    var r=b.getAttribute('data-r'); if(r&&r!=='unset')$('rail').value=(r==='bank'?'bank':'xmoney');
    $('usd').focus();
  });
  async function load(){
    if(!T){msg('Enter your admin token.',1);return;}
    try{
      var r=await fetch('/payouts',{headers:H()});
      if(r.status===401){msg('Bad token.',1);return;}
      var j=await r.json();
      var rows=(j.payees||[]).filter(function(p){return (+p.owedWethWei>0)||(p.rail&&p.rail!=='unset');});
      msg('Loaded '+(j.payees||[]).length+' handles.');
      $('worklist').innerHTML = rows.length ?
        '<table><tr><th>Handle</th><th>Rail</th><th>Owed (WETH)</th><th></th></tr>'+rows.map(function(p){
          return '<tr><td>@'+esc(p.handle)+'</td><td><span class="tag '+(p.rail==='bank'?'bank':'')+'">'+esc(p.rail)+'</span></td><td>'+(+p.owedWeth).toFixed(6)+'</td><td><button class="ghost" data-h="'+esc(p.handle)+'" data-r="'+esc(p.rail)+'">Log</button> <button data-sweep="'+esc(p.handle)+'">Sweep 85%</button></td></tr>';
        }).join('')+'</table>' : '<span class="muted">Nothing owed yet.</span>';
    }catch(e){msg('Network error.',1);}
    loadRecent();
  }
  async function markPaid(){
    var h=$('h').value.trim().replace(/^@/,''), u=$('usd').value.trim();
    var rail=$('rail').value, note=$('note').value.trim(), pm=$('pmsg');
    if(!h){pm.textContent='Handle required.';pm.className='sub err';return;}
    try{
      var r=await fetch('/payouts/mark-paid',{method:'POST',headers:H(),body:JSON.stringify({handle:h,rail:rail,usd:u||null,note:note||null})});
      var j=await r.json();
      if(j.ok){pm.textContent='Logged '+usd(j.usdCents)+' to @'+h+' via '+rail+'.';pm.className='sub ok';$('usd').value='';$('note').value='';loadRecent();}
      else{pm.textContent=j.error||'Failed.';pm.className='sub err';}
    }catch(e){pm.textContent='Network error.';pm.className='sub err';}
  }
  async function logOfframp(){
    var kind=$('okind').value, amt=$('oamt').value.trim(), note=$('onote').value.trim(), om=$('omsg');
    var body={kind:kind};
    if(kind==='ach'){ if(!amt){om.textContent='USD amount required.';om.className='sub err';return;} body.usd=amt; body.note=note||null; }
    else { body.eth=amt||null; body.tx=note||null; }
    try{
      var r=await fetch('/offramps/log',{method:'POST',headers:H(),body:JSON.stringify(body)});
      var j=await r.json();
      if(j.ok){om.textContent='Logged '+(kind==='ach'?'ACH USD \u2192 X Money':'deposit ETH \u2192 Kraken')+'.';om.className='sub ok';$('oamt').value='';$('onote').value='';loadOfframps();}
      else{om.textContent=j.error||'Failed.';om.className='sub err';}
    }catch(e){om.textContent='Network error.';om.className='sub err';}
  }
  async function loadRecent(){
    try{
      var r=await fetch('/payouts/recent');var j=await r.json();var ps=j.payouts||[];
      $('recent').innerHTML = ps.length ?
        '<table><tr><th>Handle</th><th>Rail</th><th>USD</th><th>Status</th><th>When</th></tr>'+ps.map(function(p){
          return '<tr><td>@'+esc(p.handle)+'</td><td><span class="tag '+(p.rail==='bank'?'bank':'')+'">'+esc(p.rail)+'</span></td><td>'+usd(p.usdCents)+'</td><td>'+esc(p.status)+'</td><td class="muted">'+new Date(p.at).toLocaleString()+'</td></tr>';
        }).join('')+'</table>' : '<span class="muted">No payouts logged yet.</span>';
    }catch(e){}
  }
  function ethf(wei){ if(wei==null)return '—'; try{var v=Number(BigInt(wei))/1e18; return (v>0&&v<0.0001?v.toExponential(2):v.toFixed(4))+' ETH';}catch(e){return '—';} }
  async function loadProtocol(){
    if(!T)return;
    try{
      var r=await fetch('/payouts/protocol',{headers:H()});
      if(r.status===401)return;
      var j=await r.json();
      var el=$('pfstat');
      if(j.ok){
        el.className='sub';
        el.innerHTML='<b class="ok">'+(+j.accrued).toFixed(6)+' WETH</b> accrued · treasury '+j.treasury.slice(0,8)+'…';
        var btn=$('btnClaim');
        if(j.keeperCanClaim){ btn.style.display=''; }
        else { btn.style.display='none'; el.innerHTML+='<br><span class="muted">Claim from the treasury wallet ('+j.treasury.slice(0,10)+'…) — the keeper is not the treasury.</span>'; }
      } else el.textContent=j.error||'—';
    }catch(e){}
  }
  async function claimProtocol(){
    var cm=$('cmsg');
    try{
      cm.textContent='Claiming…';cm.className='sub';
      var r=await fetch('/payouts/claim-protocol',{method:'POST',headers:H()});
      var j=await r.json();
      if(j.ok){cm.textContent='Claimed '+(+j.amount).toFixed(6)+' WETH to keeper.';cm.className='sub ok';loadProtocol();}
      else{cm.textContent=j.error||'Failed.';cm.className='sub err';}
    }catch(e){cm.textContent='Network error.';cm.className='sub err';}
  }
  async function loadOfframps(){
    try{
      var r=await fetch('/offramps/recent');var j=await r.json();var os=j.offramps||[];
      $('orecent').innerHTML = os.length ?
        '<table><tr><th>Type</th><th>Amount</th><th>To</th><th>Mode</th><th>When</th></tr>'+os.map(function(o){
          var isDep=o.kind==='deposit';
          return '<tr><td><span class="tag '+(isDep?'':'bank')+'">'+(isDep?'DEPOSIT':'ACH')+'</span></td><td>'+(isDep?ethf(o.amountWei):usd(o.usdCents))+'</td><td>'+(isDep?'Kraken':'X Money')+'</td><td class="muted">'+esc(o.mode)+'</td><td class="muted">'+new Date(o.at).toLocaleString()+'</td></tr>';
        }).join('')+'</table>' : '<span class="muted">No off-ramps logged yet.</span>';
    }catch(e){}
  }
  async function loadEscrow(){ if(!T)return; try{ var r=await fetch('/payouts/escrow',{headers:H()}); if(r.status===401)return; var j=await r.json(); var el=$('escstat'); if(j.ok){ el.innerHTML='<b class="ok">'+(+j.eth).toFixed(6)+' ETH</b> claimable · to '+j.collector.slice(0,10)+'…'; } else el.textContent=j.error||'—'; }catch(e){} }
  async function claimEscrow(){ var m=$('escmsg'); m.textContent='Claiming…'; m.className='sub'; try{ var r=await fetch('/payouts/claim-escrow',{method:'POST',headers:H()}); var j=await r.json(); if(j.ok){ m.textContent='Claimed '+(+j.eth).toFixed(6)+' ETH to custody · tx '+String(j.txHash).slice(0,12)+'…'; m.className='sub ok'; loadEscrow(); } else { m.textContent=j.error||'Failed.'; m.className='sub err'; } }catch(e){ m.textContent='Network error.'; m.className='sub err'; } }
  if(T){load();loadOfframps();loadProtocol();} else {loadRecent();loadOfframps();}
  loadEscrow();
})();
</script></body></html>`);
  });

  return app;
}
