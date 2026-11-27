// 公开提单页 / 查询页的静态 HTML（不依赖前端构建产物，才能在没登录的情况下直接打开）。
// 从 domain.js 搬出来：那边有 2000 行上限，而这三张页面和「领域数据形状」没关系。
// 注意：页面里的 fetch 地址是相对路径（/studio-api/intake/...），部署在子路径下会失效。

/* 公开提单/查询页是独立 HTML，不经过面板的构建链：样式只能是这一份内联 CSS。
   以前三页各自硬编码浅色，系统开深色时还是白底（与面板的深色主题割裂）。
   现在统一走 CSS 变量 + prefers-color-scheme: dark，两套对比度都按 WCAG AA 取色。 */
const PAGE_STYLE = 'body{font-family:system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}'
  + 'main{max-width:640px;margin:40px auto;padding:24px;background:var(--card);border:1px solid var(--border);border-radius:12px}'
  + 'h1{font-size:18px;margin:0 0 8px}p.hint{color:var(--muted);font-size:13px;margin:0 0 16px}'
  + 'label{display:block;font-size:12px;color:var(--muted2);margin:12px 0 8px}'
  + 'input,textarea,select{width:100%;box-sizing:border-box;height:36px;padding:4px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--card);color:var(--fg)}'
  + 'textarea{height:140px;padding:8px 12px;resize:vertical}'
  + 'button{margin-top:16px;height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--btn-bg);color:var(--btn-fg);font-size:13px;cursor:pointer}'
  + '#msg{margin-top:12px;font-size:13px;color:var(--ok)}#msg[data-bad=\"1\"]{color:var(--bad)}'
  + '#out{margin-top:16px;font-size:13px;line-height:1.7}#out b{font-size:16px}#out[data-bad=\"1\"]{color:var(--bad)}'
  + '.row{padding:12px 0;border-top:1px solid var(--border);font-size:13px;line-height:1.6}.row b{font-size:13px}'
  + '.tag{display:inline-block;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:11px;color:var(--muted2);margin-left:8px}'
  + '.kv{color:var(--muted);font-size:12px}'
  + ':root{--bg:#fafafa;--fg:#18181b;--card:#fff;--border:#e4e4e7;--muted:#71717a;--muted2:#52525b;--btn-bg:#18181b;--btn-fg:#fafafa;--bad:#b91c1c;--ok:#0f766e;color-scheme:light dark}'
  + '@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#fafafa;--card:#27272a;--border:#3f3f46;--muted:#a1a1aa;--muted2:#d4d4d8;--btn-bg:#fafafa;--btn-fg:#18181b;--bad:#fca5a5;--ok:#5eead4}}'
export const MINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我提过的需求</title>
<style>${PAGE_STYLE}</style></head>
<body><main><h1>我提过的需求</h1><p class="hint">输入提交时留的联系方式，只看得到你自己提的单。</p>
<input id="contact" placeholder="手机号或飞书"><button id="go">查询</button><div id="msg"></div><div id="list"></div></main>
<script>const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));document.getElementById('go').onclick=async()=>{const msg=document.getElementById('msg');const list=document.getElementById('list');msg.textContent='';list.innerHTML='查询中…';try{const r=await fetch(location.pathname.replace(/\/intake\/mine$/,'')+'/intake/mine/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contact:document.getElementById('contact').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'查询失败');if(j.rows.length===0){list.innerHTML='<p class="kv">没有查到记录，确认联系方式与提交时一致。</p>';return}list.innerHTML=j.rows.map(v=>'<div class="row"><b>'+esc(v.code)+'</b><span class="tag">'+esc(v.statusLabel)+'</span><br>'+esc(v.title)+'<br><span class="kv">待确认问题 '+esc(v.openQuestions)+' 条 · 已拆卡 '+esc(v.cards)+' 张（完成 '+esc(v.doneCards)+'）· 最近更新 '+esc(new Date(v.updatedAt||Date.now()).toLocaleString())+'</span></div>').join('')}catch(e){msg.textContent=e.message;list.innerHTML=''}}</script></body></html>`

export const STATUS_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需求进度</title>
<style>${PAGE_STYLE}</style></head>
<body><main style="max-width:560px"><h1>查需求进度</h1><p class="hint">用提交时拿到的需求编号，加联系方式的后四位。</p>
<label>需求编号</label><input id="code" placeholder="REQ-2026-001">
<label>联系方式后四位</label><input id="contact" maxlength="8" placeholder="0000">
<button id="go">查询</button><div id="out"></div></main>
<script>const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');out.textContent='查询中…';try{const r=await fetch(location.pathname.replace(/\/intake\/status$/,'')+'/intake/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value,contact:document.getElementById('contact').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'查询失败');out.removeAttribute('data-bad');out.innerHTML='<b>'+esc(j.code)+'</b><br>'+esc(j.title)+'<br><span class="kv">状态：'+esc(j.statusLabel)+(j.reviewStatus==='pending'?'（评审中）':j.reviewStatus==='changes_requested'?'（评审打回）':'')+'<br>待确认问题：'+esc(j.openQuestions)+' 条<br>已拆卡：'+esc(j.cards)+' 张（完成 '+esc(j.doneCards)+'）<br>最近更新：'+esc(new Date(j.updatedAt||Date.now()).toLocaleString())+'</span>'}catch(e){out.setAttribute('data-bad','1');out.textContent=e.message}}</script></body></html>`

export const INTAKE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>提需求</title>
<style>${PAGE_STYLE}</style></head>
<body><main><h1>提交需求</h1><p class="hint">写清楚背景和期望结果即可，产品会来接洽澄清。提交后会生成 REQ 编号。</p>
<label>需求标题</label><input id="title" maxlength="200" placeholder="一句话说清要解决的问题">
<label>需求描述</label><textarea id="description" placeholder="现状怎么做的、希望变成什么样、有什么硬约束（时间/合规/系统）"></textarea>
<div style="display:flex;gap:12px"><div style="flex:1"><label>您的姓名</label><input id="requester" placeholder="张三"></div><div style="flex:1"><label>部门</label><input id="dept" placeholder="财务部"></div></div>
<label>联系方式</label><input id="contact" placeholder="手机或飞书">
<label>紧急程度</label><select id="priority"><option value="normal">一般</option><option value="urgent">紧急</option><option value="relaxed">不急</option></select>
<button id="send">提交需求</button><div id="msg"></div></main>
<script>document.getElementById('send').onclick=async()=>{const msg=document.getElementById('msg');const body={title:document.getElementById('title').value,description:document.getElementById('description').value,requester:document.getElementById('requester').value,dept:document.getElementById('dept').value,contact:document.getElementById('contact').value,priority:document.getElementById('priority').value};try{const r=await fetch(location.pathname.replace(/\/intake$/,'')+'/intake/requirement',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||'提交失败');msg.removeAttribute('data-bad');msg.textContent='已提交，需求编号 '+j.code+'。产品会尽快接洽。'}catch(e){msg.setAttribute('data-bad','1');msg.textContent=e.message}}</script></body></html>`
