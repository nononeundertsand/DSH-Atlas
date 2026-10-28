/** Atlas 的样式。作用域统一在 .atlas-app 内，避免污染 DSH 其他界面。 */
export const ATLAS_CSS = String.raw`
.atlas-app{
  --atlas-bg:#0b0f14; --atlas-bg2:#0f141b; --atlas-panel:#111923;
  --atlas-line:#223042; --atlas-ink:#e6edf3; --atlas-muted:#8b98a9;
  --atlas-accent:#6ea8fe; --atlas-green:#7ee787; --atlas-amber:#f2cc60;
  --paper:#fbf9f4; --paper2:#f3efe6; --paper-ink:#1d232b; --paper-muted:#6b7280; --paper-line:#e3ddd0;
  position:relative; height:100%; min-height:0; overflow:hidden;
  background:
    radial-gradient(900px 600px at 18% 12%, rgba(110,168,254,.07), transparent 60%),
    radial-gradient(900px 700px at 82% 82%, rgba(126,231,135,.045), transparent 60%),
    var(--atlas-bg);
  color:var(--atlas-ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.atlas-app *{box-sizing:border-box}
.atlas-app button{font-family:inherit}
.atlas-app ::selection{background:rgba(110,168,254,.28)}

/* ── canvas ─────────────────────────────────────────────────────────────── */
.atlas-canvas{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none}
.atlas-canvas.panning{cursor:grabbing}
.atlas-grid{position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(circle, rgba(255,255,255,.075) 1px, transparent 1px);
  background-size:26px 26px}
.atlas-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.atlas-edge{fill:none;stroke:#2a3748;stroke-width:1.4}
.atlas-edge.is-active{stroke:#3f6a9e}

.atlas-node{
  position:absolute;width:280px;height:92px;padding:13px 16px;
  border-radius:14px;border:1px solid #243041;
  background:linear-gradient(180deg,#151d27,#101720);
  box-shadow:0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.035);
  cursor:pointer;user-select:none;
  transition:border-color .18s, box-shadow .18s, transform .18s, width .18s, height .18s;
}
.atlas-node:hover{border-color:#3a4b63;box-shadow:0 16px 38px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05)}
.atlas-node.is-active{border-color:#2e5f9e;box-shadow:0 0 0 1px rgba(110,168,254,.18),0 10px 30px rgba(0,0,0,.35)}
.atlas-node.is-closed{border-color:#2c5c3b;background:linear-gradient(180deg,#14231a,#101a15)}
.atlas-node.is-paused{border-color:#5c4a22}
.atlas-node.is-archived{opacity:.48}
.atlas-node-title{font-size:14px;font-weight:600;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:28px}
.atlas-node-sub{margin-top:6px;font-size:12px;line-height:1.45;color:var(--atlas-muted);height:34px;overflow:hidden}
.atlas-node-meta{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px;color:#71809a}
.atlas-status-dot{width:7px;height:7px;border-radius:50%;background:#5b6878;flex:none}
.is-active .atlas-status-dot{background:var(--atlas-accent);box-shadow:0 0 0 3px rgba(110,168,254,.14)}
.is-closed .atlas-status-dot{background:var(--atlas-green);box-shadow:0 0 0 3px rgba(126,231,135,.12)}
.is-paused .atlas-status-dot{background:var(--atlas-amber)}
.atlas-mastery{display:flex;gap:3px;margin-left:auto}
.atlas-mastery i{width:5px;height:5px;border-radius:2px;background:#2b3a4d}
.atlas-mastery i.on{background:var(--atlas-green)}
.atlas-node-add{
  position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:6px;
  border:1px solid #2b3b50;background:#121b26;color:#9fb1c8;cursor:pointer;
  display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1;
  opacity:0;transition:opacity .15s,background .15s
}
.atlas-node:hover .atlas-node-add{opacity:1}
.atlas-node-add:hover{background:#1b2a3c;color:#fff}

.atlas-canvas.lod-mid .atlas-node-sub{display:none}
.atlas-canvas.lod-mid .atlas-node-meta{display:none}
.atlas-canvas.lod-far .atlas-node{width:190px;height:52px;padding:10px 13px}
.atlas-canvas.lod-far .atlas-node-sub,.atlas-canvas.lod-far .atlas-node-meta{display:none}
.atlas-canvas.lod-far .atlas-node-title{font-size:13px}
.atlas-canvas.lod-map .atlas-node{width:120px;height:32px;padding:0 12px;display:flex;align-items:center;gap:7px;border-radius:10px}
.atlas-canvas.lod-map .atlas-node-title{font-size:0}
.atlas-canvas.lod-map .atlas-node-title::after{content:"";display:block;width:72px;height:5px;border-radius:3px;background:#3b4d66}
.atlas-canvas.lod-map .atlas-node-sub,.atlas-canvas.lod-map .atlas-node-meta{display:none}

/* ── topbar ─────────────────────────────────────────────────────────────── */
.atlas-topbar{position:absolute;left:16px;right:16px;top:14px;z-index:20;display:flex;align-items:center;gap:8px;pointer-events:none}
.atlas-topbar > *{pointer-events:auto}
.atlas-brand{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;background:rgba(15,21,28,.78);border:1px solid #223042;backdrop-filter:blur(10px)}
.atlas-brand-mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#6ea8fe,#7ee787);display:grid;place-items:center;color:#0b0f14;font-weight:800;font-size:11px}
.atlas-brand-name{font-size:13px;font-weight:650;letter-spacing:.2px}
.atlas-brand-sub{font-size:10px;color:var(--atlas-muted)}
.atlas-spacer{flex:1}
.atlas-btn{height:32px;padding:0 11px;border-radius:9px;border:1px solid #223042;background:rgba(15,21,28,.78);color:#c6d3e2;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;backdrop-filter:blur(10px);transition:background .15s,border-color .15s}
.atlas-btn:hover{background:#17212d;border-color:#33465d;color:#fff}
.atlas-btn.primary{background:#e8eef7;color:#101720;border-color:#e8eef7;font-weight:600}
.atlas-btn.primary:hover{background:#fff}
.atlas-btn.ghost{background:transparent}
.atlas-btn.danger{color:#ffb4b4;border-color:#57303a}
.atlas-btn.danger:hover{background:#2a161b;color:#ffd1d1}
.atlas-btn:disabled{opacity:.5;cursor:default}
.atlas-select{height:32px;max-width:180px;border-radius:9px;border:1px solid #223042;background:#0f151c;color:#c6d3e2;font-size:12px;padding:0 8px;cursor:pointer}
.atlas-search-wrap{position:relative}
.atlas-search{height:32px;width:190px;border-radius:9px;border:1px solid #223042;background:rgba(15,21,28,.78);color:var(--atlas-ink);font-size:12px;padding:0 10px;outline:none;backdrop-filter:blur(10px)}
.atlas-search:focus{border-color:#3f6a9e;width:240px}
.atlas-search-pop{position:absolute;top:38px;right:0;width:340px;max-height:320px;overflow:auto;border-radius:12px;background:#111923;border:1px solid #223042;box-shadow:0 20px 50px rgba(0,0,0,.5);padding:6px}
.atlas-search-hit{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--atlas-ink);padding:8px 10px;border-radius:8px;cursor:pointer}
.atlas-search-hit:hover{background:#182333}
.atlas-search-hit b{display:block;font-size:12px;font-weight:600}
.atlas-search-hit span{display:block;font-size:11px;color:var(--atlas-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atlas-search-empty{padding:14px;font-size:12px;color:var(--atlas-muted);text-align:center}

/* ── empty state ────────────────────────────────────────────────────────── */
.atlas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.atlas-empty-card{pointer-events:auto;width:min(440px,calc(100% - 40px));padding:28px;border-radius:20px;border:1px solid #223042;background:rgba(15,21,28,.86);backdrop-filter:blur(14px);box-shadow:0 30px 80px rgba(0,0,0,.45)}
.atlas-empty h2{margin:0 0 8px;font-size:20px;letter-spacing:.2px}
.atlas-empty p{margin:0 0 18px;color:var(--atlas-muted);font-size:13px;line-height:1.6}
.atlas-empty-form{display:flex;gap:8px}
.atlas-input{height:38px;flex:1;border-radius:10px;border:1px solid #2a3a4d;background:#0b1118;color:var(--atlas-ink);font-size:13px;padding:0 12px;outline:none}
.atlas-input:focus{border-color:#3f6a9e}

/* ── dialog ─────────────────────────────────────────────────────────────── */
.atlas-dialog-backdrop{position:absolute;inset:0;z-index:80;background:rgba(4,7,10,.55);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.atlas-dialog{width:min(360px,calc(100% - 40px));border-radius:16px;border:1px solid #223042;background:#111923;padding:20px;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.atlas-dialog h3{margin:0 0 14px;font-size:15px}
.atlas-dialog .atlas-input{width:100%}
.atlas-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}

/* ── chat sheet ─────────────────────────────────────────────────────────── */
.atlas-sheet-backdrop{position:absolute;inset:0;z-index:50;background:rgba(4,7,10,.52);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:22px;animation:atlas-fade .18s ease}
.atlas-sheet{width:min(1040px,100%);height:100%;max-height:100%;border-radius:18px;background:var(--paper);color:var(--paper-ink);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.6);animation:atlas-sheet-in .22s cubic-bezier(.2,.8,.2,1)}
@keyframes atlas-fade{from{opacity:0}to{opacity:1}}
@keyframes atlas-sheet-in{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
.atlas-sheet-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--paper-line);background:linear-gradient(180deg,#fffdf8,#fbf9f4)}
.atlas-sheet-head-main{min-width:0;flex:1}
.atlas-breadcrumb{font-size:11px;color:var(--paper-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.atlas-title-input{width:100%;border:0;background:transparent;font-size:18px;font-weight:650;color:var(--paper-ink);padding:0;outline:none;font-family:inherit}
.atlas-head-meta{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:11px;color:var(--paper-muted)}
.atlas-head-actions{display:flex;align-items:center;gap:6px;flex:none}
.atlas-paper-btn{height:32px;padding:0 11px;border-radius:9px;border:1px solid var(--paper-line);background:#fffdf8;color:var(--paper-ink);font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.atlas-paper-btn:hover{background:#f3efe6}
.atlas-paper-btn.primary{background:#1d232b;color:#fbf9f4;border-color:#1d232b}
.atlas-paper-btn.primary:hover{background:#2b3440}
.atlas-paper-btn.danger{color:#a33a3a;border-color:#e3c7c7}
.atlas-paper-btn:disabled{opacity:.5;cursor:default}

.atlas-sheet-body{display:grid;grid-template-columns:190px 1fr;flex:1;min-height:0}
.atlas-outline{border-right:1px solid var(--paper-line);padding:14px 10px;overflow:auto;background:#f7f3eb}
.atlas-outline-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--paper-muted);padding:0 8px 8px}
.atlas-outline-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:#4b5563;font-size:12px;line-height:1.4;padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atlas-outline-item:hover{background:#efe9dd;color:#111827}
.atlas-outline-item.lvl3{padding-left:18px;font-size:11px}
.atlas-outline-empty{padding:8px;font-size:11px;color:var(--paper-muted);line-height:1.5}

.atlas-thread{overflow:auto;padding:22px 30px 8px;min-height:0}
.atlas-thread-inner{max-width:720px;margin:0 auto}
.atlas-msg{margin:0 0 22px}
.atlas-msg.is-user{display:flex;flex-direction:column;align-items:flex-end}
.atlas-msg-user{max-width:80%;background:#1d232b;color:#f5f1e8;border-radius:14px 14px 4px 14px;padding:10px 14px;font-size:13.5px;line-height:1.65;white-space:pre-wrap}
.atlas-msg-role{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--paper-muted);margin-bottom:6px}
.atlas-msg-assistant{font-size:14px;line-height:1.75;color:var(--paper-ink)}
.atlas-msg.error .atlas-msg-assistant{color:#a33a3a}
.atlas-msg-actions{display:flex;gap:6px;margin-top:6px;opacity:0;transition:opacity .15s}
.atlas-msg:hover .atlas-msg-actions{opacity:1}
.atlas-mini{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--paper-line);background:#fffdf8;color:var(--paper-muted);font-size:11px;cursor:pointer}
.atlas-mini:hover{color:var(--paper-ink);background:#f3efe6}
.atlas-msg-block{max-width:84%}

.atlas-quote{max-width:84%;margin-bottom:6px;padding:7px 10px;border-left:3px solid #b9cdf0;background:#eef3fb;border-radius:0 8px 8px 0;font-size:11.5px;color:#4b5f7a;line-height:1.5;white-space:pre-wrap}
.atlas-quote-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:#7c8ca3;margin-bottom:3px}
.atlas-quote-head button{border:0;background:transparent;color:#7c8ca3;cursor:pointer}

/* markdown */
.atlas-md p{margin:0 0 10px}
.atlas-md p:last-child{margin-bottom:0}
.atlas-md h2{font-size:17px;margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--paper-line);letter-spacing:.1px}
.atlas-md h3{font-size:14.5px;margin:18px 0 6px}
.atlas-md ul,.atlas-md ol{margin:0 0 10px;padding-left:22px}
.atlas-md li{margin:3px 0}
.atlas-md blockquote{margin:0 0 10px;padding:8px 12px;border-left:3px solid #c9c1b1;background:#f5f1e8;color:#5b6472;border-radius:0 8px 8px 0}
.atlas-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#efe9dd;border-radius:4px;padding:1px 4px}
.atlas-md pre{margin:0 0 12px;padding:12px 14px;border-radius:10px;background:#101720;color:#dbe6f2;overflow:auto;font-size:12px;line-height:1.6}
.atlas-md pre code{background:transparent;padding:0;color:inherit;font-size:inherit}
.atlas-md a{color:#2f6bb0}
.atlas-md hr{border:0;border-top:1px solid var(--paper-line);margin:16px 0}

/* closure */
.atlas-card{border:1px solid #cfe0d4;border-radius:14px;background:linear-gradient(180deg,#f4fbf5,#f8fbf7);padding:16px 18px;margin:0 0 24px;box-shadow:0 1px 0 rgba(255,255,255,.8) inset}
.atlas-card.amber{border-color:#e7d7ad;background:linear-gradient(180deg,#fdf9ec,#fbf7ee)}
.atlas-card-head{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#5a7a62;margin-bottom:8px}
.atlas-card.amber .atlas-card-head{color:#8a6d1f}
.atlas-card h4{margin:0 0 10px;font-size:15px;line-height:1.5;font-weight:650}
.atlas-card ul{margin:0 0 10px;padding-left:18px;font-size:12.5px;line-height:1.6;color:#38423a}
.atlas-card .open{margin-top:10px;padding-top:10px;border-top:1px dashed #d6e2d8;font-size:12px;color:#5d6b60}
.atlas-card .next{font-size:12px;color:#4f6a56;margin-top:8px}
.atlas-card-actions{display:flex;gap:6px;margin-top:10px}

/* composer */
.atlas-composer-wrap{border-top:1px solid var(--paper-line);padding:12px 22px 16px;background:#fffdf8}
.atlas-composer{max-width:720px;margin:0 auto;border:1px solid #d9d2c4;border-radius:14px;background:#fff;padding:8px 10px 8px 14px;display:flex;align-items:flex-end;gap:8px;transition:border-color .15s,box-shadow .15s}
.atlas-composer:focus-within{border-color:#9eb7d8;box-shadow:0 0 0 3px rgba(110,168,254,.12)}
.atlas-composer textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font-family:inherit;font-size:13.5px;line-height:1.6;color:var(--paper-ink);max-height:160px;min-height:24px;padding:4px 0}
.atlas-send{width:34px;height:34px;border-radius:10px;border:0;background:#1d232b;color:#fff;cursor:pointer;display:grid;place-items:center;flex:none}
.atlas-send:disabled{opacity:.4;cursor:default}
.atlas-composer-hint{max-width:720px;margin:6px auto 0;font-size:10.5px;color:var(--paper-muted);display:flex;justify-content:space-between;gap:8px}

/* subthread */
.atlas-sub{margin:10px 0 24px;border-left:2px dashed #b9cdf0;border-radius:0 12px 12px 0;background:#f4f7fc;padding:10px 14px 12px}
.atlas-sub-head{display:flex;align-items:center;gap:8px;font-size:12px;color:#3f5c7e;margin-bottom:8px}
.atlas-sub-head b{font-weight:650}
.atlas-sub-head .atlas-mini{margin-left:auto;background:#fff}
.atlas-sub-msg{margin:0 0 10px}
.atlas-sub-msg .who{font-size:10px;color:#7c8ca3;margin-bottom:2px}
.atlas-sub-msg .body{font-size:12.5px;line-height:1.6;color:#2c3a4a}
.atlas-sub-msg.is-user .body{white-space:pre-wrap}
.atlas-sub-composer{display:flex;gap:6px;margin-top:8px}
.atlas-sub-composer .atlas-input{height:30px;background:#fff;font-size:12px;color:#1d232b;border-color:#d6dfeb}
.atlas-sub-form{display:flex;gap:6px;margin-top:8px}
.atlas-sub-form .atlas-input{height:30px;background:#fff;font-size:12px;color:#1d232b;border-color:#d6dfeb}

.atlas-loading{display:flex;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--paper-muted);font-size:12px}
.atlas-spinner{width:16px;height:16px;border-radius:50%;border:2px solid #d8d2c5;border-top-color:#1d232b;animation:atlas-spin .8s linear infinite}
@keyframes atlas-spin{to{transform:rotate(360deg)}}

.atlas-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:90;background:#1d232b;color:#f5f1e8;font-size:12px;padding:9px 14px;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.35);max-width:80%}

@media (max-width:820px){
  .atlas-sheet-body{grid-template-columns:1fr}
  .atlas-outline{display:none}
  .atlas-thread{padding:18px 18px 6px}
  .atlas-sheet-backdrop{padding:10px}
  .atlas-search{width:130px}
  .atlas-search:focus{width:170px}
  .atlas-brand-sub{display:none}
}
`
