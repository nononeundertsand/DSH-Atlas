/** Atlas 的样式。作用域统一在 .atlas-app 内，颜色与字体优先跟随 DSH 的 --dsw-* / --dsh-* token。 */
export const ATLAS_CSS = String.raw`
.atlas-app{
  --atlas-bg:var(--dsw-alias-bg-base,#f7f8fa);
  --atlas-surface:var(--dsw-alias-bg-layer-1,#fff);
  --atlas-surface-2:var(--dsw-alias-bg-layer-2,#f2f4f7);
  --atlas-surface-3:var(--dsw-alias-bg-layer-3,#fff);
  --atlas-border:var(--dsw-alias-border-l2,rgba(15,23,42,.12));
  --atlas-border-strong:var(--dsw-alias-border-l3,rgba(15,23,42,.2));
  --atlas-text:var(--dsw-alias-label-primary,#1f2329);
  --atlas-text-2:var(--dsw-alias-label-secondary,#5f6b7a);
  --atlas-text-3:var(--dsw-alias-label-tertiary,#8a94a3);
  --atlas-accent:var(--dsw-alias-brand-primary,#4f7cff);
  --atlas-primary-fill:var(--dsw-alias-button-primary-fill,var(--atlas-accent));
  --atlas-primary-hover:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--atlas-accent) 88%,#000));
  --atlas-on-primary:var(--dsw-alias-label-primary-foreground,#fff);
  --atlas-success:var(--dsw-alias-state-success-primary,#2f9e68);
  --atlas-success-soft:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--atlas-success) 10%,var(--atlas-surface)));
  --atlas-warn:var(--dsw-alias-state-warn-primary,#d99a2b);
  --atlas-warn-soft:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--atlas-warn) 10%,var(--atlas-surface)));
  --atlas-danger:var(--dsw-alias-state-error-primary,#d64545);
  --atlas-mask:var(--dsw-alias-bg-mask-1,rgba(10,14,20,.38));
  --atlas-shadow-soft:var(--dsw-elevation-soft,0 2px 8px rgba(15,23,42,.08));
  --atlas-shadow-panel:var(--dsw-elevation-panel,0 14px 38px rgba(15,23,42,.16));
  --atlas-font-size:var(--dsh-content-font-size,14px);
  position:relative;height:100%;min-height:0;overflow:hidden;
  background:
    radial-gradient(900px 600px at 18% 12%,color-mix(in srgb,var(--atlas-accent) 9%,transparent),transparent 62%),
    radial-gradient(900px 700px at 82% 82%,color-mix(in srgb,var(--atlas-success) 6%,transparent),transparent 64%),
    var(--atlas-bg);
  color:var(--atlas-text);
  font-family:inherit;
  font-size:var(--atlas-font-size);
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
.atlas-app *{box-sizing:border-box}
.atlas-app button{font-family:inherit}
.atlas-app ::selection{background:color-mix(in srgb,var(--atlas-accent) 28%,transparent)}

/* ── canvas ─────────────────────────────────────────────────────────────── */
.atlas-canvas{position:absolute;inset:0;overflow:hidden;cursor:grab;touch-action:none}
.atlas-canvas.panning{cursor:grabbing}
.atlas-grid{position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(circle,color-mix(in srgb,var(--atlas-text-3) 30%,transparent) 1px,transparent 1px);
  background-size:26px 26px}
.atlas-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.atlas-edge{fill:none;stroke:color-mix(in srgb,var(--atlas-text-3) 42%,transparent);stroke-width:1.4}
.atlas-edge.is-active{stroke:color-mix(in srgb,var(--atlas-accent) 68%,transparent)}

.atlas-node{
  position:absolute;
  width:calc(288px * var(--atlas-card-scale,1));
  height:calc(104px * var(--atlas-card-scale,1));
  padding:calc(12px * var(--atlas-card-scale,1)) calc(14px * var(--atlas-card-scale,1)) calc(10px * var(--atlas-card-scale,1));
  border-radius:calc(14px * var(--atlas-card-scale,1));border:1px solid var(--atlas-border);
  background:var(--atlas-surface);
  box-shadow:var(--atlas-shadow-soft);
  cursor:pointer;user-select:none;overflow:hidden;
  display:flex;flex-direction:column;
  transition:border-color .18s,box-shadow .18s,transform .18s,width .18s,height .18s;
}
.atlas-node::before{
  content:"";position:absolute;left:0;top:15px;bottom:15px;width:3px;border-radius:0 3px 3px 0;
  background:color-mix(in srgb,var(--atlas-text-3) 42%,transparent);
}
.atlas-node:hover{border-color:var(--atlas-border-strong);box-shadow:var(--atlas-shadow-panel);transform:translateY(-1px)}
.atlas-node.is-active{border-color:color-mix(in srgb,var(--atlas-accent) 46%,var(--atlas-border))}
.atlas-node.is-active::before{background:var(--atlas-accent)}
.atlas-node.is-closed{border-color:color-mix(in srgb,var(--atlas-success) 40%,var(--atlas-border))}
.atlas-node.is-closed::before{background:var(--atlas-success)}
.atlas-node.is-paused{border-color:color-mix(in srgb,var(--atlas-warn) 42%,var(--atlas-border))}
.atlas-node.is-paused::before{background:var(--atlas-warn)}
.atlas-node.is-archived{opacity:.55}
.atlas-node-title{
  flex:none;padding-right:calc(52px * var(--atlas-card-scale,1));color:var(--atlas-text);
  font-size:calc(14px * var(--atlas-card-scale,1));font-weight:600;
  line-height:calc(20px * var(--atlas-card-scale,1));letter-spacing:.1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.atlas-node-sub{
  flex:1;min-height:0;margin-top:calc(3px * var(--atlas-card-scale,1));color:var(--atlas-text-2);
  font-size:calc(12px * var(--atlas-card-scale,1));
  line-height:calc(17px * var(--atlas-card-scale,1));
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;
}
.atlas-node-meta{flex:none;display:flex;align-items:center;gap:calc(7px * var(--atlas-card-scale,1));height:calc(14px * var(--atlas-card-scale,1));margin-top:calc(4px * var(--atlas-card-scale,1));color:var(--atlas-text-3);font-size:calc(11px * var(--atlas-card-scale,1));min-width:0;overflow:hidden}
.atlas-node-meta > span:not(.atlas-node-visit){flex:none;white-space:nowrap}
.atlas-node-visit{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--atlas-text-3);font-size:calc(10.5px * var(--atlas-card-scale,1))}
.atlas-status-dot{width:7px;height:7px;border-radius:50%;background:var(--atlas-text-3);flex:none}
.is-active .atlas-status-dot{background:var(--atlas-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-accent) 16%,transparent)}
.is-closed .atlas-status-dot{background:var(--atlas-success);box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-success) 14%,transparent)}
.is-paused .atlas-status-dot{background:var(--atlas-warn)}
.atlas-mastery{display:inline-flex;align-items:center;gap:7px;margin-left:auto;min-width:0;flex:none}
.atlas-mastery.is-compact{gap:5px}
.atlas-mastery-label{font-size:11px;color:var(--atlas-text-2);white-space:nowrap;font-variant-numeric:tabular-nums}
.atlas-mastery-meter{display:inline-flex;gap:4px;flex:none}
.atlas-mastery.is-compact .atlas-mastery-meter{gap:2px}
.atlas-mastery-seg{
  width:22px;height:12px;padding:0;border-radius:4px;border:1px solid var(--atlas-border);
  background:var(--atlas-surface-2);cursor:pointer;display:block;
  transition:background .15s,border-color .15s,transform .15s;
}
i.atlas-mastery-seg{cursor:default}
.atlas-mastery.is-compact .atlas-mastery-seg{width:14px;height:6px;border-radius:2px;border:0}
.atlas-mastery-seg:hover{transform:translateY(-1px);border-color:var(--atlas-text-3)}
.atlas-mastery-seg.is-on{background:var(--atlas-text-3);border-color:transparent}
.atlas-mastery.level-1 .atlas-mastery-seg.is-on{background:var(--atlas-danger)}
.atlas-mastery.level-2 .atlas-mastery-seg.is-on{background:var(--atlas-warn)}
.atlas-mastery.level-3 .atlas-mastery-seg.is-on{background:var(--atlas-accent)}
.atlas-mastery.level-4 .atlas-mastery-seg.is-on,.atlas-mastery.level-5 .atlas-mastery-seg.is-on{background:var(--atlas-success)}

.atlas-node-actions{position:absolute;top:calc(8px * var(--atlas-card-scale,1));right:calc(8px * var(--atlas-card-scale,1));display:flex;gap:calc(4px * var(--atlas-card-scale,1))}
.atlas-node-add,.atlas-node-toggle{
  height:calc(22px * var(--atlas-card-scale,1));min-width:calc(22px * var(--atlas-card-scale,1));padding:0 calc(5px * var(--atlas-card-scale,1));border-radius:calc(7px * var(--atlas-card-scale,1));
  border:1px solid var(--atlas-border);background:var(--atlas-surface-2);
  color:var(--atlas-text-2);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  font-size:12px;line-height:1;transition:opacity .15s,background .15s,color .15s,border-color .15s;
}
.atlas-node-add{width:calc(22px * var(--atlas-card-scale,1));font-size:calc(15px * var(--atlas-card-scale,1));opacity:0}
.atlas-node:hover .atlas-node-add{opacity:1}
.atlas-node-toggle{font-weight:600;font-variant-numeric:tabular-nums;opacity:0}
.atlas-node.has-children .atlas-node-toggle{opacity:.72}
.atlas-node:hover .atlas-node-toggle,.atlas-node.is-collapsed .atlas-node-toggle{opacity:1}
.atlas-node-add:hover,.atlas-node-toggle:hover{background:var(--atlas-surface-3);color:var(--atlas-text);border-color:var(--atlas-border-strong)}
.atlas-node.is-collapsed .atlas-node-toggle{color:var(--atlas-accent);border-color:color-mix(in srgb,var(--atlas-accent) 38%,var(--atlas-border))}

.atlas-canvas.lod-mid .atlas-node-sub{display:none}
.atlas-canvas.lod-mid .atlas-node-meta{display:none}
.atlas-canvas.lod-far .atlas-node{width:200px;height:56px;padding:10px 12px}
.atlas-canvas.lod-far .atlas-node-sub,.atlas-canvas.lod-far .atlas-node-meta,.atlas-canvas.lod-far .atlas-node-actions{display:none}
.atlas-canvas.lod-far .atlas-node-title{font-size:13px;padding-right:0}
.atlas-canvas.lod-map .atlas-node{width:124px;height:36px;padding:0 12px;display:flex;flex-direction:row;align-items:center;gap:7px;border-radius:10px}
.atlas-canvas.lod-map .atlas-node-title{font-size:0;padding-right:0}
.atlas-canvas.lod-map .atlas-node-title::after{content:"";display:block;width:72px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--atlas-text-3) 45%,transparent)}
.atlas-canvas.lod-map .atlas-node-sub,.atlas-canvas.lod-map .atlas-node-meta,.atlas-canvas.lod-map .atlas-node-actions{display:none}

/* ── topbar ─────────────────────────────────────────────────────────────── */
.atlas-topbar{position:absolute;left:16px;right:16px;top:14px;z-index:20;display:flex;align-items:center;gap:8px;pointer-events:none}
.atlas-topbar > *{pointer-events:auto}
.atlas-brand{display:flex;align-items:center;gap:8px;padding:7px 11px;border-radius:10px;background:var(--atlas-surface);border:1px solid var(--atlas-border);box-shadow:var(--atlas-shadow-soft)}
.atlas-brand-mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--atlas-accent),var(--atlas-success));display:grid;place-items:center;color:#fff;font-weight:800;font-size:11px}
.atlas-brand-name{font-size:13px;font-weight:650;letter-spacing:.2px;color:var(--atlas-text)}
.atlas-brand-sub{font-size:10px;color:var(--atlas-text-3)}
.atlas-spacer{flex:1}
.atlas-update{height:36px;padding:0 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--atlas-accent) 38%,var(--atlas-border));background:color-mix(in srgb,var(--atlas-accent) 10%,var(--atlas-surface));color:var(--atlas-accent);font-size:13px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:5px;transition:background .15s,border-color .15s}
.atlas-update:hover{background:color-mix(in srgb,var(--atlas-accent) 17%,var(--atlas-surface));border-color:color-mix(in srgb,var(--atlas-accent) 55%,var(--atlas-border))}
.atlas-btn{height:36px;padding:0 13px;border-radius:10px;border:1px solid var(--atlas-border);background:var(--atlas-surface);color:var(--atlas-text-2);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,color .15s}
.atlas-btn:hover{background:var(--atlas-surface-2);border-color:var(--atlas-border-strong);color:var(--atlas-text)}
.atlas-btn.primary{background:var(--atlas-primary-fill);color:var(--atlas-on-primary);border-color:var(--atlas-primary-fill);font-weight:600}
.atlas-btn.primary:hover{background:var(--atlas-primary-hover);border-color:var(--atlas-primary-hover)}
.atlas-btn.ghost{background:transparent;box-shadow:none}
.atlas-btn.danger{color:var(--atlas-danger);border-color:color-mix(in srgb,var(--atlas-danger) 34%,var(--atlas-border))}
.atlas-btn.danger:hover{background:color-mix(in srgb,var(--atlas-danger) 9%,var(--atlas-surface))}
.atlas-btn:disabled{opacity:.5;cursor:default}
.atlas-select{height:36px;max-width:200px;border-radius:10px;border:1px solid var(--atlas-border);background:var(--atlas-surface);color:var(--atlas-text-2);font-size:13px;padding:0 10px;cursor:pointer}
.atlas-search-wrap{position:relative}
.atlas-search{height:36px;width:200px;border-radius:10px;border:1px solid var(--atlas-border);background:var(--atlas-surface);color:var(--atlas-text);font-size:13px;padding:0 12px;outline:none;transition:width .18s,border-color .15s,box-shadow .15s}
.atlas-search::placeholder{color:var(--atlas-text-3)}
.atlas-search:focus{border-color:color-mix(in srgb,var(--atlas-accent) 58%,var(--atlas-border));width:260px;box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-accent) 13%,transparent)}
.atlas-search-pop{position:absolute;top:42px;right:0;width:380px;max-height:340px;overflow:auto;border-radius:12px;background:var(--atlas-surface);border:1px solid var(--atlas-border);box-shadow:var(--atlas-shadow-panel);padding:6px}
.atlas-search-hit{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--atlas-text);padding:9px 11px;border-radius:8px;cursor:pointer}
.atlas-search-hit:hover{background:var(--atlas-surface-2)}
.atlas-search-hit b{display:block;font-size:13px;font-weight:600}
.atlas-search-hit span{display:block;font-size:12px;color:var(--atlas-text-3);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atlas-search-empty{padding:14px;font-size:12px;color:var(--atlas-text-3);text-align:center}

/* ── empty state ────────────────────────────────────────────────────────── */
.atlas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.atlas-empty-card{pointer-events:auto;width:min(440px,calc(100% - 40px));padding:28px;border-radius:18px;border:1px solid var(--atlas-border);background:var(--atlas-surface);box-shadow:var(--atlas-shadow-panel)}
.atlas-empty h2{margin:0 0 8px;font-size:20px;letter-spacing:.2px;color:var(--atlas-text)}
.atlas-empty p{margin:0 0 18px;color:var(--atlas-text-2);font-size:13px;line-height:1.6}
.atlas-empty-form{display:flex;gap:8px}
.atlas-input{height:38px;flex:1;border-radius:10px;border:1px solid var(--atlas-border);background:var(--atlas-surface-2);color:var(--atlas-text);font-size:13px;padding:0 12px;outline:none;transition:border-color .15s,box-shadow .15s}
.atlas-input::placeholder{color:var(--atlas-text-3)}
.atlas-input:focus{border-color:color-mix(in srgb,var(--atlas-accent) 58%,var(--atlas-border));box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-accent) 13%,transparent)}

/* ── dialog ─────────────────────────────────────────────────────────────── */
.atlas-dialog-backdrop{position:absolute;inset:0;z-index:80;background:var(--atlas-mask);display:flex;align-items:center;justify-content:center}
.atlas-dialog{width:min(360px,calc(100% - 40px));border-radius:16px;border:1px solid var(--atlas-border);background:var(--atlas-surface);padding:20px;box-shadow:var(--atlas-shadow-panel)}
.atlas-dialog h3{margin:0 0 14px;font-size:15px;color:var(--atlas-text)}
.atlas-dialog .atlas-input{width:100%}
.atlas-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}

/* settings */
.atlas-settings{width:min(420px,calc(100% - 40px))}
.atlas-setting{display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px 12px;padding:12px 0;border-top:1px solid var(--atlas-border)}
.atlas-setting:first-of-type{border-top:0;padding-top:4px}
.atlas-setting span{font-size:13px;color:var(--atlas-text)}
.atlas-setting output{font-size:12px;color:var(--atlas-text-2);font-variant-numeric:tabular-nums}
.atlas-setting input[type="range"]{grid-column:1 / -1;width:100%;height:20px;margin:2px 0 0;accent-color:var(--atlas-accent);cursor:pointer}
.atlas-settings-note{margin:12px 0 0;font-size:11.5px;line-height:1.5;color:var(--atlas-text-3)}

/* ── chat sheet ─────────────────────────────────────────────────────────── */
.atlas-sheet-backdrop{position:absolute;inset:0;z-index:50;background:var(--atlas-mask);display:flex;align-items:center;justify-content:center;padding:22px;animation:atlas-fade .18s ease}
.atlas-sheet{width:min(var(--atlas-sheet-width,1040px),100%);height:100%;max-height:100%;border-radius:18px;background:var(--atlas-surface);color:var(--atlas-text);border:1px solid var(--atlas-border);display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--atlas-shadow-panel);animation:atlas-sheet-in .22s cubic-bezier(.2,.8,.2,1)}
@keyframes atlas-fade{from{opacity:0}to{opacity:1}}
@keyframes atlas-sheet-in{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
.atlas-sheet-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--atlas-border);background:linear-gradient(180deg,var(--atlas-surface),var(--atlas-surface-2))}
.atlas-sheet-head-main{min-width:0;flex:1}
.atlas-breadcrumb{font-size:11px;color:var(--atlas-text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.atlas-title-input{width:100%;border:0;background:transparent;font-size:18px;font-weight:650;color:var(--atlas-text);padding:0;outline:none;font-family:inherit}
.atlas-head-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:4px;font-size:11.5px;color:var(--atlas-text-3)}
.atlas-head-actions{display:flex;align-items:center;gap:6px;flex:none}
.atlas-paper-btn{height:34px;padding:0 12px;border-radius:9px;border:1px solid var(--atlas-border);background:var(--atlas-surface);color:var(--atlas-text-2);font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,color .15s}
.atlas-paper-btn:hover{background:var(--atlas-surface-2);color:var(--atlas-text);border-color:var(--atlas-border-strong)}
.atlas-paper-btn.primary{background:var(--atlas-primary-fill);color:var(--atlas-on-primary);border-color:var(--atlas-primary-fill)}
.atlas-paper-btn.primary:hover{background:var(--atlas-primary-hover);border-color:var(--atlas-primary-hover)}
.atlas-paper-btn.danger{color:var(--atlas-danger);border-color:color-mix(in srgb,var(--atlas-danger) 34%,var(--atlas-border))}
.atlas-paper-btn:disabled{opacity:.5;cursor:default}

.atlas-sheet-body{display:grid;grid-template-columns:190px 1fr;flex:1;min-height:0}
.atlas-outline{border-right:1px solid var(--atlas-border);padding:14px 10px;overflow:auto;background:var(--atlas-surface-2)}
.atlas-outline-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--atlas-text-3);padding:0 8px 8px}
.atlas-outline-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--atlas-text-2);font-size:12px;line-height:1.4;padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.atlas-outline-item:hover{background:var(--atlas-surface-3);color:var(--atlas-text)}
.atlas-outline-item.lvl3{padding-left:18px;font-size:11px}
.atlas-outline-empty{padding:8px;font-size:11px;color:var(--atlas-text-3);line-height:1.5}

.atlas-thread{overflow:auto;padding:22px 30px 8px;min-height:0}
.atlas-thread-inner{max-width:820px;margin:0 auto}
.atlas-msg{margin:0 0 22px}
.atlas-msg.is-user{display:flex;flex-direction:column;align-items:flex-end}
.atlas-msg-user{max-width:80%;background:var(--atlas-primary-fill);color:var(--atlas-on-primary);border-radius:14px 14px 4px 14px;padding:10px 14px;font-size:var(--atlas-chat-font-size,14px);line-height:1.65;white-space:pre-wrap}
.atlas-msg-role{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--atlas-text-3);margin-bottom:6px}
.atlas-msg-assistant{font-size:var(--atlas-chat-font-size,14px);line-height:1.75;color:var(--atlas-text)}
.atlas-msg.error .atlas-msg-assistant{color:var(--atlas-danger)}
.atlas-msg-actions{display:flex;gap:6px;margin-top:6px;opacity:0;transition:opacity .15s}
.atlas-msg:hover .atlas-msg-actions{opacity:1}
.atlas-mini{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--atlas-border);background:var(--atlas-surface);color:var(--atlas-text-3);font-size:11px;cursor:pointer;transition:background .15s,color .15s}
.atlas-mini:hover{color:var(--atlas-text);background:var(--atlas-surface-2)}
.atlas-msg-block{max-width:84%}

.atlas-quote{max-width:84%;margin-bottom:6px;padding:7px 10px;border-left:3px solid color-mix(in srgb,var(--atlas-accent) 55%,transparent);background:color-mix(in srgb,var(--atlas-accent) 7%,var(--atlas-surface));border-radius:0 8px 8px 0;font-size:11.5px;color:var(--atlas-text-2);line-height:1.5;white-space:pre-wrap}
.atlas-quote-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:var(--atlas-text-3);margin-bottom:3px}
.atlas-quote-head button{border:0;background:transparent;color:var(--atlas-text-3);cursor:pointer}

/* markdown */
.atlas-md p{margin:0 0 10px}
.atlas-md p:last-child{margin-bottom:0}
.atlas-md h2{font-size:1.22em;margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--atlas-border);letter-spacing:.1px;color:var(--atlas-text)}
.atlas-md h3{font-size:1.06em;margin:18px 0 6px;color:var(--atlas-text)}
.atlas-md ul,.atlas-md ol{margin:0 0 10px;padding-left:22px}
.atlas-md li{margin:3px 0}
.atlas-md blockquote{margin:0 0 10px;padding:8px 12px;border-left:3px solid var(--atlas-border-strong);background:var(--atlas-surface-2);color:var(--atlas-text-2);border-radius:0 8px 8px 0}
.atlas-md code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:.9em;background:var(--dsw-alias-markdown-inline-code,var(--atlas-surface-2));border:1px solid var(--atlas-border);border-radius:4px;padding:0 4px}
.atlas-md pre{margin:0 0 12px;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-markdown-code-block,#0f1720);color:var(--dsw-alias-label-primary,#e6edf3);overflow:auto;font-size:var(--dsh-code-font-size,12px);line-height:1.6}
.atlas-md pre code{background:transparent;border:0;padding:0;color:inherit;font-size:inherit}
.atlas-md a{color:var(--atlas-accent)}
.atlas-md hr{border:0;border-top:1px solid var(--atlas-border);margin:16px 0}

/* closure */
.atlas-card{border:1px solid color-mix(in srgb,var(--atlas-success) 26%,var(--atlas-border));border-radius:14px;background:var(--atlas-success-soft);padding:16px 18px;margin:0 0 24px}
.atlas-card.amber{border-color:color-mix(in srgb,var(--atlas-warn) 30%,var(--atlas-border));background:var(--atlas-warn-soft)}
.atlas-card-head{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:color-mix(in srgb,var(--atlas-success) 78%,var(--atlas-text));margin-bottom:8px}
.atlas-card.amber .atlas-card-head{color:color-mix(in srgb,var(--atlas-warn) 78%,var(--atlas-text))}
.atlas-card h4{margin:0 0 10px;font-size:15px;line-height:1.5;font-weight:650;color:var(--atlas-text)}
.atlas-card ul{margin:0 0 10px;padding-left:18px;font-size:12.5px;line-height:1.6;color:var(--atlas-text-2)}
.atlas-card .open{margin-top:10px;padding-top:10px;border-top:1px dashed color-mix(in srgb,var(--atlas-success) 28%,var(--atlas-border));font-size:12px;color:var(--atlas-text-2)}
.atlas-card .next{font-size:12px;color:var(--atlas-text-2);margin-top:8px}
.atlas-card-actions{display:flex;gap:6px;margin-top:10px}

/* composer */
.atlas-composer-wrap{border-top:1px solid var(--atlas-border);padding:12px 22px 16px;background:var(--atlas-surface)}
.atlas-composer{max-width:820px;margin:0 auto;border:1px solid var(--atlas-border);border-radius:14px;background:var(--atlas-surface-2);padding:8px 10px 8px 14px;display:flex;align-items:flex-end;gap:8px;transition:border-color .15s,box-shadow .15s}
.atlas-composer:focus-within{border-color:color-mix(in srgb,var(--atlas-accent) 55%,var(--atlas-border));box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-accent) 13%,transparent)}
.atlas-composer textarea{flex:1;resize:none;border:0;outline:none;background:transparent;font-family:inherit;font-size:var(--atlas-chat-font-size,14px);line-height:1.6;color:var(--atlas-text);max-height:160px;min-height:24px;padding:4px 0}
.atlas-composer textarea::placeholder{color:var(--atlas-text-3)}
.atlas-send{width:36px;height:36px;border-radius:10px;border:0;background:var(--atlas-primary-fill);color:var(--atlas-on-primary);cursor:pointer;display:grid;place-items:center;flex:none;transition:background .15s}
.atlas-send:hover{background:var(--atlas-primary-hover)}
.atlas-send:disabled{opacity:.4;cursor:default}
.atlas-composer-hint{max-width:820px;margin:6px auto 0;font-size:11px;color:var(--atlas-text-3);display:flex;justify-content:space-between;gap:8px}

/* subthread */
.atlas-sub{margin:10px 0 24px;border-left:2px dashed color-mix(in srgb,var(--atlas-accent) 45%,transparent);border-radius:0 12px 12px 0;background:color-mix(in srgb,var(--atlas-accent) 5%,var(--atlas-surface));padding:10px 14px 12px}
.atlas-sub-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--atlas-text-2);margin-bottom:8px}
.atlas-sub-head b{font-weight:650;color:var(--atlas-text)}
.atlas-sub-head .atlas-mini{margin-left:auto}
.atlas-sub-msg{margin:0 0 10px}
.atlas-sub-msg .who{font-size:10px;color:var(--atlas-text-3);margin-bottom:2px}
.atlas-sub-msg .body{font-size:calc(var(--atlas-chat-font-size,14px) - 1px);line-height:1.65;color:var(--atlas-text-2)}
.atlas-sub-msg.is-user .body{white-space:pre-wrap}
.atlas-sub-composer{display:flex;gap:6px;margin-top:8px}
.atlas-sub-composer .atlas-input{height:30px;background:var(--atlas-surface);font-size:12px;color:var(--atlas-text)}
.atlas-sub-form{display:flex;gap:6px;margin-top:8px}
.atlas-sub-form .atlas-input{height:30px;background:var(--atlas-surface);font-size:12px;color:var(--atlas-text)}

.atlas-loading{display:flex;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--atlas-text-3);font-size:12px}
.atlas-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--atlas-border);border-top-color:var(--atlas-text);animation:atlas-spin .8s linear infinite}
@keyframes atlas-spin{to{transform:rotate(360deg)}}

/* selection explain popover */
.atlas-explain{position:fixed;z-index:120;width:min(360px,calc(100vw - 24px));border-radius:14px;border:1px solid var(--atlas-border);background:var(--atlas-surface);box-shadow:var(--atlas-shadow-panel);padding:12px 14px;animation:atlas-fade .14s ease}
.atlas-explain-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--atlas-text-3);margin-bottom:8px}
.atlas-explain-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atlas-explain-head button{flex:none;width:22px;height:22px;border-radius:6px;border:0;background:transparent;color:var(--atlas-text-3);cursor:pointer;font-size:12px;line-height:1}
.atlas-explain-head button:hover{background:var(--atlas-surface-2);color:var(--atlas-text)}
.atlas-explain-loading{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--atlas-text-2);padding:6px 0}
.atlas-explain-error{font-size:12px;line-height:1.55;color:var(--atlas-danger);padding:4px 0}
.atlas-explain-term{font-size:15px;font-weight:650;color:var(--atlas-text);margin-bottom:6px;word-break:break-word}
.atlas-explain-meaning{margin:0 0 10px;font-size:13px;line-height:1.65;color:var(--atlas-text-2)}
.atlas-explain-context{padding:8px 10px;border-left:3px solid color-mix(in srgb,var(--atlas-accent) 55%,transparent);background:color-mix(in srgb,var(--atlas-accent) 6%,var(--atlas-surface));border-radius:0 8px 8px 0}
.atlas-explain-context b{display:block;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--atlas-text-3);margin-bottom:3px}
.atlas-explain-context p{margin:0;font-size:13px;line-height:1.65;color:var(--atlas-text)}

.atlas-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);z-index:90;background:var(--dsw-alias-toast-bg,var(--atlas-text));color:var(--dsw-alias-toast-label,var(--atlas-surface));font-size:12px;padding:9px 14px;border-radius:10px;box-shadow:var(--atlas-shadow-panel);max-width:80%}

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
