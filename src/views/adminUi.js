'use strict';

function renderAdminUi({ functions = [], appName = 'Game Backend' } = {}) {
  const safeAppName = String(appName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fnOpts = functions.map(f => `<option value="${f}">${f}</option>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${safeAppName} - Control Panel</title>
<style>
:root{
  color-scheme:dark;
  --bg:#04060d;--sb:#070c18;--panel:#080e1c;--card:#0c1220;
  --line:#162035;--text:#d1d9e6;--muted:#4a5a7a;
  --accent:#6d28d9;--accent-l:#7c3aed;--accent-glow:rgba(109,40,217,.3);
  --ok:#059669;--ok-l:#10b981;--warn:#b45309;--warn-l:#f59e0b;
  --bad:#b91c1c;--bad-l:#ef4444;--blue:#1d4ed8;--blue-l:#3b82f6;
  --sb-w:210px;--radius:10px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font:13px/1.5 "Inter",-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;height:100vh;overflow:hidden;}

/* -- scrollbar -- */
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px;}

/* -- sidebar -- */
#sb{width:var(--sb-w);min-width:var(--sb-w);background:var(--sb);border-right:1px solid var(--line);display:flex;flex-direction:column;overflow-y:auto;z-index:20;flex-shrink:0;}
.brand{padding:16px 14px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;}
.brand-text h1{font-size:13px;font-weight:700;letter-spacing:-.3px;color:#e2e8f0;}
.brand-text p{font-size:10px;color:var(--muted);}
.ws-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--muted);margin-right:4px;vertical-align:middle;transition:background .3s;}
.ws-dot.live{background:var(--ok-l);}
.ng{padding:8px 10px 3px;font-size:9.5px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;}
.ni{display:flex;align-items:center;gap:8px;padding:6px 10px;margin:1px 6px;border-radius:8px;cursor:pointer;font-size:12px;color:var(--muted);transition:all .1s;}
.ni:hover{background:rgba(255,255,255,.04);color:var(--text);}
.ni.active{background:rgba(109,40,217,.15);color:#a78bfa;font-weight:500;}
.sb-foot{margin-top:auto;padding:8px;border-top:1px solid var(--line);}
.user-pill{display:flex;align-items:center;gap:8px;padding:7px 8px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;margin-bottom:7px;}
.av{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--accent-l),var(--blue-l));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;}
.user-pill .email{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px;}
.user-pill .role{font-size:9.5px;color:var(--muted);}

/* -- main -- */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
#topbar{display:flex;align-items:center;gap:8px;padding:0 14px;height:44px;background:rgba(7,12,24,.8);border-bottom:1px solid var(--line);flex-shrink:0;backdrop-filter:blur(8px);}
.pg-title{font-size:13.5px;font-weight:600;flex:1;letter-spacing:-.2px;}
#content{flex:1;overflow-y:auto;padding:14px;}

/* -- pages -- */
.page{display:none;} .page.active{display:block;}

/* -- layout -- */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
.ga{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;}
.sp{height:12px;}

/* -- cards -- */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:13px;}
.card > h3{font-size:12px;font-weight:600;color:#c4cfe0;margin-bottom:10px;display:flex;align-items:center;gap:6px;}
.card > h3 .sub{font-size:10.5px;font-weight:400;color:var(--muted);margin-left:auto;}

/* -- metrics -- */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:12px;}
.metric{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:11px 12px;}
.metric .lbl{font-size:10px;color:var(--muted);font-weight:500;}
.metric .val{font-size:20px;font-weight:700;margin-top:4px;letter-spacing:-.5px;}
.metric .val.g{color:var(--ok-l);} .metric .val.b{color:var(--blue-l);} .metric .val.y{color:var(--warn-l);} .metric .val.r{color:var(--bad-l);}

/* -- buttons -- */
.btn{display:inline-flex;align-items:center;gap:4px;padding:6px 11px;border-radius:8px;border:none;cursor:pointer;font:500 12px system-ui;transition:opacity .1s,filter .1s;white-space:nowrap;}
.btn:hover{opacity:.85;} .btn:active{filter:brightness(.9);}
.btn-p{background:var(--accent-l);color:#fff;box-shadow:0 1px 3px var(--accent-glow);}
.btn-s{background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--text);}
.btn-ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.25);color:var(--ok-l);}
.btn-d{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:var(--bad-l);}
.btn-w{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);color:var(--warn-l);}
.btn-sm{padding:4px 8px;font-size:11px;border-radius:7px;}
.btn-xs{padding:2px 6px;font-size:10.5px;border-radius:6px;}

/* -- forms -- */
.fg{display:flex;flex-direction:column;gap:3px;}
.fg label{font-size:10.5px;font-weight:500;color:var(--muted);}
input,select,textarea{background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px 9px;font:12.5px system-ui;outline:none;width:100%;transition:border-color .12s;}
input:focus,select:focus,textarea:focus{border-color:rgba(109,40,217,.5);box-shadow:0 0 0 2px rgba(109,40,217,.1);}
input::placeholder{color:var(--muted);}
textarea{min-height:72px;resize:vertical;font-family:'Fira Code',monospace;font-size:11.5px;}
.row{display:flex;gap:7px;flex-wrap:wrap;align-items:flex-end;}
.msg{font-size:11.5px;min-height:16px;padding:3px 0;transition:color .15s;}
.msg.ok{color:var(--ok-l);} .msg.err{color:var(--bad-l);}

/* -- tabs -- */
.tabs{display:flex;gap:1px;border-bottom:1px solid var(--line);margin-bottom:10px;overflow-x:auto;}
.tb{padding:6px 12px;border:none;background:transparent;color:var(--muted);cursor:pointer;font:500 11.5px system-ui;border-bottom:2px solid transparent;transition:all .1s;white-space:nowrap;margin-bottom:-1px;}
.tb:hover{color:var(--text);}
.tb.active{color:#a78bfa;border-bottom-color:var(--accent-l);}
.tp{display:none;} .tp.active{display:block;}

/* -- tables -- */
.tw{overflow:auto;border-radius:8px;border:1px solid var(--line);}
.tw.h160{max-height:160px;} .tw.h220{max-height:220px;} .tw.h280{max-height:280px;}
.tw.h340{max-height:340px;} .tw.h400{max-height:400px;} .tw.h480{max-height:480px;}
table{width:100%;border-collapse:collapse;font-size:11.5px;}
th{position:sticky;top:0;background:#060b18;padding:6px 8px;text-align:left;color:var(--muted);font:600 10.5px system-ui;border-bottom:1px solid var(--line);letter-spacing:.03em;white-space:nowrap;}
td{padding:6px 8px;border-bottom:1px solid rgba(22,32,53,.6);vertical-align:middle;}
td.clip{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(109,40,217,.04);}
.cur{cursor:pointer;}

/* -- badges -- */
.badge{display:inline-flex;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:.02em;}
.b-ok{background:rgba(16,185,129,.12);color:var(--ok-l);}
.b-bad{background:rgba(239,68,68,.12);color:var(--bad-l);}
.b-blue{background:rgba(59,130,246,.12);color:var(--blue-l);}
.b-muted{background:rgba(74,90,122,.12);color:var(--muted);}
.b-warn{background:rgba(245,158,11,.12);color:var(--warn-l);}
.b-purple{background:rgba(109,40,217,.15);color:#a78bfa;}

/* -- pill -- */
.pill{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:10.5px;background:rgba(74,90,122,.1);border:1px solid var(--line);color:var(--muted);}
.pill.ok{background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.2);color:var(--ok-l);}
.pill.live{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.25);color:var(--ok-l);}
.pill.err{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.2);color:var(--bad-l);}

/* -- drawer -- */
#drawer{position:fixed;right:0;top:0;bottom:0;width:580px;background:var(--panel);border-left:1px solid var(--line);z-index:50;transform:translateX(100%);transition:transform .2s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;box-shadow:-8px 0 32px rgba(0,0,0,.4);}
#drawer.open{transform:translateX(0);}
.dh{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--line);flex-shrink:0;}
.dh h3{flex:1;font-size:13px;font-weight:600;}
.db{flex:1;overflow-y:auto;padding:12px;}

/* -- code / json -- */
pre.json{background:#030508;border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;font:11px 'Fira Code',monospace;color:#94a3b8;}

/* -- login -- */
#login{position:fixed;inset:0;background:rgba(4,6,13,.88);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:100;}
.lbox{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px;width:310px;box-shadow:0 24px 64px rgba(0,0,0,.5);}
.lbox h2{font-size:16px;font-weight:700;margin-bottom:18px;text-align:center;color:#e2e8f0;}

/* -- pagination -- */
.pgn{display:flex;gap:6px;align-items:center;margin-top:8px;font-size:11px;color:var(--muted);}
.pgn span{flex:1;text-align:center;}

/* -- progress bar -- */
.pbar{height:3px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:6px;}
.pbar-fill{height:100%;background:linear-gradient(90deg,var(--accent-l),var(--blue-l));border-radius:999px;transition:width .3s;}

/* -- responsive -- */
@media(max-width:820px){
  #sb{position:fixed;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .2s;z-index:30;}
  #sb.open{transform:translateX(0);}
  #drawer{width:100%;}
  .g2,.g3{grid-template-columns:1fr;}
  .metrics{grid-template-columns:repeat(2,1fr);}
}
</style>
</head>
<body>

<!-- Login -->
<div id="login">
<div class="lbox">
  <h2>Control Panel</h2>
  <div class="fg" style="margin-bottom:8px"><label>Email</label><input id="lEmail" type="email" placeholder="admin@example.com" autocomplete="username"/></div>
  <div class="fg" style="margin-bottom:8px"><label>Password</label><input id="lPass" type="password" autocomplete="current-password"/></div>
  <div class="fg" style="margin-bottom:14px"><label>TOTP Code</label><input id="lTotp" inputmode="numeric" maxlength="6" placeholder="000000"/></div>
  <button class="btn btn-p" id="btnLogin" style="width:100%;justify-content:center">Sign in</button>
  <div class="msg" id="loginMsg" style="text-align:center;margin-top:8px;"></div>
</div>
</div>

<!-- Sidebar -->
<nav id="sb">
  <div class="brand">
    <div class="brand-text"><h1>${safeAppName}</h1><p><span class="ws-dot" id="wsDot"></span><span id="wsLbl">offline</span></p></div>
  </div>
  <div class="ng">Overview</div>
  <div class="ni active" data-p="dashboard">Dashboard</div>
  <div class="ng">Players</div>
  <div class="ni" data-p="players">Players</div>
  <div class="ni" data-p="leaderboards">Leaderboards</div>
  <div class="ng">Economy</div>
  <div class="ni" data-p="catalog">Catalog</div>
  <div class="ni" data-p="stores">Stores</div>
  <div class="ni" data-p="titledata">Title Data</div>
  <div class="ni" data-p="loot">Loot Tables</div>
  <div class="ni" data-p="events">Events / Sales</div>
  <div class="ni" data-p="assets">Asset Bundles</div>
  <div class="ng">Tools</div>
  <div class="ni" data-p="cloudscript">CloudScript</div>
  <div class="ni" data-p="bulk">Bulk Actions</div>
  <div class="ni" data-p="jobs">Jobs</div>
  <div class="ni" data-p="analytics">Analytics</div>
  <div class="ng">System</div>
  <div class="ni" data-p="audit">Audit Log</div>
  <div class="ni" data-p="backups">Backups</div>
  <div class="ni" data-p="flags">Feature Flags</div>
  <div class="ni" data-p="admins">Admins</div>
  <div class="ni" data-p="exports">Exports</div>
  <div class="sb-foot">
    <div class="user-pill">
      <div class="av" id="avLtr">A</div>
      <div style="min-width:0"><div class="email" id="avEmail">not signed in</div><div class="role" id="avRole">-</div></div>
    </div>
    <button class="btn btn-s btn-sm" id="btnLogout" style="width:100%;justify-content:center">Sign out</button>
  </div>
</nav>

<!-- Main -->
<div id="main">
  <div id="topbar">
    <span class="pg-title" id="ptitle">Dashboard</span>
    <span class="pill" id="authPill">signed out</span>
    <button class="btn btn-s btn-sm" id="btnRefresh" style="margin-left:4px">Refresh</button>
  </div>
  <div id="content">

    <!-- DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="metrics" id="mGrid">
        <div class="metric"><div class="lbl">Total Players</div><div class="val b" id="mPlayers">-</div></div>
        <div class="metric"><div class="lbl">Active Sessions</div><div class="val g" id="mSessions">-</div></div>
        <div class="metric"><div class="lbl">Req / min</div><div class="val" id="mReqMin">-</div></div>
        <div class="metric"><div class="lbl">DB latency</div><div class="val" id="mDb">-</div></div>
        <div class="metric"><div class="lbl">Redis latency</div><div class="val" id="mRedis">-</div></div>
        <div class="metric"><div class="lbl">Active Bans</div><div class="val y" id="mBans">-</div></div>
        <div class="metric"><div class="lbl">WS Clients</div><div class="val" id="mWs">-</div></div>
        <div class="metric"><div class="lbl">Req / 24 h</div><div class="val" id="mReq24">-</div></div>
      </div>
      <div class="g2">
        <div class="card"><h3>Recent Activity<span class="sub"><button class="btn btn-s btn-xs" id="btnDashAuditRld">Reload</button></span></h3><div class="tw h280"><table><thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Target</th></tr></thead><tbody id="dashAudit"></tbody></table></div></div>
        <div class="card"><h3>Notifications</h3><div class="tw h280"><table><thead><tr><th>Type</th><th>Time</th><th>Details</th></tr></thead><tbody id="dashNotif"></tbody></table></div></div>
      </div>
    </div>

    <!-- PLAYERS -->
    <div class="page" id="page-players">
      <div class="card">
        <div class="row" style="margin-bottom:9px">
          <input id="pSearch" placeholder="PlayFabId - DisplayName - CustomId - Email" style="flex:1"/>
          <button class="btn btn-p btn-sm" id="btnPS">Search</button>
          <button class="btn btn-s btn-sm" id="btnPC">Clear</button>
          <span style="font-size:10.5px;color:var(--muted);align-self:center" id="pMeta"></span>
        </div>
        <div class="tw h480"><table><thead><tr><th>PlayFabId</th><th>Display Name</th><th>Last Login</th><th>GE</th><th>BB</th><th>Status</th><th></th></tr></thead><tbody id="pTable"></tbody></table></div>
        <div class="pgn"><button class="btn btn-s btn-sm" id="pPrev"><</button><span id="pInfo">-</span><button class="btn btn-s btn-sm" id="pNext">></button></div>
      </div>
    </div>

    <!-- LEADERBOARDS -->
    <div class="page" id="page-leaderboards">
      <div class="g2">
        <div class="card">
          <h3>Leaderboard</h3>
          <div class="row" style="margin-bottom:9px">
            <select id="lbSel" style="flex:1"></select>
            <button class="btn btn-p btn-sm" id="btnLbLoad">Load</button>
          </div>
          <div class="tw h400"><table><thead><tr><th>#</th><th>PlayFabId</th><th>Name</th><th>Value</th></tr></thead><tbody id="lbTable"></tbody></table></div>
          <div class="pgn"><button class="btn btn-s btn-sm" id="lbPrev"><</button><span id="lbInfo">-</span><button class="btn btn-s btn-sm" id="lbNext">></button></div>
        </div>
        <div class="card">
          <h3>Set Stat</h3>
          <div class="fg" style="margin-bottom:7px"><label>PlayFabId</label><input id="stPid"/></div>
          <div class="fg" style="margin-bottom:7px"><label>Statistic Name</label><input id="stName" placeholder="Wins - Kills - XP"/></div>
          <div class="fg" style="margin-bottom:9px"><label>Value</label><input id="stVal" type="number"/></div>
          <button class="btn btn-p btn-sm" id="btnStSet">Set</button>
          <div class="msg" id="stMsg"></div>
        </div>
      </div>
    </div>

    <!-- CATALOG -->
    <div class="page" id="page-catalog">
      <div class="card">
        <div class="row" style="margin-bottom:9px">
          <input id="catSearch" placeholder="Search ItemId or DisplayName..." style="flex:2"/>
          <select id="catClass" style="flex:1"><option value="">All classes</option></select>
          <button class="btn btn-p btn-sm" id="btnCatSearch">Search</button>
          <button class="btn btn-ok btn-sm" id="btnCatNew">+ New</button>
          <span style="font-size:10.5px;color:var(--muted);align-self:center" id="catMeta"></span>
        </div>
        <div class="tw h400"><table><thead><tr><th>ItemId</th><th>Class</th><th>DisplayName</th><th>Price</th><th>Bundle</th><th></th></tr></thead><tbody id="catTable"></tbody></table></div>
        <div class="pgn"><button class="btn btn-s btn-sm" id="catPrev"><</button><span id="catInfo">-</span><button class="btn btn-s btn-sm" id="catNext">></button></div>
      </div>
      <div class="sp"></div>
      <div class="card" id="catEdit" style="display:none">
        <h3 id="catEditTitle">Edit Item</h3>
        <div class="g2" style="margin-bottom:8px">
          <div class="fg"><label>ItemId *</label><input id="cItemId"/></div>
          <div class="fg"><label>ItemClass</label><input id="cItemClass"/></div>
          <div class="fg"><label>DisplayName</label><input id="cDisplayName"/></div>
          <div class="fg"><label>CatalogVersion</label><input id="cCatVer" value="1"/></div>
          <div class="fg"><label>Currency (GE/BB/DT/BP)</label><input id="cVc" placeholder="GE"/></div>
          <div class="fg"><label>Price</label><input id="cAmt" type="number"/></div>
          <div class="fg"><label>Consumable Uses</label><input id="cUses" type="number" min="0" value="0"/></div>
          <div class="fg"><label>Usage Period (seconds)</label><input id="cUsagePeriod" type="number" min="0" value="0"/></div>
          <div class="fg"><label>Usage Period Group</label><input id="cUsagePeriodGroup"/></div>
          <div class="fg"><label>Image URL</label><input id="cImg"/></div>
          <div class="fg"><label>Stackable</label><select id="cStack"><option value="false">No</option><option value="true">Yes</option></select></div>
          <div class="fg"><label>Tradable</label><select id="cTrade"><option value="false">No</option><option value="true">Yes</option></select></div>
          <div class="fg"><label>Tags (comma-separated)</label><input id="cTags"/></div>
          <div class="fg"><label>Description</label><input id="cDesc"/></div>
        </div>
        <div class="fg" style="margin-bottom:7px"><label>Bundle Contents (JSON array of ItemIds)</label><textarea id="cBundle">[]</textarea></div>
        <div class="fg" style="margin-bottom:9px"><label>Custom Data (JSON)</label><textarea id="cCustom">{}</textarea></div>
        <div class="row">
          <button class="btn btn-p btn-sm" id="btnCatSave">Save</button>
          <button class="btn btn-s btn-sm" id="btnCatCancel">Cancel</button>
          <button class="btn btn-d btn-sm" id="btnCatDel">Delete</button>
        </div>
        <div class="msg" id="catEditMsg"></div>
      </div>
    </div>

    <!-- STORES -->
    <div class="page" id="page-stores">
      <div class="g2">
        <div class="card">
          <h3>Stores<span class="sub"><button class="btn btn-ok btn-xs" id="btnStoreNew">+ New</button> <button class="btn btn-s btn-xs" id="btnStoreRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>StoreId</th><th>Name</th><th>Items</th><th></th></tr></thead><tbody id="storesTable"></tbody></table></div>
        </div>
        <div class="card" id="storePanel">
          <h3 id="storePanelTitle" style="flex:1">Select a store</h3>
          <div id="storeItemsList" style="margin-bottom:9px"></div>
          <div class="row" style="margin-bottom:7px">
            <div class="fg" style="flex:2"><label>Add/Update Item - ItemId</label><input id="siItemId"/></div>
            <div class="fg" style="flex:1"><label>Currency</label><input id="siVc" placeholder="GE"/></div>
            <div class="fg" style="flex:1"><label>Price</label><input id="siAmt" type="number"/></div>
            <div class="fg" style="flex:1"><label>Sort</label><input id="siSort" type="number" value="0"/></div>
          </div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnSiSave">Add Item</button>
            <button class="btn btn-d btn-sm" id="btnStoreDel" style="display:none">Delete Store</button>
          </div>
          <div class="msg" id="storeMsg"></div>
        </div>
      </div>
    </div>

    <!-- TITLE DATA -->
    <div class="page" id="page-titledata">
      <div class="g2">
        <div class="card">
          <h3>Title Data<span class="sub" id="tdMeta"></span></h3>
          <div class="row" style="margin-bottom:9px">
            <input id="tdSearch" placeholder="Search key or value..." style="flex:1"/>
            <button class="btn btn-p btn-sm" id="btnTdSearch">Search</button>
          </div>
          <div class="tw h400"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody id="tdTable"></tbody></table></div>
          <div class="pgn"><button class="btn btn-s btn-sm" id="tdPrev"><</button><span id="tdInfo">-</span><button class="btn btn-s btn-sm" id="tdNext">></button></div>
        </div>
        <div class="card">
          <h3>Edit / Add</h3>
          <div class="fg" style="margin-bottom:7px"><label>Key</label><input id="tdKey" placeholder="PhotonServerSettings"/></div>
          <div class="fg" style="margin-bottom:9px"><label>Value</label><textarea id="tdVal" style="min-height:120px;font-family:monospace;font-size:11px"></textarea></div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnTdSave">Save</button>
            <button class="btn btn-d btn-sm" id="btnTdDel">Delete</button>
          </div>
          <div class="msg" id="tdMsg"></div>
        </div>
      </div>
    </div>

    <!-- LOOT TABLES -->
    <div class="page" id="page-loot">
      <div class="g2">
        <div class="card">
          <h3>Loot Tables<span class="sub"><button class="btn btn-ok btn-xs" id="btnLootNew">+ New</button> <button class="btn btn-s btn-xs" id="btnLootRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>Key</th><th>Name</th><th>Rolls</th><th>Items</th><th>Active</th><th></th></tr></thead><tbody id="lootTable"></tbody></table></div>
        </div>
        <div class="card" id="lootPanel">
          <h3 id="lootPanelTitle">Select a table</h3>
          <div id="lootItemsList" style="margin-bottom:9px"></div>
          <div class="row" style="margin-bottom:6px">
            <div class="fg" style="flex:2"><label>ItemId</label><input id="liItemId"/></div>
            <div class="fg" style="flex:1"><label>Weight</label><input id="liWeight" type="number" value="100"/></div>
            <div class="fg" style="flex:1"><label>Min Qty</label><input id="liMin" type="number" value="1"/></div>
            <div class="fg" style="flex:1"><label>Max Qty</label><input id="liMax" type="number" value="1"/></div>
          </div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnLiSave">Add/Update Item</button>
            <button class="btn btn-d btn-sm" id="btnLootDel" style="display:none">Delete Table</button>
          </div>
          <div class="msg" id="lootMsg"></div>
        </div>
      </div>
    </div>

    <!-- EVENTS / SALES -->
    <div class="page" id="page-events">
      <div class="g2">
        <div class="card">
          <h3>Economy Events<span class="sub"><button class="btn btn-s btn-xs" id="btnEvRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>Key</th><th>Name</th><th>Type</th><th>Start</th><th>End</th><th>Status</th><th></th></tr></thead><tbody id="evTable"></tbody></table></div>
        </div>
        <div class="card">
          <h3 id="evFormTitle">New Event</h3>
          <div class="g2" style="margin-bottom:8px">
            <div class="fg"><label>Event Key *</label><input id="evKey" placeholder="summer_sale_2026"/></div>
            <div class="fg"><label>Type</label><select id="evType"><option value="sale">sale (price discount)</option><option value="bonus_vc">bonus_vc (currency boost)</option><option value="double_xp">double_xp</option><option value="custom">custom</option></select></div>
            <div class="fg"><label>Display Name</label><input id="evName" placeholder="Summer Sale"/></div>
            <div class="fg"><label>Active</label><select id="evActive"><option value="true">Yes</option><option value="false">No</option></select></div>
            <div class="fg"><label>Starts At (UTC)</label><input id="evStart" type="datetime-local"/></div>
            <div class="fg"><label>Ends At (UTC)</label><input id="evEnd" type="datetime-local"/></div>
          </div>
          <div class="fg" style="margin-bottom:9px">
            <label>Payload JSON - sale: {"items":{"ItemId":20}} - bonus_vc: {"currency":"GE","multiplier":2}</label>
            <textarea id="evPayload" style="min-height:90px;font-size:11px">{}</textarea>
          </div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnEvSave">Save Event</button>
            <button class="btn btn-s btn-sm" id="btnEvClear">New / Clear</button>
            <button class="btn btn-d btn-sm" id="btnEvDel">Delete</button>
          </div>
          <div class="msg" id="evMsg"></div>
        </div>
      </div>
    </div>

    <!-- ASSETS -->
    <div class="page" id="page-assets">
      <div class="g2">
        <div class="card">
          <h3>Asset Bundles<span class="sub"><button class="btn btn-s btn-xs" id="btnAssetsRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>Bundle Key</th><th>Platform</th><th>Version</th><th>Linked Item</th><th>Active</th><th></th></tr></thead><tbody id="assetsTable"></tbody></table></div>
        </div>
        <div class="card">
          <h3>Add / Update Bundle</h3>
          <div class="g2" style="margin-bottom:8px">
            <div class="fg"><label>Bundle Key *</label><input id="aBk" placeholder="android_v3"/></div>
            <div class="fg"><label>Platform</label><input id="aPlatform" placeholder="android - ios - all"/></div>
            <div class="fg"><label>Version</label><input id="aVer"/></div>
            <div class="fg"><label>Linked ItemId</label><input id="aItemId"/></div>
            <div class="fg"><label>Active</label><select id="aActive"><option value="true">Yes</option><option value="false">No</option></select></div>
            <div class="fg"><label>Checksum (SHA256)</label><input id="aChk"/></div>
          </div>
          <div class="fg" style="margin-bottom:7px"><label>CDN URL *</label><input id="aUrl" placeholder="https://cdn.example.com/bundles/..."/></div>
          <div class="fg" style="margin-bottom:9px"><label>Notes</label><input id="aNotes"/></div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnAssetSave">Save</button>
            <button class="btn btn-d btn-sm" id="btnAssetDel">Delete</button>
          </div>
          <div class="msg" id="assetMsg"></div>
        </div>
      </div>
    </div>

    <!-- CLOUDSCRIPT -->
    <div class="page" id="page-cloudscript">
      <div class="g2">
        <div class="card">
          <h3>Console <span class="sub">${functions.length} functions</span></h3>
          <div class="fg" style="margin-bottom:7px"><label>Function</label><select id="csFn">${fnOpts}</select></div>
          <div class="fg" style="margin-bottom:7px"><label>PlayFabId (blank = admin)</label><input id="csPid"/></div>
          <div class="fg" style="margin-bottom:9px"><label>FunctionParameter (JSON)</label><textarea id="csParams">{}</textarea></div>
          <button class="btn btn-p" id="btnCsRun"> Run</button>
          <div class="msg" id="csMsg"></div>
          <div class="sp"></div>
          <label style="font-size:10.5px;color:var(--muted)">Result</label>
          <pre class="json" id="csResult">// result appears here</pre>
        </div>
        <div class="card">
          <h3>History <span class="sub"><button class="btn btn-s btn-xs" id="btnCsHLoad">Reload</button></span></h3>
          <input id="csHFn" placeholder="Filter by function..." style="margin-bottom:7px"/>
          <div class="tw h280"><table><thead><tr><th>Time</th><th>Function</th><th>Player</th><th>ms</th><th>OK</th></tr></thead><tbody id="csHTable"></tbody></table></div>
          <div class="sp"></div>
          <h3>Stats</h3>
          <div class="tw h160"><table><thead><tr><th>Function</th><th>Calls</th><th>OK%</th><th>Avg ms</th></tr></thead><tbody id="csStats"></tbody></table></div>
        </div>
      </div>
    </div>

    <!-- BULK -->
    <div class="page" id="page-bulk">
      <div class="g2">
        <div class="card">
          <h3>Bulk Currency</h3>
          <div class="fg" style="margin-bottom:7px"><label>Player IDs (one per line)</label><textarea id="blkIds" style="min-height:80px" placeholder="ABCD1234&#10;EFGH5678&#10;..."></textarea></div>
          <div class="row" style="margin-bottom:7px">
            <div class="fg" style="flex:1"><label>Currency</label><select id="blkCur"><option>GE</option><option>BB</option><option>DT</option><option>BP</option></select></div>
            <div class="fg" style="flex:2"><label>Amount (negative to remove)</label><input id="blkAmt" type="number"/></div>
          </div>
          <div class="fg" style="margin-bottom:9px"><label>Reason</label><input id="blkReason"/></div>
          <button class="btn btn-p btn-sm" id="btnBlkCur">Queue Job</button>
          <div class="msg" id="blkCurMsg"></div>
        </div>
        <div class="card">
          <h3>Bulk Grant Item</h3>
          <div class="fg" style="margin-bottom:7px"><label>Player IDs (one per line)</label><textarea id="blkIIds" style="min-height:80px" placeholder="ABCD1234&#10;EFGH5678&#10;..."></textarea></div>
          <div class="fg" style="margin-bottom:7px"><label>ItemId</label><input id="blkIItemId"/></div>
          <div class="fg" style="margin-bottom:9px"><label>ItemClass</label><input id="blkIClass"/></div>
          <button class="btn btn-p btn-sm" id="btnBlkItem">Queue Job</button>
          <div class="msg" id="blkItemMsg"></div>
        </div>
      </div>
    </div>

    <!-- JOBS -->
    <div class="page" id="page-jobs">
      <div class="card">
        <h3>Async Jobs<span class="sub"><button class="btn btn-s btn-xs" id="btnJobsRld">Reload</button></span></h3>
        <div class="row" style="margin-bottom:8px">
          <select id="jobStatus" style="width:140px"><option value="">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="done">Done</option><option value="failed">Failed</option></select>
        </div>
        <div class="tw h480"><table><thead><tr><th>Type</th><th>Status</th><th>Queued by</th><th>Created</th><th>Duration</th><th>Result</th></tr></thead><tbody id="jobsTable"></tbody></table></div>
      </div>
    </div>

    <!-- ANALYTICS -->
    <div class="page" id="page-analytics">
      <div class="metrics" id="anGrid">
        <div class="metric"><div class="lbl">Total Players</div><div class="val b" id="anTotal">-</div></div>
        <div class="metric"><div class="lbl">New Today</div><div class="val g" id="anToday">-</div></div>
        <div class="metric"><div class="lbl">Active 7d</div><div class="val g" id="anW">-</div></div>
        <div class="metric"><div class="lbl">Active 30d</div><div class="val" id="anM">-</div></div>
        <div class="metric"><div class="lbl">Active Bans</div><div class="val y" id="anBans">-</div></div>
        <div class="metric"><div class="lbl">CS Calls Today</div><div class="val" id="anCs">-</div></div>
        <div class="metric"><div class="lbl">Total GE in-game</div><div class="val b" id="anGe">-</div></div>
        <div class="metric"><div class="lbl">Total BB in-game</div><div class="val b" id="anBb">-</div></div>
      </div>
      <div class="sp"></div>
      <div class="g2">
        <div class="card">
          <h3>Registrations / Day<span class="sub"><select id="anRegDays" style="font-size:10.5px"><option value="14">14d</option><option value="30" selected>30d</option><option value="90">90d</option></select></span></h3>
          <div id="anRegChart" style="min-height:140px;display:flex;align-items:flex-end;gap:3px;padding:8px 0"></div>
        </div>
        <div class="card">
          <h3>Daily Active Players<span class="sub"><select id="anDauDays" style="font-size:10.5px"><option value="14">14d</option><option value="30" selected>30d</option><option value="90">90d</option></select></span></h3>
          <div id="anDauChart" style="min-height:140px;display:flex;align-items:flex-end;gap:3px;padding:8px 0"></div>
        </div>
      </div>
      <div class="sp"></div>
      <div class="g2">
        <div class="card">
          <h3>Top CloudScript Functions (7d)</h3>
          <div class="tw h280"><table><thead><tr><th>Function</th><th>Calls</th><th>OK%</th><th>Avg ms</th></tr></thead><tbody id="anCsFns"></tbody></table></div>
        </div>
        <div class="card">
          <h3>Top GE Earners</h3>
          <div class="tw h280"><table><thead><tr><th>#</th><th>PlayFabId</th><th>Name</th><th>GE Balance</th></tr></thead><tbody id="anEarners"></tbody></table></div>
        </div>
      </div>
      <div class="sp"></div>
      <div class="card">
        <h3>Admin Actions Breakdown (7d)</h3>
        <div class="tw h220"><table><thead><tr><th>Action</th><th>Count</th><th>Admins</th><th>Last seen</th></tr></thead><tbody id="anActions"></tbody></table></div>
      </div>
    </div>

    <!-- AUDIT -->
    <div class="page" id="page-audit">
      <div class="card" style="margin-bottom:12px">
        <h3>Audit Log<span class="sub"><button class="btn btn-s btn-xs" id="btnAuditRld">Reload</button></span></h3>
        <div class="tw h400"><table><thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Type</th><th>Target</th><th>IP</th></tr></thead><tbody id="auditTable"></tbody></table></div>
      </div>
      <div class="card">
        <h3>Request Log<span class="sub"><button class="btn btn-s btn-xs" id="btnLogsRld">Reload</button></span></h3>
        <div class="tw h280"><table><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>PlayFabId</th></tr></thead><tbody id="logsTable"></tbody></table></div>
      </div>
    </div>

    <!-- BACKUPS -->
    <div class="page" id="page-backups">
      <div class="g2">
        <div class="card">
          <h3>Create Snapshot</h3>
          <div class="fg" style="margin-bottom:9px"><label>Label</label><input id="bkLabel" placeholder="manual"/></div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnBkCreate">Create Snapshot</button>
            <button class="btn btn-s btn-sm" id="btnBkRld">Reload Reload</button>
          </div>
          <div class="msg" id="bkMsg"></div>
        </div>
        <div class="card">
          <h3>Restore / Restart</h3>
          <div class="fg" style="margin-bottom:9px"><label>Select Snapshot</label><select id="bkList"></select></div>
          <div class="row">
            <button class="btn btn-ok btn-sm" id="btnBkRestore">Restore</button>
            <button class="btn btn-w btn-sm" id="btnRestart">Restart App</button>
          </div>
          <div class="msg" id="restoreMsg"></div>
        </div>
      </div>
    </div>

    <!-- FLAGS -->
    <div class="page" id="page-flags">
      <div class="g2">
        <div class="card">
          <h3>Feature Flags<span class="sub"><button class="btn btn-s btn-xs" id="btnFlagsRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>Key</th><th>Value</th><th>Updated by</th></tr></thead><tbody id="flagsTable"></tbody></table></div>
        </div>
        <div class="card">
          <h3>Set Flag</h3>
          <div class="fg" style="margin-bottom:7px"><label>Key</label><input id="flKey" placeholder="maintenance_mode"/></div>
          <div class="fg" style="margin-bottom:7px"><label>Value</label><input id="flVal" placeholder="true"/></div>
          <div class="fg" style="margin-bottom:9px"><label>Description</label><input id="flDesc"/></div>
          <button class="btn btn-p btn-sm" id="btnFlSave">Set</button>
          <div class="msg" id="flMsg"></div>
        </div>
      </div>
    </div>

    <!-- ADMINS -->
    <div class="page" id="page-admins">
      <div class="g2">
        <div class="card">
          <h3>Admin Users<span class="sub"><button class="btn btn-s btn-xs" id="btnAdminsRld">Reload</button></span></h3>
          <div class="tw h400"><table><thead><tr><th>Email</th><th>Role</th><th>Enabled</th><th>Last Login</th><th>Fails</th><th></th></tr></thead><tbody id="adminsTable"></tbody></table></div>
        </div>
        <div class="card">
          <h3>Create / Update</h3>
          <div class="fg" style="margin-bottom:7px"><label>Email</label><input id="adEmail"/></div>
          <div class="fg" style="margin-bottom:7px"><label>Password (blank = keep)</label><input id="adPass" type="password"/></div>
          <div class="fg" style="margin-bottom:7px"><label>TOTP Secret (blank = auto-generate)</label><input id="adTotp"/></div>
          <div class="row" style="margin-bottom:9px">
            <div class="fg" style="flex:1"><label>Role</label><select id="adRole"><option value="moderator">moderator</option><option value="admin">admin</option><option value="superadmin">superadmin</option></select></div>
            <div class="fg" style="flex:1"><label>Enabled</label><select id="adEnabled"><option value="true">Yes</option><option value="false">No</option></select></div>
          </div>
          <div class="row">
            <button class="btn btn-p btn-sm" id="btnAdSave">Save</button>
            <button class="btn btn-s btn-sm" id="btnAdClear">Clear</button>
          </div>
          <div class="msg" id="adMsg"></div>
        </div>
      </div>
    </div>

    <!-- EXPORTS -->
    <div class="page" id="page-exports">
      <div class="card" style="margin-bottom:12px">
        <h3>Export Data</h3>
        <div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:4px">
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/players?format=csv')">Players CSV</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/players?format=json')">Players JSON</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/catalog?format=json')">Catalog JSON</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/titledata?format=json')">Title Data JSON</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/audit?format=json')">Audit JSON</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/export/logs?format=csv')">Logs CSV</button>
          <button class="btn btn-s btn-sm" onclick="dl('/Admin/api/openapi.json')">OpenAPI JSON</button>
        </div>
      </div>
      <div class="g2">
        <div class="card">
          <h3>Import Catalog (JSON)</h3>
          <textarea id="impCatJson" placeholder='[{"ItemId":"SkinA","ItemClass":"Skin","VirtualCurrencyPrices":{"GE":1000}}]' style="min-height:100px;margin-bottom:7px"></textarea>
          <button class="btn btn-p btn-sm" id="btnImpCat">Import</button>
          <div class="msg" id="impCatMsg"></div>
        </div>
        <div class="card">
          <h3>Import Title Data (JSON)</h3>
          <textarea id="impTdJson" placeholder='[{"key":"PhotonAppId","value":"..."}]' style="min-height:100px;margin-bottom:7px"></textarea>
          <button class="btn btn-p btn-sm" id="btnImpTd">Import</button>
          <div class="msg" id="impTdMsg"></div>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- Player Drawer -->
<div id="drawer">
  <div class="dh">
    <h3 id="dTitle">Player</h3>
    <button class="btn btn-s btn-sm" id="btnDRefresh">Reload</button>
    <button class="btn btn-s btn-sm" id="btnDClose">X</button>
  </div>
  <div class="db">
    <div class="tabs" id="dtabs">
      <button class="tb active" data-t="dOv">Overview</button>
      <button class="tb" data-t="dInv">Inventory</button>
      <button class="tb" data-t="dCur">Currencies</button>
      <button class="tb" data-t="dSt">Statistics</button>
      <button class="tb" data-t="dUd">User Data</button>
      <button class="tb" data-t="dRd">Readonly</button>
      <button class="tb" data-t="dFr">Friends</button>
      <button class="tb" data-t="dSess">Sessions</button>
      <button class="tb" data-t="dBan">Bans</button>
      <button class="tb" data-t="dAct">Actions</button>
    </div>
    <div class="tp active" id="tab-dOv"></div>
    <div class="tp" id="tab-dInv"></div>
    <div class="tp" id="tab-dCur"></div>
    <div class="tp" id="tab-dSt"></div>
    <div class="tp" id="tab-dUd"></div>
    <div class="tp" id="tab-dRd"></div>
    <div class="tp" id="tab-dFr"></div>
    <div class="tp" id="tab-dSess"></div>
    <div class="tp" id="tab-dBan"></div>
    <div class="tp" id="tab-dAct"></div>
  </div>
</div>

<script>
(()=>{
'use strict';
const S={token:sessionStorage.getItem('blr_t')||'',ws:null,pid:null,pPage:1,pQ:'',catPage:1,catQ:'',catCls:'',tdPage:1,tdQ:'',tdAll:[],lbOff:0,lbLim:50,storeId:null,lootKey:null};
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const j=v=>JSON.stringify(v,null,2);
const csrf=()=>document.cookie.split('; ').find(c=>c.startsWith('admin_csrf='))?.split('=').slice(1).join('')||'';
const fmtTime=s=>String(s||'').slice(0,19).replace('T',' ');
window.dl=url=>window.open(url,'_blank');

function msg(id,text,ok){const n=$(id);if(!n)return;n.textContent=text;n.className='msg '+(ok?'ok':'err');}
function setToken(t){S.token=t||'';sessionStorage.setItem('blr_t',S.token);$('authPill').textContent=S.token?'signed in':'signed out';$('authPill').className='pill '+(S.token?'ok':'');}

async function apiFetch(path,opts={}){
  opts.headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
  const c=csrf();if(c)opts.headers['X-CSRF-Token']=c;
  if(S.token)opts.headers.Authorization='Bearer '+S.token;
  opts.credentials='include';
  let r=await fetch(path,opts);
  if(r.status===401&&path!=='/Admin/refresh'){
    try{const d=await(await fetch('/Admin/refresh',{method:'POST',credentials:'include'})).json();setToken(d.accessToken);opts.headers.Authorization='Bearer '+S.token;r=await fetch(path,opts);}catch{}
  }
  const txt=await r.text();let json;try{json=JSON.parse(txt);}catch{json={raw:txt};}
  if(!r.ok)throw new Error(json?.errorMessage||json?.error||r.statusText);
  return(json&&typeof json==='object'&&'data' in json)?json.data:json;
}

/* -- nav -- */
const TITLES={dashboard:'Dashboard',players:'Players',leaderboards:'Leaderboards',catalog:'Catalog',stores:'Stores',titledata:'Title Data',loot:'Loot Tables',events:'Events / Sales',assets:'Asset Bundles',cloudscript:'CloudScript',bulk:'Bulk Actions',jobs:'Jobs',analytics:'Analytics',audit:'Audit Log',backups:'Backups',flags:'Feature Flags',admins:'Admins',exports:'Exports'};
const LOADERS={dashboard:()=>{loadOv();loadDashAudit();loadDashNotif();},players:loadPlayers,leaderboards:loadLbNames,catalog:loadCatalog,stores:loadStores,titledata:loadTitleData,loot:loadLoot,events:loadEvents,assets:loadAssets,cloudscript:()=>{loadCsHistory();loadCsStats();},jobs:loadJobs,analytics:loadAnalytics,audit:()=>{loadAudit();loadLogs();},backups:loadBackups,flags:loadFlags,admins:loadAdmins};
function goPage(n){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(x=>x.classList.toggle('active',x.dataset.p===n));
  const pg=$('page-'+n);if(pg)pg.classList.add('active');
  $('ptitle').textContent=TITLES[n]||n;
  LOADERS[n]?.();
}
document.querySelectorAll('.ni').forEach(n=>n.addEventListener('click',()=>goPage(n.dataset.p)));

/* -- WebSocket -- */
function connectWs(){
  if(S.ws)try{S.ws.close();}catch{}
  if(!S.token)return;
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/Admin/ws');
  S.ws=ws;
  ws.onopen=()=>{$('wsDot').classList.add('live');$('wsLbl').textContent='live';};
  ws.onclose=()=>{$('wsDot').classList.remove('live');$('wsLbl').textContent='offline';};
  ws.onmessage=ev=>{try{const m=JSON.parse(ev.data);if(m.type==='overview')renderMetrics(m.data);}catch{}};
}
function renderMetrics(d){
  $('mPlayers').textContent=d.totalPlayers??'-';$('mSessions').textContent=d.activeSessions??'-';$('mReqMin').textContent=d.requestsLastMinute??'-';$('mDb').textContent=(d.dbLatencyMs??'-')+' ms';$('mRedis').textContent=(d.redisLatencyMs??'-')+' ms';$('mBans').textContent=d.activeBans??'-';$('mWs').textContent=d.websocketClients??'-';$('mReq24').textContent=d.requestsLast24h??'-';
}
async function loadOv(){try{renderMetrics(await apiFetch('/Admin/api/overview'));}catch{}}
async function loadDashAudit(){try{const d=await apiFetch('/Admin/api/audit?limit=10');$('dashAudit').innerHTML=(d.rows||[]).map(r=>\`<tr><td class="clip">\${esc(fmtTime(r.ts))}</td><td class="clip">\${esc(r.admin_email)}</td><td>\${esc(r.action)}</td><td class="clip">\${esc(r.target_type)} \${esc(r.target_id)}</td></tr>\`).join('');}catch{}}
async function loadDashNotif(){try{const d=await apiFetch('/Admin/api/notifications?limit=8');$('dashNotif').innerHTML=(d.items||[]).map(r=>\`<tr><td><span class="badge b-blue">\${esc(r.type)}</span></td><td class="clip">\${esc(fmtTime(r.timestamp))}</td><td class="clip">\${esc(r.title)} \${esc(r.body)}</td></tr>\`).join('');}catch{}}
$('btnDashAuditRld').onclick=()=>{loadDashAudit();loadDashNotif();};

/* -- Players -- */
async function loadPlayers(pg=S.pPage){
  S.pPage=pg;
  try{
    const u=new URL('/Admin/api/players',location.origin);
    u.searchParams.set('page',pg);if(S.pQ)u.searchParams.set('search',S.pQ);
    const d=await apiFetch(u.pathname+u.search);
    $('pMeta').textContent=d.total+' players';
    $('pInfo').textContent='Page '+d.page+' / '+d.pages;
    $('pTable').innerHTML=(d.rows||[]).map(p=>\`<tr class="cur" onclick="openPlayer('\${esc(p.playfab_id)}')">
      <td style="font-size:10.5px;font-family:monospace">\${esc(p.playfab_id)}</td>
      <td>\${esc(p.display_name)}</td>
      <td class="clip" style="font-size:10px">\${esc(String(p.last_login||'').slice(0,10))}</td>
      <td>\${p.vc_ge}</td><td>\${p.vc_bb}</td>
      <td>\${p.banned?'<span class="badge b-bad">banned</span>':'<span class="badge b-ok">ok</span>'}</td>
      <td><button class="btn btn-s btn-xs">Open</button></td>
    </tr>\`).join('');
  }catch(e){$('pTable').innerHTML=\`<tr><td colspan="7" style="color:var(--bad-l)">\${esc(e.message)}</td></tr>\`;}
}
$('btnPS').onclick=()=>{S.pQ=$('pSearch').value.trim();S.pPage=1;loadPlayers();};
$('btnPC').onclick=()=>{$('pSearch').value='';S.pQ='';S.pPage=1;loadPlayers();};
$('pPrev').onclick=()=>loadPlayers(Math.max(1,S.pPage-1));
$('pNext').onclick=()=>loadPlayers(S.pPage+1);
$('pSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('btnPS').click();});

/* -- Player Drawer -- */
window.openPlayer=async(id)=>{S.pid=id;$('dTitle').textContent=id;$('drawer').classList.add('open');renderDrawer(id);};
$('btnDClose').onclick=()=>$('drawer').classList.remove('open');
$('btnDRefresh').onclick=()=>{if(S.pid)renderDrawer(S.pid);};
$('dtabs').addEventListener('click',e=>{
  const b=e.target.closest('.tb');if(!b)return;
  document.querySelectorAll('#dtabs .tb').forEach(x=>x.classList.toggle('active',x===b));
  document.querySelectorAll('#drawer .tp').forEach(x=>x.classList.toggle('active',x.id==='tab-'+b.dataset.t));
});
async function renderDrawer(id){
  try{
    const d=await apiFetch('/Admin/api/player/'+encodeURIComponent(id));
    const p=d.player||{};const inv=d.inventory||[];const stats=d.stats||[];const udata=d.data||[];const rdata=d.readonlyData||[];const sess=d.sessions||[];const bans=d.bans||[];const friends=d.friends||[];
    /* Overview */
    $('tab-dOv').innerHTML=\`
<div class="g2" style="margin-bottom:10px;gap:8px">
  <div class="metric"><div class="lbl">Display Name</div><div style="font-weight:600;margin-top:3px">\${esc(p.display_name)}</div></div>
  <div class="metric"><div class="lbl">Origination</div><div style="margin-top:3px">\${esc(p.origination)}</div></div>
  <div class="metric"><div class="lbl">Created</div><div style="font-size:10.5px;margin-top:3px">\${esc(fmtTime(p.created_at))}</div></div>
  <div class="metric"><div class="lbl">Last Login</div><div style="font-size:10.5px;margin-top:3px">\${esc(fmtTime(p.last_login))}</div></div>
</div>
<div class="row" style="margin-bottom:8px">
  <button class="btn btn-s btn-sm" id="dBtnImp">Impersonate</button>
  <button class="btn btn-s btn-sm" id="dBtnRevoke">Revoke Sessions</button>
  <button class="btn btn-ok btn-sm" id="dBtnClone">Clone Account</button>
  <button class="btn btn-d btn-sm" id="dBtnWipe">Wipe</button>
</div>
<div class="msg" id="ovMsg"></div>\`;
    $('dBtnImp').onclick=async()=>{try{const r=await apiFetch('/Admin/api/player/'+id+'/impersonate',{method:'POST',body:'{}'});prompt('SessionTicket:',r.sessionTicket||'');}catch(e){msg('ovMsg',e.message,false);}};
    $('dBtnRevoke').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/sessions/revoke',{method:'POST',body:'{}'});msg('ovMsg','Sessions revoked',true);}catch(e){msg('ovMsg',e.message,false);}};
    $('dBtnWipe').onclick=async()=>{if(!confirm('Wipe '+id+'? This cannot be undone.'))return;try{await apiFetch('/Admin/api/player/'+id+'/wipe',{method:'POST',body:'{}'});msg('ovMsg','Wiped',true);loadPlayers();}catch(e){msg('ovMsg',e.message,false);}};
    $('dBtnClone').onclick=async()=>{const dn=prompt('New display name:');if(dn===null)return;try{const r=await apiFetch('/Admin/api/player/'+id+'/clone',{method:'POST',body:JSON.stringify({displayName:dn||''})});msg('ovMsg','Cloned -> '+r.newPlayFabId,true);}catch(e){msg('ovMsg',e.message,false);}};
    /* Inventory */
    $('tab-dInv').innerHTML=\`
<div class="row" style="margin-bottom:7px;flex-wrap:wrap">
  <input id="aiId" placeholder="ItemId" style="flex:2;min-width:80px"/>
  <input id="aiCls" placeholder="Class" style="flex:1;min-width:60px"/>
  <input id="aiUses" type="number" placeholder="Uses" style="flex:1;min-width:60px"/>
  <button class="btn btn-ok btn-sm" id="dBtnAddItem">Grant</button>
</div>
<div class="msg" id="invMsg"></div>
<div class="tw h340"><table><thead><tr><th>InstanceId</th><th>ItemId</th><th>Class</th><th>Uses</th><th></th></tr></thead><tbody>
\${inv.map(it=>\`<tr><td class="clip" style="font-size:9.5px;font-family:monospace">\${esc(it.instance_id?.slice(0,12))}...</td><td>\${esc(it.item_id)}</td><td>\${esc(it.item_class||'')}</td><td>\${it.remaining_uses??'unlimited'}</td><td><button class="btn btn-d btn-xs" onclick="rmItem('\${esc(id)}','\${esc(it.instance_id)}')">X</button></td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnAddItem').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/inventory',{method:'POST',body:JSON.stringify({itemId:$('aiId').value.trim(),itemClass:$('aiCls').value.trim()||null,remainingUses:$('aiUses').value?Number($('aiUses').value):null})});msg('invMsg','Granted',true);renderDrawer(id);}catch(e){msg('invMsg',e.message,false);}};
    /* Currencies */
    $('tab-dCur').innerHTML=\`
<div class="metrics" style="margin-bottom:10px">
  <div class="metric"><div class="lbl">GE (Gold)</div><div class="val b">\${p.vc_ge??0}</div></div>
  <div class="metric"><div class="lbl">BB (BattlePass)</div><div class="val b">\${p.vc_bb??0}</div></div>
  <div class="metric"><div class="lbl">DT (Diamond)</div><div class="val b">\${p.vc_dt??0}</div></div>
  <div class="metric"><div class="lbl">BP (BattlePoint)</div><div class="val b">\${p.vc_bp??0}</div></div>
</div>
<div class="row" style="margin-bottom:7px;flex-wrap:wrap">
  <select id="curKind" style="flex:1;min-width:80px"><option>GE</option><option>BB</option><option>DT</option><option>BP</option></select>
  <input id="curAmt" type="number" placeholder="amount (neg=remove)" style="flex:2;min-width:100px"/>
  <input id="curRsn" placeholder="reason" style="flex:2;min-width:100px"/>
  <button class="btn btn-p btn-sm" id="dBtnCur">Apply</button>
</div>
<div class="msg" id="curMsg"></div>\`;
    $('dBtnCur').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/currency',{method:'POST',body:JSON.stringify({currency:$('curKind').value,amount:Number($('curAmt').value),reason:$('curRsn').value})});msg('curMsg','Updated',true);renderDrawer(id);}catch(e){msg('curMsg',e.message,false);}};
    /* Statistics */
    $('tab-dSt').innerHTML=\`
<div class="row" style="margin-bottom:7px;flex-wrap:wrap">
  <input id="stEN" placeholder="Statistic name" style="flex:2"/>
  <input id="stEV" type="number" placeholder="value" style="flex:1"/>
  <button class="btn btn-p btn-sm" id="dBtnStSet">Set</button>
</div>
<div class="msg" id="stEditMsg"></div>
<div class="tw h340"><table><thead><tr><th>Statistic</th><th>Value</th><th>Version</th></tr></thead><tbody>
\${stats.map(s=>\`<tr class="cur" onclick="$('stEN').value='\${esc(s.statistic_name)}';$('stEV').value='\${s.value}'"><td>\${esc(s.statistic_name)}</td><td>\${s.value}</td><td>\${s.version}</td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnStSet').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/stats',{method:'POST',body:JSON.stringify({statisticName:$('stEN').value.trim(),value:Number($('stEV').value)})});msg('stEditMsg','Updated',true);renderDrawer(id);}catch(e){msg('stEditMsg',e.message,false);}};
    /* User Data */
    $('tab-dUd').innerHTML=\`
<div class="row" style="margin-bottom:7px;flex-wrap:wrap">
  <input id="udK" placeholder="Key" style="flex:1;min-width:80px"/>
  <input id="udV" placeholder="Value (string or JSON)" style="flex:3;min-width:120px"/>
  <button class="btn btn-p btn-sm" id="dBtnUdSet">Set</button>
  <button class="btn btn-d btn-sm" id="dBtnUdDel">Del</button>
</div>
<div class="msg" id="udMsg"></div>
<div class="tw h340"><table><thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead><tbody>
\${udata.map(r=>\`<tr class="cur" onclick="$('udK').value=\\\`\${esc(r.key)}\\\`;$('udV').value=\\\`\${esc(String(r.value||'').slice(0,500))}\\\`"><td>\${esc(r.key)}</td><td class="clip">\${esc(String(r.value||'').slice(0,60))}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.last_updated))}</td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnUdSet').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/userdata',{method:'POST',body:JSON.stringify({key:$('udK').value.trim(),value:$('udV').value.trim()})});msg('udMsg','Saved',true);renderDrawer(id);}catch(e){msg('udMsg',e.message,false);}};
    $('dBtnUdDel').onclick=async()=>{const k=$('udK').value.trim();if(!k)return;if(!confirm('Delete key '+k+'?'))return;try{await apiFetch('/Admin/api/player/'+id+'/userdata/'+encodeURIComponent(k),{method:'DELETE'});msg('udMsg','Deleted',true);renderDrawer(id);}catch(e){msg('udMsg',e.message,false);}};
    /* Readonly */
    $('tab-dRd').innerHTML=\`
<div class="row" style="margin-bottom:7px;flex-wrap:wrap">
  <input id="rdK" placeholder="Key" style="flex:1;min-width:80px"/>
  <input id="rdV" placeholder="Value" style="flex:3;min-width:120px"/>
  <button class="btn btn-p btn-sm" id="dBtnRdSet">Set</button>
  <button class="btn btn-d btn-sm" id="dBtnRdDel">Del</button>
</div>
<div class="msg" id="rdMsg"></div>
<div class="tw h340"><table><thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead><tbody>
\${rdata.map(r=>\`<tr class="cur" onclick="$('rdK').value=\\\`\${esc(r.key)}\\\`;$('rdV').value=\\\`\${esc(String(r.value||'').slice(0,500))}\\\`"><td>\${esc(r.key)}</td><td class="clip">\${esc(String(r.value||'').slice(0,60))}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.last_updated))}</td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnRdSet').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/readonlydata',{method:'POST',body:JSON.stringify({key:$('rdK').value.trim(),value:$('rdV').value.trim()})});msg('rdMsg','Saved',true);renderDrawer(id);}catch(e){msg('rdMsg',e.message,false);}};
    $('dBtnRdDel').onclick=async()=>{const k=$('rdK').value.trim();if(!k)return;if(!confirm('Delete readonly key '+k+'?'))return;try{await apiFetch('/Admin/api/player/'+id+'/readonlydata/'+encodeURIComponent(k),{method:'DELETE'});msg('rdMsg','Deleted',true);renderDrawer(id);}catch(e){msg('rdMsg',e.message,false);}};
    /* Friends */
    $('tab-dFr').innerHTML=\`<div class="tw h400"><table><thead><tr><th>PlayFabId</th><th>Name</th><th>Status</th><th>Last Login</th></tr></thead><tbody>
\${friends.length?friends.map(f=>\`<tr><td style="font-size:10.5px;font-family:monospace">\${esc(f.friend_playfab_id)}</td><td>\${esc(f.display_name)}</td><td>\${esc(f.status)}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(f.last_login))}</td></tr>\`).join(''):'<tr><td colspan="4" style="color:var(--muted)">No friends</td></tr>'}
</tbody></table></div>\`;
    /* Sessions */
    $('tab-dSess').innerHTML=\`
<button class="btn btn-d btn-sm" id="dBtnKillAll" style="margin-bottom:8px">Kill All Sessions</button>
<div class="tw h400"><table><thead><tr><th>Ticket (short)</th><th>Created</th><th>Expires</th><th>Valid</th></tr></thead><tbody>
\${sess.map(s=>\`<tr><td style="font-size:9.5px;font-family:monospace">\${esc(String(s.session_ticket||'').slice(0,16))}...</td><td style="font-size:9.5px">\${esc(fmtTime(s.created_at))}</td><td style="font-size:9.5px">\${esc(fmtTime(s.expires_at))}</td><td>\${s.valid?'<span class="badge b-ok">active</span>':'<span class="badge b-muted">expired</span>'}</td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnKillAll').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/sessions/revoke',{method:'POST',body:'{}'});renderDrawer(id);}catch{}};
    /* Bans */
    $('tab-dBan').innerHTML=\`
<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:7px">
  <input id="banMin" type="number" placeholder="Minutes (blank = permanent)"/>
  <input id="banIp" placeholder="IP address (optional)"/>
  <input id="banDev" placeholder="Device ID (optional)"/>
  <input id="banRsn" placeholder="Reason (shown to player)"/>
</div>
<div class="row" style="margin-bottom:7px">
  <button class="btn btn-d btn-sm" id="dBtnBan">Ban</button>
  <button class="btn btn-ok btn-sm" id="dBtnUnban">Unban</button>
</div>
<div class="msg" id="banMsg"></div>
<div class="tw h280"><table><thead><tr><th>Created</th><th>Reason</th><th>Until</th><th>IP</th></tr></thead><tbody>
\${bans.map(b=>\`<tr><td style="font-size:9.5px">\${esc(fmtTime(b.created_at))}</td><td>\${esc(b.reason)}</td><td style="font-size:9.5px">\${esc(String(b.banned_until||'permanent').slice(0,10))}</td><td style="font-size:9.5px">\${esc(b.ip_address||'')}</td></tr>\`).join('')}
</tbody></table></div>\`;
    $('dBtnBan').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/ban',{method:'POST',body:JSON.stringify({reason:$('banRsn').value,durationMinutes:$('banMin').value?Number($('banMin').value):null,ipAddress:$('banIp').value||null,deviceId:$('banDev').value||null})});msg('banMsg','Banned',true);renderDrawer(id);loadPlayers();}catch(e){msg('banMsg',e.message,false);}};
    $('dBtnUnban').onclick=async()=>{try{await apiFetch('/Admin/api/player/'+id+'/unban',{method:'POST',body:'{}'});msg('banMsg','Unbanned',true);renderDrawer(id);loadPlayers();}catch(e){msg('banMsg',e.message,false);}};
    /* Actions Log */
    try{const al=await apiFetch('/Admin/api/player/'+id+'/audit?limit=50');
    $('tab-dAct').innerHTML=\`<div class="tw h400"><table><thead><tr><th>Time</th><th>Admin</th><th>Action</th><th>Target</th></tr></thead><tbody>
\${(al.rows||[]).map(r=>\`<tr><td style="font-size:9.5px">\${esc(fmtTime(r.ts))}</td><td>\${esc(r.admin_email)}</td><td>\${esc(r.action)}</td><td class="clip">\${esc(r.target_type)} \${esc(r.target_id)}</td></tr>\`).join('')}
</tbody></table></div>\`;}catch{$('tab-dAct').innerHTML='<div style="color:var(--muted);padding:8px">No actions yet</div>';}
  }catch(e){$('tab-dOv').innerHTML=\`<div style="color:var(--bad-l);padding:8px">\${esc(e.message)}</div>\`;}
}
window.rmItem=async(pid,iid)=>{if(!confirm('Remove item?'))return;try{await apiFetch('/Admin/api/player/'+pid+'/inventory',{method:'POST',body:JSON.stringify({action:'remove',instanceId:iid})});renderDrawer(pid);}catch(e){alert(e.message);}};

/* -- Leaderboards -- */
async function loadLbNames(){try{const d=await apiFetch('/Admin/api/leaderboards');$('lbSel').innerHTML=(d.names||[]).map(n=>\`<option>\${esc(n)}</option>\`).join('');}catch{}}
async function loadLb(){const nm=$('lbSel').value;if(!nm)return;try{const d=await apiFetch('/Admin/api/leaderboard/'+encodeURIComponent(nm)+'?limit='+S.lbLim+'&offset='+S.lbOff);$('lbTable').innerHTML=(d.rows||[]).map(r=>\`<tr><td>\${r.Position}</td><td style="font-size:10.5px;font-family:monospace">\${esc(r.PlayFabId)}</td><td>\${esc(r.DisplayName)}</td><td>\${r.Value}</td></tr>\`).join('');$('lbInfo').textContent='Offset '+S.lbOff;}catch(e){$('lbTable').innerHTML=\`<tr><td colspan="4" style="color:var(--bad-l)">\${esc(e.message)}</td></tr>\`;}}
$('btnLbLoad').onclick=()=>{S.lbOff=0;loadLb();};$('lbPrev').onclick=()=>{S.lbOff=Math.max(0,S.lbOff-S.lbLim);loadLb();};$('lbNext').onclick=()=>{S.lbOff+=S.lbLim;loadLb();};
$('btnStSet').onclick=async()=>{const pid=$('stPid').value.trim();const sn=$('stName').value.trim();if(!pid||!sn){msg('stMsg','PlayFabId and stat name required',false);return;}try{await apiFetch('/Admin/api/player/'+pid+'/stats',{method:'POST',body:JSON.stringify({statisticName:sn,value:Number($('stVal').value)})});msg('stMsg','Updated',true);loadLb();}catch(e){msg('stMsg',e.message,false);}};

/* -- Catalog -- */
async function loadCatalog(pg=S.catPage){
  S.catPage=pg;
  try{
    const u=new URL('/Admin/api/catalog',location.origin);
    u.searchParams.set('limit',50);u.searchParams.set('offset',(pg-1)*50);
    if(S.catQ)u.searchParams.set('search',S.catQ);if(S.catCls)u.searchParams.set('itemClass',S.catCls);
    const d=await apiFetch(u.pathname+u.search);
    $('catMeta').textContent=d.total+' items';
    $('catInfo').textContent='Page '+pg+' / '+Math.max(1,Math.ceil(d.total/50));
    const cls=await apiFetch('/Admin/api/catalog/classes').catch(()=>({classes:[]}));
    const cur=$('catClass').value;
    $('catClass').innerHTML='<option value="">All classes</option>'+(cls.classes||[]).map(c=>\`<option value="\${esc(c)}">\${esc(c)}</option>\`).join('');
    $('catClass').value=cur;
    $('catTable').innerHTML=(d.rows||[]).map(it=>{const vc=it.VirtualCurrencyPrices||{};const vk=Object.keys(vc)[0]||'';const va=Object.values(vc)[0]||'';return\`<tr class="cur" onclick="editCatItem('\${esc(it.ItemId)}')"><td style="font-size:10.5px">\${esc(it.ItemId)}</td><td><span class="badge b-purple">\${esc(it.ItemClass||'')}</span></td><td>\${esc(it.DisplayName||'')}</td><td>\${vk?vk+' '+va:''}</td><td>\${it.BundleContents?'<span class="badge b-muted">bundle</span>':''}</td><td><button class="btn btn-s btn-xs">Edit</button></td></tr>\`;}).join('');
  }catch(e){$('catTable').innerHTML=\`<tr><td colspan="6" style="color:var(--bad-l)">\${esc(e.message)}</td></tr>\`;}
}
$('btnCatSearch').onclick=()=>{S.catQ=$('catSearch').value.trim();S.catCls=$('catClass').value;S.catPage=1;loadCatalog();};
$('catSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('btnCatSearch').click();});
$('catClass').addEventListener('change',()=>{S.catCls=$('catClass').value;S.catPage=1;loadCatalog();});
$('catPrev').onclick=()=>loadCatalog(Math.max(1,S.catPage-1));$('catNext').onclick=()=>loadCatalog(S.catPage+1);
$('btnCatNew').onclick=()=>{clearCatForm();$('catEdit').style.display='block';$('catEditTitle').textContent='New Item';};
$('btnCatCancel').onclick=()=>$('catEdit').style.display='none';
function clearCatForm(){['cItemId','cItemClass','cDisplayName','cDesc','cVc','cImg','cTags'].forEach(i=>{if($(i))$(i).value='';});$('cCatVer').value='1';$('cAmt').value='';$('cUses').value=0;$('cUsagePeriod').value=0;$('cUsagePeriodGroup').value='';$('cBundle').value='[]';$('cCustom').value='{}';}
window.editCatItem=async id=>{try{const it=await apiFetch('/Admin/api/catalog/'+encodeURIComponent(id));$('cItemId').value=it.ItemId||'';$('cItemClass').value=it.ItemClass||'';$('cDisplayName').value=it.DisplayName||'';$('cCatVer').value=it.CatalogVersion||'1';$('cDesc').value=it.Description||'';const vc=it.VirtualCurrencyPrices||{};$('cVc').value=Object.keys(vc)[0]||'';$('cAmt').value=Object.values(vc)[0]||'';$('cUses').value=it.Consumable?.UsageCount||0;$('cUsagePeriod').value=it.Consumable?.UsagePeriod||0;$('cUsagePeriodGroup').value=it.Consumable?.UsagePeriodGroup||'';$('cTags').value=(it.Tags||[]).join(',');$('cImg').value=it.ItemImageUrl||'';$('cBundle').value=it.BundleContents?j(it.BundleContents):'[]';$('cCustom').value=it.CustomData?j(it.CustomData):'{}';$('catEdit').style.display='block';$('catEditTitle').textContent='Edit: '+id;}catch(e){alert(e.message);}};
$('btnCatSave').onclick=async()=>{const item={ItemId:$('cItemId').value.trim(),ItemClass:$('cItemClass').value.trim(),CatalogVersion:$('cCatVer').value||'1',DisplayName:$('cDisplayName').value.trim(),Description:$('cDesc').value.trim(),IsStackable:$('cStack').value==='true',IsTradable:$('cTrade').value==='true'};const vc=$('cVc').value.trim();const amt=Number($('cAmt').value);if(vc&&amt)item.VirtualCurrencyPrices={[vc]:amt};const uses=Number($('cUses').value);const usagePeriod=Number($('cUsagePeriod').value);const usagePeriodGroup=$('cUsagePeriodGroup').value.trim();if(uses>0||usagePeriod>0||usagePeriodGroup){item.Consumable={};if(uses>0)item.Consumable.UsageCount=uses;if(usagePeriod>0)item.Consumable.UsagePeriod=usagePeriod;if(usagePeriodGroup)item.Consumable.UsagePeriodGroup=usagePeriodGroup;}const tags=$('cTags').value.trim();if(tags)item.Tags=tags.split(',').map(t=>t.trim()).filter(Boolean);if($('cImg').value.trim())item.ItemImageUrl=$('cImg').value.trim();try{item.BundleContents=JSON.parse($('cBundle').value||'[]');}catch{}try{item.CustomData=JSON.parse($('cCustom').value||'{}');}catch{}try{await apiFetch('/Admin/api/catalog',{method:'POST',body:JSON.stringify(item)});msg('catEditMsg','Saved',true);loadCatalog();}catch(e){msg('catEditMsg',e.message,false);}};
$('btnCatDel').onclick=async()=>{const id=$('cItemId').value.trim();if(!id)return;if(!confirm('Delete '+id+'?'))return;try{await apiFetch('/Admin/api/catalog/'+encodeURIComponent(id),{method:'DELETE'});msg('catEditMsg','Deleted',true);$('catEdit').style.display='none';loadCatalog();}catch(e){msg('catEditMsg',e.message,false);}};

/* -- Stores -- */
async function loadStores(){try{const d=await apiFetch('/Admin/api/stores');$('storesTable').innerHTML=(d.stores||[]).map(s=>\`<tr class="cur" onclick="loadStore('\${esc(s.storeId||s.store_id)}')"><td style="font-size:10.5px">\${esc(s.storeId||s.store_id)}</td><td>\${esc(s.displayName||s.display_name)}</td><td>\${s.itemCount??s.item_count??0}</td><td><button class="btn btn-s btn-xs">Open</button></td></tr>\`).join('');}catch{}}
async function loadStore(sid){S.storeId=sid;$('storePanelTitle').textContent='Store: '+sid;$('btnStoreDel').style.display='';try{const d=await apiFetch('/Admin/api/stores/'+encodeURIComponent(sid));const items=d.items||[];$('storeItemsList').innerHTML=items.length?\`<div class="tw h220" style="margin-bottom:8px"><table><thead><tr><th>ItemId</th><th>Currency</th><th>Price</th><th>Sort</th><th></th></tr></thead><tbody>\${items.map(it=>{const vc=it.VirtualCurrencyPrices||{};const vk=Object.keys(vc)[0]||'';const va=Object.values(vc)[0]||'';return\`<tr><td>\${esc(it.ItemId)}</td><td>\${esc(vk)}</td><td>\${va}</td><td>\${it.SortOrder??0}</td><td><button class="btn btn-d btn-xs" onclick="rmSI('\${esc(sid)}','\${esc(it.ItemId)}')">X</button></td></tr>\`;}).join('')}</tbody></table></div>\`:'<div style="color:var(--muted);margin-bottom:8px;font-size:11.5px">No items yet</div>';}catch{}}
window.rmSI=async(sid,iid)=>{if(!confirm('Remove '+iid+'?'))return;try{await apiFetch('/Admin/api/stores/'+encodeURIComponent(sid)+'/items/'+encodeURIComponent(iid),{method:'DELETE'});loadStore(sid);}catch(e){alert(e.message);}};
$('btnStoreNew').onclick=async()=>{const sid=prompt('StoreId:');if(!sid)return;const dn=prompt('Display Name:',sid)||sid;try{await apiFetch('/Admin/api/stores',{method:'POST',body:JSON.stringify({storeId:sid,displayName:dn})});loadStores();}catch(e){alert(e.message);}};
$('btnStoreRld').onclick=loadStores;
$('btnStoreDel').onclick=async()=>{if(!S.storeId)return;if(!confirm('Delete store '+S.storeId+'?'))return;try{await apiFetch('/Admin/api/stores/'+encodeURIComponent(S.storeId),{method:'DELETE'});msg('storeMsg','Deleted',true);S.storeId=null;$('storePanelTitle').textContent='Select a store';$('storeItemsList').innerHTML='';$('btnStoreDel').style.display='none';loadStores();}catch(e){msg('storeMsg',e.message,false);}};
$('btnSiSave').onclick=async()=>{if(!S.storeId){msg('storeMsg','Select a store first',false);return;}const iid=$('siItemId').value.trim();if(!iid){msg('storeMsg','ItemId required',false);return;}const vc=$('siVc').value.trim();const amt=Number($('siAmt').value||0);const payload={itemId:iid,sortOrder:Number($('siSort').value||0)};if(vc&&amt)payload.virtualCurrencyPrices={[vc]:amt};try{await apiFetch('/Admin/api/stores/'+encodeURIComponent(S.storeId)+'/items',{method:'POST',body:JSON.stringify(payload)});msg('storeMsg','Saved',true);loadStore(S.storeId);}catch(e){msg('storeMsg',e.message,false);}};

/* -- Title Data -- */
async function loadTitleData(pg=S.tdPage){S.tdPage=pg;try{const d=await apiFetch('/Admin/api/title-data');S.tdAll=d.rows||[];renderTitleData();}catch{}}
function renderTitleData(){const rows=S.tdQ?S.tdAll.filter(r=>r.key.toLowerCase().includes(S.tdQ.toLowerCase())||String(r.value||'').toLowerCase().includes(S.tdQ.toLowerCase())):S.tdAll;const lim=60,pages=Math.max(1,Math.ceil(rows.length/lim)),pg=Math.min(S.tdPage,pages);$('tdMeta').textContent=rows.length+' / '+S.tdAll.length+' keys';$('tdInfo').textContent='Page '+pg+' / '+pages;const slice=rows.slice((pg-1)*lim,pg*lim);$('tdTable').innerHTML=slice.map(r=>\`<tr class="cur" onclick="$('tdKey').value=\\\`\${esc(r.key)}\\\`;$('tdVal').value=\\\`\${esc(String(r.value||''))}\\\`"><td>\${esc(r.key)}</td><td class="clip" style="font-size:10.5px;max-width:220px">\${esc(String(r.value||'').slice(0,80))}</td></tr>\`).join('');}
$('btnTdSearch').onclick=()=>{S.tdQ=$('tdSearch').value.trim();S.tdPage=1;renderTitleData();};$('tdSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('btnTdSearch').click();});$('tdSearch').addEventListener('input',()=>{S.tdQ=$('tdSearch').value.trim();S.tdPage=1;renderTitleData();});
$('tdPrev').onclick=()=>{S.tdPage=Math.max(1,S.tdPage-1);renderTitleData();};$('tdNext').onclick=()=>{S.tdPage++;renderTitleData();};
$('btnTdSave').onclick=async()=>{const k=$('tdKey').value.trim();if(!k){msg('tdMsg','Key required',false);return;}let v=$('tdVal').value.trim();try{v=JSON.parse(v);}catch{}try{await apiFetch('/Admin/api/title-data',{method:'POST',body:JSON.stringify({key:k,value:v})});msg('tdMsg','Saved '+k,true);loadTitleData();}catch(e){msg('tdMsg',e.message,false);}};
$('btnTdDel').onclick=async()=>{const k=$('tdKey').value.trim();if(!k)return;if(!confirm('Delete key '+k+'?'))return;try{await apiFetch('/Admin/api/title-data/'+encodeURIComponent(k),{method:'DELETE'});msg('tdMsg','Deleted '+k,true);loadTitleData();}catch(e){msg('tdMsg',e.message,false);}};

/* -- Loot Tables -- */
async function loadLoot(){try{const d=await apiFetch('/Admin/api/loot');$('lootTable').innerHTML=(d.tables||[]).map(t=>\`<tr class="cur" onclick="loadLootTable('\${esc(t.table_key)}')"><td style="font-size:10.5px">\${esc(t.table_key)}</td><td>\${esc(t.display_name)}</td><td>\${t.roll_count}</td><td>\${t.item_count}</td><td>\${t.active?'<span class="badge b-ok">yes</span>':'<span class="badge b-muted">no</span>'}</td><td><button class="btn btn-s btn-xs">Open</button></td></tr>\`).join('');}catch{}}
async function loadLootTable(key){S.lootKey=key;$('lootPanelTitle').textContent='Table: '+key;$('btnLootDel').style.display='';try{const d=await apiFetch('/Admin/api/loot/'+encodeURIComponent(key));const items=d.items||[];$('lootItemsList').innerHTML=items.length?\`<div class="tw h220" style="margin-bottom:8px"><table><thead><tr><th>ItemId</th><th>Weight</th><th>Chance</th><th>Qty</th><th></th></tr></thead><tbody>\${items.map(it=>\`<tr><td>\${esc(it.item_id)}</td><td>\${it.weight}</td><td style="color:var(--ok-l)">\${it.chance}</td><td>\${it.min_quantity}-\${it.max_quantity}</td><td><button class="btn btn-d btn-xs" onclick="rmLootItem('\${esc(key)}','\${esc(it.item_id)}')">X</button></td></tr>\`).join('')}</tbody></table></div>\`:'<div style="color:var(--muted);margin-bottom:8px;font-size:11.5px">No items yet</div>';}catch{}}
window.rmLootItem=async(tk,iid)=>{try{await apiFetch('/Admin/api/loot/'+encodeURIComponent(tk)+'/items/'+encodeURIComponent(iid),{method:'DELETE'});loadLootTable(tk);}catch(e){alert(e.message);}};
$('btnLootNew').onclick=async()=>{const k=prompt('Table Key (unique):');if(!k)return;const nm=prompt('Display Name:',k)||k;const rolls=Number(prompt('Rolls per open:','1')||1);try{await apiFetch('/Admin/api/loot',{method:'POST',body:JSON.stringify({tableKey:k,displayName:nm,rollCount:rolls,active:true})});loadLoot();}catch(e){alert(e.message);}};
$('btnLootRld').onclick=loadLoot;
$('btnLootDel').onclick=async()=>{if(!S.lootKey)return;if(!confirm('Delete table '+S.lootKey+'?'))return;try{await apiFetch('/Admin/api/loot/'+encodeURIComponent(S.lootKey),{method:'DELETE'});S.lootKey=null;$('lootPanelTitle').textContent='Select a table';$('lootItemsList').innerHTML='';$('btnLootDel').style.display='none';loadLoot();}catch(e){alert(e.message);}};
$('btnLiSave').onclick=async()=>{if(!S.lootKey){msg('lootMsg','Select a table first',false);return;}const iid=$('liItemId').value.trim();if(!iid){msg('lootMsg','ItemId required',false);return;}try{await apiFetch('/Admin/api/loot/'+encodeURIComponent(S.lootKey)+'/items',{method:'POST',body:JSON.stringify({itemId:iid,weight:Number($('liWeight').value||100),minQuantity:Number($('liMin').value||1),maxQuantity:Number($('liMax').value||1)})});msg('lootMsg','Saved',true);loadLootTable(S.lootKey);}catch(e){msg('lootMsg',e.message,false);}};

/* -- Events -- */
async function loadEvents(){try{const d=await apiFetch('/Admin/api/events');const now=new Date();$('evTable').innerHTML=(d.events||[]).map(ev=>{const s=new Date(ev.starts_at),e=new Date(ev.ends_at);const status=!ev.active?'<span class="badge b-muted">off</span>':now<s?'<span class="badge b-blue">scheduled</span>':now>e?'<span class="badge b-muted">ended</span>':'<span class="badge b-ok">live</span>';return\`<tr class="cur" onclick="editEvent('\${esc(ev.event_key)}')"><td style="font-size:10.5px">\${esc(ev.event_key)}</td><td>\${esc(ev.display_name)}</td><td><span class="badge b-purple">\${esc(ev.event_type)}</span></td><td style="font-size:9.5px">\${esc(fmtTime(ev.starts_at))}</td><td style="font-size:9.5px">\${esc(fmtTime(ev.ends_at))}</td><td>\${status}</td><td><button class="btn btn-s btn-xs">Edit</button></td></tr>\`;}).join('');}catch{}}
function clearEvForm(){['evKey','evName','evStart','evEnd'].forEach(i=>{if($(i))$(i).value='';});$('evPayload').value='{}';$('evType').value='sale';$('evActive').value='true';$('evFormTitle').textContent='New Event';}
window.editEvent=async key=>{try{const ev=await apiFetch('/Admin/api/events/'+encodeURIComponent(key));$('evKey').value=ev.event_key||'';$('evName').value=ev.display_name||'';$('evType').value=ev.event_type||'sale';$('evActive').value=String(ev.active!==false);$('evStart').value=ev.starts_at?ev.starts_at.slice(0,16):'';$('evEnd').value=ev.ends_at?ev.ends_at.slice(0,16):'';$('evPayload').value=j(ev.payload||{});$('evFormTitle').textContent='Edit: '+key;}catch(e){alert(e.message);}};
$('btnEvRld').onclick=loadEvents;
$('btnEvClear').onclick=clearEvForm;
$('btnEvSave').onclick=async()=>{const key=$('evKey').value.trim();if(!key){msg('evMsg','Event Key required',false);return;}let payload;try{payload=JSON.parse($('evPayload').value||'{}');}catch{msg('evMsg','Invalid Payload JSON',false);return;}try{await apiFetch('/Admin/api/events',{method:'POST',body:JSON.stringify({eventKey:key,displayName:$('evName').value.trim()||key,eventType:$('evType').value,startsAt:$('evStart').value?new Date($('evStart').value).toISOString():null,endsAt:$('evEnd').value?new Date($('evEnd').value).toISOString():null,payload,active:$('evActive').value==='true'})});msg('evMsg','Saved',true);loadEvents();}catch(e){msg('evMsg',e.message,false);}};
$('btnEvDel').onclick=async()=>{const key=$('evKey').value.trim();if(!key)return;if(!confirm('Delete event '+key+'?'))return;try{await apiFetch('/Admin/api/events/'+encodeURIComponent(key),{method:'DELETE'});msg('evMsg','Deleted',true);clearEvForm();loadEvents();}catch(e){msg('evMsg',e.message,false);}};

/* -- Assets -- */
async function loadAssets(){try{const d=await apiFetch('/Admin/api/assets');$('assetsTable').innerHTML=(d.rows||[]).map(a=>\`<tr class="cur" onclick="fillAsset(\${JSON.stringify(a).replace(/"/g,'&quot;')})"><td style="font-size:10.5px">\${esc(a.bundleKey)}</td><td>\${esc(a.platform)}</td><td>\${esc(a.version||'')}</td><td>\${esc(a.itemId||'')}</td><td>\${a.active?'<span class="badge b-ok">yes</span>':'<span class="badge b-muted">no</span>'}</td><td><button class="btn btn-s btn-xs">Edit</button></td></tr>\`).join('');}catch{}}
window.fillAsset=a=>{$('aBk').value=a.bundleKey||'';$('aPlatform').value=a.platform||'';$('aVer').value=a.version||'';$('aItemId').value=a.itemId||'';$('aUrl').value=a.url||'';$('aChk').value=a.checksum||'';$('aNotes').value=a.notes||'';$('aActive').value=String(a.active!==false);};
$('btnAssetsRld').onclick=loadAssets;
$('btnAssetSave').onclick=async()=>{const bk=$('aBk').value.trim();if(!bk||!$('aUrl').value.trim()){msg('assetMsg','Bundle Key and URL required',false);return;}try{await apiFetch('/Admin/api/assets',{method:'POST',body:JSON.stringify({bundleKey:bk,platform:$('aPlatform').value.trim()||'all',version:$('aVer').value.trim()||null,itemId:$('aItemId').value.trim()||null,url:$('aUrl').value.trim(),checksum:$('aChk').value.trim()||null,notes:$('aNotes').value.trim()||null,active:$('aActive').value==='true'})});msg('assetMsg','Saved',true);loadAssets();}catch(e){msg('assetMsg',e.message,false);}};
$('btnAssetDel').onclick=async()=>{const bk=$('aBk').value.trim();if(!bk)return;if(!confirm('Delete '+bk+'?'))return;try{await apiFetch('/Admin/api/assets/'+encodeURIComponent(bk),{method:'DELETE'});msg('assetMsg','Deleted',true);loadAssets();}catch(e){msg('assetMsg',e.message,false);}};

/* -- CloudScript -- */
$('btnCsRun').onclick=async()=>{let params;try{params=JSON.parse($('csParams').value||'{}');}catch{msg('csMsg','Invalid JSON',false);return;}msg('csMsg','Running...',false);try{const d=await apiFetch('/Admin/api/cloudscript/test',{method:'POST',body:JSON.stringify({FunctionName:$('csFn').value,FunctionParameter:params,PlayFabId:$('csPid').value.trim()||undefined})});$('csResult').textContent=j(d);msg('csMsg','Done',true);loadCsHistory();}catch(e){$('csResult').textContent=e.message;msg('csMsg',e.message,false);}};
async function loadCsHistory(){try{const fn=$('csHFn').value.trim();const d=await apiFetch('/Admin/api/cloudscript/history?limit=100'+(fn?'&function='+encodeURIComponent(fn):''));$('csHTable').innerHTML=(d.rows||[]).map(r=>\`<tr><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.ts))}</td><td>\${esc(r.function_name)}</td><td class="clip" style="font-size:9.5px">\${esc(r.player_id||'')}</td><td>\${r.duration_ms||0}</td><td>\${r.success?'<span class="badge b-ok"></span>':'<span class="badge b-bad"></span>'}</td></tr>\`).join('');}catch{}}
async function loadCsStats(){try{const d=await apiFetch('/Admin/api/cloudscript/stats');$('csStats').innerHTML=(d.rows||[]).map(r=>\`<tr><td>\${esc(r.functionName)}</td><td>\${r.totalCalls}</td><td>\${r.successRate}%</td><td>\${Math.round(r.avgDurationMs||0)}</td></tr>\`).join('');}catch{}}
$('btnCsHLoad').onclick=()=>{loadCsHistory();loadCsStats();};

/* -- Bulk -- */
$('btnBlkCur').onclick=async()=>{const ids=$('blkIds').value.split(/\n/).map(x=>x.trim()).filter(Boolean);if(!ids.length){msg('blkCurMsg','No IDs',false);return;}try{const d=await apiFetch('/Admin/api/bulk/currency',{method:'POST',body:JSON.stringify({playFabIds:ids,currency:$('blkCur').value,amount:Number($('blkAmt').value||0),reason:$('blkReason').value||''})});msg('blkCurMsg','Job queued: '+d.jobId,true);}catch(e){msg('blkCurMsg',e.message,false);}};
$('btnBlkItem').onclick=async()=>{const ids=$('blkIIds').value.split(/\n/).map(x=>x.trim()).filter(Boolean);const iid=$('blkIItemId').value.trim();if(!ids.length||!iid){msg('blkItemMsg','IDs and ItemId required',false);return;}try{const d=await apiFetch('/Admin/api/bulk/inventory',{method:'POST',body:JSON.stringify({playFabIds:ids,itemId:iid,itemClass:$('blkIClass').value.trim()||null})});msg('blkItemMsg','Job queued: '+d.jobId,true);}catch(e){msg('blkItemMsg',e.message,false);}};

/* -- Jobs -- */
const JOB_COLORS={done:'b-ok',failed:'b-bad',running:'b-warn',queued:'b-blue'};
async function loadJobs(){try{const st=$('jobStatus').value;const d=await apiFetch('/Admin/api/jobs?limit=100'+(st?'&status='+st:''));$('jobsTable').innerHTML=(d.rows||[]).map(r=>{const dur=r.started_at&&r.finished_at?((new Date(r.finished_at)-new Date(r.started_at))/1000).toFixed(1)+'s':'-';const res=r.result?''+r.result.processed+(r.result.failed?' '+r.result.failed:''):'';return\`<tr><td><span class="badge b-purple">\${esc(r.job_type)}</span></td><td><span class="badge \${JOB_COLORS[r.status]||'b-muted'}">\${esc(r.status)}</span></td><td class="clip" style="font-size:10px">\${esc(r.queued_by||'')}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.created_at))}</td><td>\${dur}</td><td>\${res||esc(r.error||'')}</td></tr>\`;}).join('');}catch{}}
$('btnJobsRld').onclick=loadJobs;$('jobStatus').addEventListener('change',loadJobs);

/* -- Audit / Logs -- */
async function loadAudit(){try{const d=await apiFetch('/Admin/api/audit?limit=200');$('auditTable').innerHTML=(d.rows||[]).map(r=>\`<tr><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.ts))}</td><td class="clip">\${esc(r.admin_email)}</td><td><span class="badge b-blue">\${esc(r.action)}</span></td><td class="clip">\${esc(r.target_type)}</td><td class="clip">\${esc(r.target_id)}</td><td class="clip" style="font-size:9.5px">\${esc(r.ip_address||'')}</td></tr>\`).join('');}catch{}}
async function loadLogs(){try{const d=await apiFetch('/Admin/api/logs?limit=100');$('logsTable').innerHTML=(d.logs||[]).map(r=>\`<tr><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.ts))}</td><td>\${esc(r.method)}</td><td class="clip">\${esc(r.path)}</td><td>\${r.status_code}</td><td>\${r.duration_ms}</td><td class="clip" style="font-size:9.5px">\${esc(r.playfab_id||'')}</td></tr>\`).join('');}catch{}}
$('btnAuditRld').onclick=loadAudit;$('btnLogsRld').onclick=loadLogs;

/* -- Backups -- */
async function loadBackups(){try{const d=await apiFetch('/Admin/api/backups');$('bkList').innerHTML=(d.snapshots||[]).map(n=>\`<option>\${esc(n)}</option>\`).join('');}catch{}}
$('btnBkCreate').onclick=async()=>{try{const d=await apiFetch('/Admin/api/backup',{method:'POST',body:JSON.stringify({label:$('bkLabel').value||'manual'})});msg('bkMsg','Created: '+d.name,true);loadBackups();}catch(e){msg('bkMsg',e.message,false);}};
$('btnBkRld').onclick=loadBackups;
$('btnBkRestore').onclick=async()=>{const n=$('bkList').value;if(!n||!confirm('Restore '+n+'? All current data will be replaced.'))return;try{const d=await apiFetch('/Admin/api/restore',{method:'POST',body:JSON.stringify({name:n})});msg('restoreMsg','Restored: '+d.restored,true);}catch(e){msg('restoreMsg',e.message,false);}};
$('btnRestart').onclick=async()=>{if(!confirm('Restart the application?'))return;try{await apiFetch('/Admin/api/restart',{method:'POST',body:'{}'});msg('restoreMsg','Restart signal sent',true);}catch(e){msg('restoreMsg',e.message,false);}};

/* -- Flags -- */
async function loadFlags(){try{const d=await apiFetch('/Admin/api/flags');$('flagsTable').innerHTML=(d.flags||[]).map(f=>\`<tr class="cur" onclick="$('flKey').value='\${esc(f.key)}';$('flVal').value='\${esc(f.value)}';$('flDesc').value='\${esc(f.description||'')}'" ><td>\${esc(f.key)}</td><td>\${esc(f.value)}</td><td class="clip" style="font-size:9.5px">\${esc(f.updated_by||'')}</td></tr>\`).join('');}catch{}}
$('btnFlagsRld').onclick=loadFlags;
$('btnFlSave').onclick=async()=>{const k=$('flKey').value.trim();if(!k){msg('flMsg','Key required',false);return;}try{await apiFetch('/Admin/api/flags',{method:'POST',body:JSON.stringify({key:k,value:$('flVal').value.trim(),description:$('flDesc').value.trim()||null})});msg('flMsg','Saved',true);loadFlags();}catch(e){msg('flMsg',e.message,false);}};

/* -- Admins -- */
async function loadAdmins(){try{const d=await apiFetch('/Admin/api/admins');$('adminsTable').innerHTML=(d.admins||[]).map(a=>\`<tr class="cur" onclick="$('adEmail').value='\${esc(a.email)}';$('adRole').value='\${esc(a.role)}';$('adEnabled').value=String(\${a.enabled})"><td>\${esc(a.email)}</td><td><span class="badge b-purple">\${esc(a.role)}</span></td><td>\${a.enabled?'<span class="badge b-ok">yes</span>':'<span class="badge b-bad">no</span>'}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(a.last_login))}</td><td>\${a.failed_attempts||0}</td><td><button class="btn btn-s btn-xs">Edit</button></td></tr>\`).join('');}catch{}}
$('btnAdminsRld').onclick=loadAdmins;
$('btnAdSave').onclick=async()=>{const p={email:$('adEmail').value.trim(),role:$('adRole').value,enabled:$('adEnabled').value==='true'};if($('adPass').value){const pwErr=validatePassword($('adPass').value);if(pwErr){msg('adMsg',pwErr,false);return;}p.password=$('adPass').value;}if($('adTotp').value)p.totpSecret=$('adTotp').value.trim();try{const d=await apiFetch('/Admin/api/admins',{method:'POST',body:JSON.stringify(p)});msg('adMsg','Saved'+(d.otpAuthUri?'. OTP URI: '+d.otpAuthUri:''),true);loadAdmins();}catch(e){msg('adMsg',e.message,false);}};
$('btnAdClear').onclick=()=>{['adEmail','adPass','adTotp'].forEach(i=>$(i).value='');$('adRole').value='admin';$('adEnabled').value='true';};

/* -- Exports -- */
$('btnImpCat').onclick=async()=>{let items;try{items=JSON.parse($('impCatJson').value);}catch{msg('impCatMsg','Invalid JSON',false);return;}try{const d=await apiFetch('/Admin/api/import/catalog',{method:'POST',body:JSON.stringify({items})});msg('impCatMsg','Imported '+d.imported+' items',true);}catch(e){msg('impCatMsg',e.message,false);}};
$('btnImpTd').onclick=async()=>{let items;try{items=JSON.parse($('impTdJson').value);}catch{msg('impTdMsg','Invalid JSON',false);return;}try{const d=await apiFetch('/Admin/api/import/titledata',{method:'POST',body:JSON.stringify({items})});msg('impTdMsg','Imported '+d.imported+' keys',true);}catch(e){msg('impTdMsg',e.message,false);}};

/* -- Analytics -- */
function barChart(containerId, rows, dayKey, valKey, color='#7c3aed'){
  const el=$(containerId);if(!el)return;
  if(!rows.length){el.innerHTML='<div style="color:var(--muted);font-size:11px;padding:20px">No data</div>';return;}
  const max=Math.max(...rows.map(r=>r[valKey]||0))||1;
  el.innerHTML=rows.map(r=>{
    const h=Math.max(4,Math.round(((r[valKey]||0)/max)*120));
    const day=String(r[dayKey]||'').slice(5,10);
    return \`<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0">
      <div style="font-size:9px;color:var(--muted)">\${r[valKey]||0}</div>
      <div style="height:\${h}px;width:100%;max-width:28px;background:\${color};border-radius:3px 3px 0 0;opacity:.85;transition:opacity .1s" title="\${day}: \${r[valKey]||0}"></div>
      <div style="font-size:8.5px;color:var(--muted);writing-mode:vertical-rl;transform:rotate(180deg);max-height:28px">\${day}</div>
    </div>\`;
  }).join('');
}
async function loadAnalytics(){
  try{
    const ov=await apiFetch('/Admin/api/analytics/overview');
    $('anTotal').textContent=ov.total_players??'-';$('anToday').textContent=ov.newToday??'-';$('anW').textContent=ov.activeWeek??'-';$('anM').textContent=ov.activeMonth??'-';$('anBans').textContent=ov.activeBans??'-';$('anCs').textContent=ov.csCallsToday??'-';$('anGe').textContent=(ov.total_ge||0).toLocaleString();$('anBb').textContent=(ov.total_bb||0).toLocaleString();
  }catch{}
  await Promise.all([loadAnReg(),loadAnDau(),loadAnCS(),loadAnCur()]);
}
async function loadAnReg(){try{const days=$('anRegDays').value;const d=await apiFetch('/Admin/api/analytics/registrations?days='+days);barChart('anRegChart',d.rows||[],'day','registrations','#6d28d9');}catch{}}
async function loadAnDau(){try{const days=$('anDauDays').value;const d=await apiFetch('/Admin/api/analytics/dau?days='+days);barChart('anDauChart',d.rows||[],'day','active_players','#059669');}catch{}}
async function loadAnCS(){try{const d=await apiFetch('/Admin/api/analytics/cloudscript');$('anCsFns').innerHTML=(d.topFunctions||[]).map(r=>\`<tr><td>\${esc(r.function_name)}</td><td>\${r.total_calls}</td><td>\${r.success_rate}%</td><td>\${r.avg_ms||0}</td></tr>\`).join('');const sess=await apiFetch('/Admin/api/analytics/sessions');$('anActions').innerHTML=(sess.auditBreakdown||[]).map(r=>\`<tr><td><span class="badge b-blue">\${esc(r.action)}</span></td><td>\${r.count}</td><td>\${r.unique_admins}</td><td class="clip" style="font-size:9.5px">\${esc(fmtTime(r.last_seen))}</td></tr>\`).join('');}catch{}}
async function loadAnCur(){try{const d=await apiFetch('/Admin/api/analytics/currency');$('anEarners').innerHTML=(d.topEarners||[]).map((r,i)=>\`<tr><td>\${i+1}</td><td style="font-size:10px;font-family:monospace">\${esc(r.playfab_id)}</td><td>\${esc(r.display_name||'')}</td><td>\${(r.balance||0).toLocaleString()}</td></tr>\`).join('');}catch{}}
$('anRegDays').addEventListener('change',loadAnReg);
$('anDauDays').addEventListener('change',loadAnDau);

/* -- Password validation (client-side) -- */
function validatePassword(pw){
  if(pw.length<12) return 'Password must be at least 12 characters';
  if(!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  if(!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if(!/[0-9]/.test(pw)) return 'Password must contain a number';
  if(!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a special character';
  return null;
}

/* -- Login / Auth -- */
$('btnLogin').onclick=async()=>{msg('loginMsg','Signing in...',false);try{const r=await fetch('/Admin/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({email:$('lEmail').value,password:$('lPass').value,totp:$('lTotp').value})});const jj=await r.json().catch(()=>({}));if(!r.ok)throw new Error(jj.errorMessage||'Login failed');setToken(jj.accessToken);const adm=jj.admin||{};$('avLtr').textContent=(adm.email||'A')[0].toUpperCase();$('avEmail').textContent=adm.email||'admin';$('avRole').textContent=adm.role||'';msg('loginMsg','',true);$('login').style.display='none';connectWs();loadOv();loadDashAudit();loadDashNotif();}catch(e){msg('loginMsg',e.message,false);}};
$('lEmail').addEventListener('keydown',e=>{if(e.key==='Enter')$('lPass').focus();});$('lPass').addEventListener('keydown',e=>{if(e.key==='Enter')$('lTotp').focus();});$('lTotp').addEventListener('keydown',e=>{if(e.key==='Enter')$('btnLogin').click();});
$('btnLogout').onclick=async()=>{try{await fetch('/Admin/logout',{method:'POST',credentials:'include',headers:{'X-CSRF-Token':csrf()}});}catch{}if(S.ws)try{S.ws.close();}catch{}setToken('');$('login').style.display='flex';$('avEmail').textContent='not signed in';$('avRole').textContent='-';};
$('btnRefresh').onclick=()=>apiFetch('/Admin/refresh',{method:'POST'}).then(d=>setToken(d.accessToken)).catch(e=>alert(e.message));

/* -- Init -- */
if(S.token){$('login').style.display='none';setToken(S.token);connectWs();loadOv();loadDashAudit();loadDashNotif();}
})();
</script>
</body>
</html>`;
}
module.exports = { renderAdminUi };
