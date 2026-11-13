
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SVCS = ['AM','PM'];
const SVC_NAME = {AM:'Morning', PM:'Evening'};
const DEFAULT_RULES = {AM:{inside:1,outside:1}, PM:{inside:1,outside:0}};

function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function defaultSunday(){ const d=new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate()+((7-d.getDay())%7)); return ymd(d); }
function shiftDate(s,days){ const [y,m,dd]=s.split('-').map(Number); const d=new Date(y,m-1,dd,12); d.setDate(d.getDate()+days); return ymd(d); }
function fmtDate(s,opt){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d,12).toLocaleDateString(undefined,opt||{weekday:'short',month:'short',day:'numeric'}); }

const S = {
  db:null, me:null, role:null, access:null, links:null, linkState:{}, signOut:null, canWrite:true, noDb:false, accessList:null,
  loaded:{members:false,posts:false,weeks:false}, medics:[],
  members:[], posts:[], settings:null, weeks:{}, profiles:{},
  tab:'sunday', date:defaultSunday(), mode:'avail', svc:'AM', editMap:false, layout:null, selSec:null, selPt:null, mirror:true, withDuties:false, showMap:false, dragging:false, pendingRender:false
};

function rules(){ const r=(S.settings&&S.settings.rules)||{}; return {AM:{...DEFAULT_RULES.AM,...(r.AM||{})}, PM:{...DEFAULT_RULES.PM,...(r.PM||{})}}; }
function memberMap(){ const o={}; S.members.forEach(m=>o[m.id]=m); return o; }
function postsFor(svc){ return S.posts.filter(p=>(p.services||[]).includes(svc)); }
function label(p){ return p.seat ? '('+p.code+')' : p.code; }
function blankWeek(){ return {date:S.date, avail:{}, sched:{AM:{},PM:{}}, locks:{AM:{},PM:{}}}; }
function week(){ return S.weeks[S.date] || blankWeek(); }
const QUALS=[['churchKey','Church key','Key'],['doorApp','Door app','Door'],['gateApp','Gate app','Gate'],['medTrained','Medical training','Med']];
// The group chat availability link is turned on or off in the app (Roster tab → Group chat link).
const showAvailLink=()=>!!(S.settings&&S.settings.availLink);
function personTags(m){ if(!m) return ''; return m.armed?'<span class="tag armed">Armed</span>':''; }
function qualTags(m){ if(!m) return ''; return QUALS.filter(([k])=>m[k]).map(([,,short])=>`<span class="tag">${short}</span>`).join(''); }
function qualText(m){ return QUALS.filter(([k])=>m&&m[k]).map(([,,short])=>short.toLowerCase()).join(' · '); }
function needsArmed(p,svc){ return Array.isArray(p.armedIn) ? p.armedIn.includes(svc) : !!p.requiresArmed; }
function medicName(w,svc){ const id=w&&w.med&&w.med[svc]; const m=id&&S.medics.find(x=>x.id===id); return m?m.name:''; }

/* ---------- toast & errors ---------- */
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,2600); }
function errMsg(e){
  switch(e&&e.code){
    case 'invalid_argument': return 'Couldn’t save. You may only have view access to this page.';
    case 'quota_exceeded': return 'Storage is full. Delete old weeks in History.';
    case 'resource_exhausted': return 'Too many changes at once. Wait a moment and try again.';
    case 'revoked': return 'Access to this page changed. Reload to continue.';
    default: return 'Couldn’t save. Check your connection and try again.';
  }
}
async function withRetry(fn){ try{ return await fn(); }catch(e){ if(e&&e.code==='unavailable'){ await new Promise(r=>setTimeout(r,400+Math.random()*600)); return await fn(); } throw e; } }
async function write(fn){ if(!S.db) return false; try{ await withRetry(fn); return true; }catch(e){ toast(errMsg(e)); return false; } }
function guard(){ if(!S.canWrite){ toast('You have view-only access.'); return false; } return true; }

/* ---------- week saving (debounced, one write at a time) ---------- */
const localW = new WeakSet();
let wTimer=null, wSeq=0, wSaved=0, wDate=null, wChain=Promise.resolve();
function editableWeek(){
  let w=S.weeks[S.date];
  if(!w || !localW.has(w)){
    const b = w ? JSON.parse(JSON.stringify(w)) : {};
    w = {date:S.date, avail:b.avail||{}, sched:{AM:{},PM:{},...(b.sched||{})}, locks:{AM:{},PM:{},...(b.locks||{})}, med:{...(b.med||{})}, generatedAt:b.generatedAt||null};
    localW.add(w); S.weeks[S.date]=w;
  }
  return w;
}
function touchWeek(){ wSeq++; wDate=S.date; clearTimeout(wTimer); wTimer=setTimeout(flushWeek,450); }
function isDirty(date){ return wDate===date && wSaved<wSeq; }
function flushWeek(){
  clearTimeout(wTimer);
  if(!wDate || wSaved>=wSeq || !S.db) return wChain;
  const date=wDate, seq=wSeq, w=S.weeks[date];
  const body = JSON.parse(JSON.stringify({date, avail:w.avail, sched:w.sched, locks:w.locks, med:w.med||{}, generatedAt:w.generatedAt||null, updatedAt:Date.now(), updatedBy:S.me||null}));
  wChain = wChain.then(async()=>{
    try{ await withRetry(()=>S.db.doc('weeks/'+date).set(body)); }
    catch(e){ toast(errMsg(e)); }
    wSaved=Math.max(wSaved,seq);
  });
  return wChain;
}

/* ---------- rotation & generator ---------- */
function historyStats(beforeDate){
  const past=Object.values(S.weeks).filter(w=>w.date<beforeDate).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,8);
  const load={}, lastAt={};
  past.forEach((w,i)=>SVCS.forEach(svc=>{
    Object.entries((w.sched&&w.sched[svc])||{}).forEach(([pid,mid])=>{
      if(!mid) return;
      load[mid]=(load[mid]||0)+1;
      lastAt[mid]=lastAt[mid]||{};
      if(lastAt[mid][pid]===undefined) lastAt[mid][pid]=i;
    });
  }));
  return {load,lastAt};
}

function genService(svc, w, stats, servedEarlier){
  const posts=postsFor(svc), byId=memberMap();
  const prev=(w.sched&&w.sched[svc])||{}, locks=(w.locks&&w.locks[svc])||{};
  const avail=S.members.filter(m=>m.active!==false && w.avail[m.id] && w.avail[m.id][svc]);
  const sched={}, used=new Set(), jit={};
  avail.forEach(m=>jit[m.id]=Math.random());
  const fits=(m,p)=>!needsArmed(p,svc)||m.armed;
  const score=(m,p)=>{
    const load=(stats.load[m.id]||0)*10 + (servedEarlier[m.id]?6:0);
    const la=stats.lastAt[m.id]&&stats.lastAt[m.id][p.id];
    const repeat = la===undefined ? 0 : Math.max(0,4-la)*4;
    return load+repeat+jit[m.id];
  };
  const put=(p,m)=>{ sched[p.id]=m.id; used.add(m.id); };
  const best=(p,extra)=>avail.filter(m=>!used.has(m.id)&&fits(m,p)&&(!extra||extra(m))).sort((a,b)=>score(a,p)-score(b,p))[0];

  // 1. locked assignments stay
  posts.forEach(p=>{ const mid=prev[p.id]; if(locks[p.id] && byId[mid] && !used.has(mid)){ sched[p.id]=mid; used.add(mid); } });
  // 2. requests
  avail.forEach(m=>{ const p=posts.find(x=>x.id===w.avail[m.id]['req'+svc]); if(p && !sched[p.id] && !used.has(m.id) && fits(m,p)) put(p,m); });
  // 3. qualification-only posts (Med), then armed-only posts
  posts.filter(p=>p.requiresMed&&!sched[p.id]).forEach(p=>{ const m=best(p); if(m) put(p,m); });
  posts.filter(p=>needsArmed(p,svc)&&!sched[p.id]).forEach(p=>{ const m=best(p); if(m) put(p,m); });
  // 4. armed minimums per zone
  const R=rules()[svc];
  ['inside','outside'].forEach(z=>{
    const zp=posts.filter(p=>p.zone===z && !p.requiresMed);
    let have=zp.filter(p=>byId[sched[p.id]] && byId[sched[p.id]].armed).length;
    while(have<(R[z]||0)){
      let pick=null;
      zp.filter(p=>!sched[p.id]).forEach(p=>{ const m=best(p,x=>x.armed); if(m){ const s=score(m,p); if(!pick||s<pick.s) pick={p,m,s}; } });
      if(!pick) break;
      put(pick.p,pick.m); have++;
    }
  });
  // 5. fill the rest by rotation
  posts.filter(p=>!sched[p.id]).forEach(p=>{ const m=best(p); if(m) put(p,m); });
  return sched;
}

function generateAll(){
  if(!guard()) return;
  const w=editableWeek();
  const stats=historyStats(S.date);
  w.sched.AM=genService('AM',w,stats,{});
  const am={}; Object.values(w.sched.AM).forEach(m=>{ if(m) am[m]=1; });
  w.sched.PM=genService('PM',w,stats,am);
  w.generatedAt=Date.now();
  touchWeek(); S.mode='sched'; render();
  const issues=SVCS.reduce((n,s)=>n+checkService(s,w).length,0);
  toast(issues ? 'Schedule generated. Review the warnings.' : 'Schedule generated.');
}

function checkService(svc, w){
  const posts=postsFor(svc), sched=(w.sched&&w.sched[svc])||{}, byId=memberMap(), out=[];
  if(!posts.length) return out;
  const empty=posts.filter(p=>!byId[sched[p.id]]);
  if(empty.length) out.push(empty.length+' unfilled: '+empty.map(label).join(', '));
  const R=rules()[svc];
  ['inside','outside'].forEach(z=>{
    const min=R[z]||0; if(!min) return;
    const n=posts.filter(p=>p.zone===z && !p.requiresMed && byId[sched[p.id]] && byId[sched[p.id]].armed).length;
    if(n<min) out.push('Needs '+min+' armed '+z+'; '+n+' assigned');
  });
  posts.forEach(p=>{ const m=byId[sched[p.id]]; if(!m) return;
    if(needsArmed(p,svc)&&!m.armed) out.push(label(p)+' needs an armed member');
    if(p.requiresMed&&!m.med) out.push(label(p)+' requires a Med-qualified member');
  });
  return out;
}

function svcText(svc, w, withDuties){
  const posts=postsFor(svc); if(!posts.length) return '';
  const byId=memberMap(), sched=(w.sched&&w.sched[svc])||{};
  const lines=[(svc==='AM'?'Morning':'PM')+' Assignments'];
  posts.forEach(p=>{
    if(withDuties && lines.length>1) lines.push('');
    lines.push(label(p)+'  '+((byId[sched[p.id]]&&byId[sched[p.id]].name)||'—'));
    if(!withDuties) return;
    let d = svc==='PM' ? (p.dutiesPM||'') : (p.duties||'');
    if(svc==='PM' && !d) d = (p.services||[]).includes('AM') && p.duties ? 'Same duties as morning.' : (p.duties||'');
    if(d) lines.push(d.trim().replace(/\s*\n\s*/g,' '));
  });
  if(withDuties) lines.push('');
  const used=new Set(Object.values(sched));
  const off=S.members.filter(m=>m.active!==false && w.avail&&w.avail[m.id]&&w.avail[m.id][svc] && !used.has(m.id));
  const md=medicName(w,svc); if(md){ if(withDuties) lines.push(''); lines.push('Medical  '+md); }
  if(off.length) lines.push('OFF  '+off.map(m=>m.name).join(', '));
  return lines.join('\n');
}
function weekText(w, withDuties){
  let t=SVCS.map(s=>svcText(s,w,withDuties)).filter(Boolean).join('\n\n');
  const notes=S.settings&&S.settings.notes;
  if(withDuties && notes) t+='\n\n'+notes.trim();
  return t;
}

/* ---------- shareable map image ---------- */
const IMG_COL={bg:'#FFFFFF',room:'#F3F5F2',wall:'#56655C',sec:'#DDE4DE',secLine:'#BFC9C1',door:'#7D5210',mk:'#2B5C4C',mkEmpty:'#9E3B18',ink:'#17211C',muted:'#4A5850',chip:'#E1E7E2',rule:'#D5DDD7'};
function wrapText(t,max){ const words=String(t).split(/\s+/).filter(Boolean), out=[]; let line='';
  words.forEach(w=>{ if((line+' '+w).trim().length>max && line){ out.push(line); line=w; } else line=(line?line+' ':'')+w; }); if(line) out.push(line); return out; }
function mapImageSvg(w){
  const withD=false;
  const L=layout(), mm=memberMap(), F='Helvetica, Arial, sans-serif';
  const DEF={'1':[76,154],'2':[144,156],'3':[236,156],'4':[304,154],'5':[140,257],'6':[240,257]};
  const order=['room','stage','section','fixture','door'];
  const shapes=[...L.shapes].sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind));
  const drawShapes=shapes.map(sh=>{
    const pts=ptsStr(sh);
    if(sh.kind==='door') return `<polyline points="${pts}" fill="none" stroke="${IMG_COL.door}" stroke-width="4" stroke-linecap="round"/>`;
    const st = sh.kind==='room' ? `fill="${IMG_COL.room}" stroke="${IMG_COL.wall}" stroke-width="1.5"`
      : sh.kind==='fixture' ? `fill="none" stroke="${IMG_COL.wall}" stroke-width="1"`
      : `fill="${IMG_COL.sec}" stroke="${IMG_COL.secLine}" stroke-width="${sh.kind==='stage'?1:.5}"`;
    const c=centroid(sh);
    const lbl=(sh.label&&(sh.kind==='stage'||sh.kind==='section'))?`<text x="${c[0].toFixed(0)}" y="${(c[1]+3.5).toFixed(0)}" text-anchor="middle" font-family="${F}" font-size="10" font-weight="700" letter-spacing="2" fill="${IMG_COL.muted}">${esc(String(sh.label).toUpperCase())}</text>`:'';
    return `<polygon points="${pts}" ${st}/>${lbl}`;
  }).join('');
  const svcs=SVCS.filter(sv=>postsFor(sv).length && Object.values((w.sched&&w.sched[sv])||{}).some(Boolean));
  let y=0, out='';
  const T=(x,yy,txt,size,weight,fill,anchor)=>`<text x="${x}" y="${yy}" font-family="${F}" font-size="${size}" font-weight="${weight||400}" fill="${fill||IMG_COL.ink}"${anchor?` text-anchor="${anchor}"`:''}>${esc(txt)}</text>`;
  y+=26; out+=T(16,y,'Security posts · '+fmtDate(w.date||S.date),16,700); y+=8;
  svcs.forEach(svc=>{
    const sched=(w.sched&&w.sched[svc])||{}, posts=postsFor(svc);
    y+=24; out+=`<rect x="0" y="${y-17}" width="${VB.w}" height="24" fill="${IMG_COL.chip}"/>`+T(16,y,SVC_NAME[svc]+' service ('+svc+')',14,700);
    y+=8;
    const seats=posts.filter(p=>p.seat);
    if(seats.length){
      const mk=seats.map(p=>{ const d=DEF[p.code]||[190,160]; const x=p.x??d[0], yy=p.y??d[1]; const m=mm[sched[p.id]];
        return `<g transform="translate(${x} ${yy})"><circle r="13" fill="${m?IMG_COL.mk:IMG_COL.mkEmpty}" stroke="#FFFFFF" stroke-width="2"/><text text-anchor="middle" y="4.5" font-family="${F}" font-size="12" font-weight="700" fill="#FFFFFF">${esc(p.code)}</text><text text-anchor="middle" y="28" font-family="${F}" font-size="11" font-weight="700" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3.5" stroke-linejoin="round">${esc(m?m.name:'Open')}</text><text text-anchor="middle" y="28" font-family="${F}" font-size="11" font-weight="700" fill="${IMG_COL.ink}">${esc(m?m.name:'Open')}</text></g>`; }).join('');
      let maxY=0; L.shapes.forEach(sh=>sh.pts.forEach(q=>{ if(q[1]>maxY) maxY=q[1]; })); seats.forEach(p=>{ const d=DEF[p.code]||[190,160]; const yy=(p.y??d[1])+32; if(yy>maxY) maxY=yy; });
      out+=`<g transform="translate(0 ${y})">${drawShapes}${mk}</g>`; y+=Math.min(VB.h,maxY+6);
    }
    const sameAsAM = svc==='PM' && posts.every(p=>!p.dutiesPM && (p.services||[]).includes('AM'));
    if(withD && sameAsAM){ y+=16; out+=T(16,y,'Duties are the same as the morning service.',11,400,IMG_COL.muted); }
    posts.forEach(p=>{
      const m=mm[sched[p.id]];
      y+=10; out+=`<line x1="16" y1="${y}" x2="${VB.w-16}" y2="${y}" stroke="${IMG_COL.rule}" stroke-width="0.5"/>`;
      y+=18;
      out+=`<rect x="16" y="${y-13}" width="34" height="18" rx="4" fill="${IMG_COL.chip}"/>`+T(33,y,label(p),11,700,IMG_COL.ink,'middle')+T(58,y,m?m.name:'Open',13,700,m?IMG_COL.ink:IMG_COL.mkEmpty);
      if(withD && !sameAsAM){
        const d = svc==='PM' ? (p.dutiesPM || ((p.services||[]).includes('AM')?'':p.duties)) : p.duties;
        if(d) wrapText(d.replace(/\s*\n\s*/g,' '),56).forEach(ln=>{ y+=14; out+=T(58,y,ln,10.5,400,IMG_COL.muted); });
      }
    });
    const md=medicName(w,svc);
    if(md){ y+=10; out+=`<line x1="16" y1="${y}" x2="${VB.w-16}" y2="${y}" stroke="${IMG_COL.rule}" stroke-width="0.5"/>`; y+=18; out+=`<rect x="16" y="${y-13}" width="34" height="18" rx="4" fill="${IMG_COL.chip}"/>`+T(33,y,'Med',11,700,IMG_COL.ink,'middle')+T(58,y,md,13,700); }
    const used=new Set(Object.values(sched));
    const off=S.members.filter(mb=>mb.active!==false && w.avail&&w.avail[mb.id]&&w.avail[mb.id][svc] && !used.has(mb.id));
    if(off.length){ y+=10; out+=`<line x1="16" y1="${y}" x2="${VB.w-16}" y2="${y}" stroke="${IMG_COL.rule}" stroke-width="0.5"/>`; y+=18; out+=`<rect x="16" y="${y-13}" width="34" height="18" rx="4" fill="${IMG_COL.chip}"/>`+T(33,y,'OFF',11,700,IMG_COL.ink,'middle'); wrapText(off.map(mb=>mb.name).join(', '),48).forEach((ln,k)=>{ if(k) y+=15; out+=T(58,y,ln,12,400); }); }
    y+=12;
  });
  const notes=S.settings&&S.settings.notes;
  if(withD && notes){ y+=8; out+=`<line x1="16" y1="${y}" x2="${VB.w-16}" y2="${y}" stroke="${IMG_COL.wall}" stroke-width="1"/>`; wrapText(notes.replace(/\s*\n\s*/g,' '),58).forEach(ln=>{ y+=16; out+=T(16,y,ln,11,700); }); y+=6; }
  y+=16;
  const SC=3;
  return {svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w*SC}" height="${Math.ceil(y)*SC}" viewBox="0 0 ${VB.w} ${Math.ceil(y)}"><rect width="${VB.w}" height="${Math.ceil(y)}" fill="${IMG_COL.bg}"/>${out}</svg>`, count:svcs.length};
}
function dutiesImageSvg(){
  const F='Helvetica, Arial, sans-serif';
  const T=(x,yy,txt,size,weight,fill,anchor)=>`<text x="${x}" y="${yy}" font-family="${F}" font-size="${size}" font-weight="${weight||400}" fill="${fill||IMG_COL.ink}"${anchor?` text-anchor="${anchor}"`:''}>${esc(txt)}</text>`;
  const posts=S.posts.filter(p=>(p.services||[]).length);
  if(!posts.length) return null;
  let y=26, out=T(16,y,'Security post duties',16,700);
  const notes=S.settings&&S.settings.notes;
  if(notes){ wrapText(notes.replace(/\s*\n\s*/g,' '),58).forEach(ln=>{ y+=16; out+=T(16,y,ln,11,700,IMG_COL.muted); }); }
  y+=4;
  posts.forEach(p=>{
    y+=10; out+=`<line x1="16" y1="${y}" x2="${VB.w-16}" y2="${y}" stroke="${IMG_COL.rule}" stroke-width="0.5"/>`;
    y+=18;
    const sv=(p.services||[]).join(' + ');
    out+=`<rect x="16" y="${y-13}" width="34" height="18" rx="4" fill="${IMG_COL.chip}"/>`+T(33,y,label(p),11,700,IMG_COL.ink,'middle')+T(58,y,p.name||p.code,13,700)+T(VB.w-16,y,sv,10,400,IMG_COL.muted,'end');
    const lines=[];
    if(p.duties) lines.push(...wrapText(p.duties.replace(/\s*\n\s*/g,' '),56));
    if(p.dutiesPM) lines.push(...wrapText('Evening: '+p.dutiesPM.replace(/\s*\n\s*/g,' '),56));
    if(!lines.length) lines.push('No duties written yet.');
    lines.forEach(ln=>{ y+=14; out+=T(58,y,ln,10.5,400,IMG_COL.muted); });
  });
  y+=20;
  const SC=3, H=Math.ceil(y);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VB.w*SC}" height="${H*SC}" viewBox="0 0 ${VB.w} ${H}"><rect width="${VB.w}" height="${H}" fill="${IMG_COL.bg}"/>${out}</svg>`;
}
function svgToPng(svg){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    const img=new Image();
    img.onload=()=>{ const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; const x=c.getContext('2d'); x.drawImage(img,0,0); URL.revokeObjectURL(url); c.toBlob(b=>b?res(b):rej(new Error('png')),'image/png'); };
    img.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error('img')); };
    img.src=url;
  });
}
async function saveImage(kind){
  const w=week();
  let svg, name, title, alt;
  if(kind==='duties'){ svg=dutiesImageSvg(); if(!svg){ toast('Add posts first.'); return; } name='security-duties.png'; title='Duties image'; alt='Duties for each security post'; }
  else { const r=mapImageSvg(w); if(!r.count){ toast('Generate the schedule first.'); return; } svg=r.svg; name='security-schedule-'+(w.date||S.date)+'.png'; title='Schedule image'; alt='This week’s security schedule with maps'; }
  let blob; try{ blob=await svgToPng(svg); }catch{ toast('Couldn’t create the image.'); return; }
  const file=new File([blob],name,{type:'image/png'});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file]}); return; }catch(e){ if(e&&e.name==='AbortError') return; }
  }
  const url=URL.createObjectURL(blob);
  openSheet(title, `<img src="${url}" alt="${alt}" style="width:100%;border-radius:8px;border:1px solid var(--line)"><a class="btn primary block" href="${url}" download="${name}">Download image</a><p class="hint">On a phone you can also press and hold the image to save or share it.</p>`);
}

async function copyText(text, preId){
  try{ await navigator.clipboard.writeText(text); toast('Copied. Paste it into the group chat.'); }
  catch{ const el=preId&&document.getElementById(preId); if(el){ const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); } toast('Text selected. Use your phone’s Copy.'); }
}

/* ---------- who edited ---------- */
function edited(ts,by){ if(!ts) return ''; const d=new Date(ts).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); const n=typeof by==='string'&&by.includes('@')?by.split('@')[0]:''; return 'Edited '+d+(n?' · '+esc(n):''); }

/* ---------- render ---------- */
function emptyBox(h,p,btn,act,v){ return `<div class="empty"><h3>${esc(h)}</h3><p>${esc(p)}</p>${btn?`<button class="btn primary" data-act="${act}" data-v="${v||''}">${esc(btn)}</button>`:''}</div>`; }

function render(){
  if(S.dragging){ S.pendingRender=true; return; }
  S.pendingRender=false;
  document.querySelectorAll('#tabs button').forEach(b=>{ if(b.dataset.v===S.tab) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  const v=$('#view');
  if(S.noDb){ v.innerHTML=emptyBox('Couldn’t load the roster','Check your connection and reload the page.'); return; }
  if(!S.loaded.members||!S.loaded.posts||!S.loaded.weeks){ v.innerHTML='<p class="muted">Loading roster…</p>'; return; }
  ({sunday:viewSunday, roster:viewRoster, posts:viewPosts, history:viewHistory})[S.tab](v);
  if((S.tab==='sunday' && S.mode==='sched') || S.tab==='posts') bindMap();
  document.querySelectorAll('select[id^="med-sel-"]').forEach(ms=>{ ms.onchange=()=>{ if(!guard()) return; const sv=ms.dataset.svc; const w=editableWeek(); w.med=w.med||{}; if(ms.value) w.med[sv]=ms.value; else delete w.med[sv]; touchWeek(); render(); }; });
}

/* ---------- availability link ---------- */
const SITE_URL = (import.meta.env.VITE_SITE_URL || (location.hostname.endsWith('.vercel.app') ? 'https://church-security-dun.vercel.app' : location.origin)).replace(/\/+$/,'');
function linkUrl(token){ return SITE_URL+'/?a='+encodeURIComponent(token); }
function loadLink(date){
  if(!S.links || S.linkState[date]!==undefined) return;
  S.linkState[date]='loading';
  S.links.get(date).then(t=>{ S.linkState[date]=t||null; render(); }).catch(()=>{ S.linkState[date]=null; render(); });
}
function weeklyMessage(date, token){
  return `Who's available for security on ${fmtDate(date,{weekday:'long',month:'short',day:'numeric'})}? Tap your name and pick AM, PM, both, or out:\n${linkUrl(token)}`;
}
function linkCardHtml(w, active){
  loadLink(S.date);
  const st=S.linkState[S.date];
  const replied=active.filter(m=>w.avail&&w.avail[m.id]&&w.avail[m.id].answeredAt).length;
  if(st===undefined||st==='loading') return `<div class="linkbar"><span class="muted small">Checking for this week’s link…</span></div>`;
  if(!st) return `<div class="linkbar"><div><strong>Group chat link</strong><div class="small muted">People tap their name and pick AM / PM.</div></div><button class="btn primary" data-act="mklink">Create link</button></div>`;
  return `<div class="linkbar"><div><strong>Group chat link</strong><div class="small muted">${replied} replied by link</div></div><button class="btn primary" data-act="cpmsg">Copy message</button></div>
    <pre class="text" id="link-msg" hidden>${esc(weeklyMessage(S.date, st))}</pre>`;
}

function answerOf(a){
  if(!a) return null;
  if(!(a.answeredAt||a.manualAt||a.AM||a.PM)) return null;
  return a.AM&&a.PM?'both':a.AM?'AM':a.PM?'PM':'out';
}
function viewSunday(v){
  const w=week();
  const active=S.members.filter(m=>m.active!==false);
  const datebar=`<div class="datebar">
    <button class="icon-btn" data-act="date" data-v="-7" aria-label="Previous Sunday">‹</button>
    <div class="d"><strong>${esc(fmtDate(S.date))}</strong>${S.date===defaultSunday()?'<span class="small muted">This Sunday</span>':`<button class="req-btn" data-act="today">Go to this Sunday</button>`}</div>
    <button class="icon-btn" data-act="date" data-v="7" aria-label="Next Sunday">›</button></div>`;
  if(!active.length){ v.innerHTML=datebar+emptyBox('No team members yet','Add your team in Roster, then mark who’s available here.','Go to Roster','tab','roster'); return; }
  if(!S.posts.length){ v.innerHTML=datebar+emptyBox('No posts set up yet','Add your posts and duties in Posts first.','Go to Posts','tab','posts'); return; }

  const answered=active.filter(m=>answerOf(w.avail&&w.avail[m.id])).length;
  const generated=SVCS.some(sv=>Object.values((w.sched&&w.sched[sv])||{}).some(Boolean));
  const issues=generated?SVCS.reduce((n,sv)=>n+checkService(sv,w).length,0):0;
  const cnt=sv=>{ const a=active.filter(m=>w.avail&&w.avail[m.id]&&w.avail[m.id][sv]); return `${a.length} avail · ${a.filter(m=>m.armed).length} armed`; };
  const statusPill = !generated ? '<span class="pill">Not generated</span>' : issues ? `<span class="pill warn">${issues} to fix</span>` : '<span class="pill ok">Schedule ready</span>';
  const status=`<div class="status"><div class="status-top"><span><strong>${answered}</strong> of ${active.length} answered</span>${statusPill}</div>
    <div class="status-sub">AM ${cnt('AM')}<span class="sep">|</span>PM ${cnt('PM')}</div></div>`;
  const steps=`<div class="steps" role="group" aria-label="Step">
    <button data-act="mode" data-v="avail" aria-pressed="${S.mode==='avail'}"><span class="num">1</span>Availability</button>
    <button data-act="mode" data-v="sched" aria-pressed="${S.mode==='sched'}"><span class="num">2</span>Schedule &amp; share</button></div>`;

  let body='';
  if(S.mode==='avail'){
    const byId={}; S.posts.forEach(p=>byId[p.id]=p);
    const row=m=>{
      const a=(w.avail&&w.avail[m.id])||{};
      const ans=answerOf(a);
      const reqs=SVCS.filter(sv=>a['req'+sv]&&byId[a['req'+sv]]).map(sv=>sv+' '+byId[a['req'+sv]].code);
      const opt=(k,t)=>`<button data-act="av4" data-m="${m.id}" data-v="${k}" aria-pressed="${ans===k}" aria-label="${esc(m.name)}: ${t}">${t}</button>`;
      return `<li class="arow"><button class="aname" data-act="req" data-m="${m.id}"><span class="name">${esc(m.name)}</span>${m.armed?'<span class="dot" title="Armed" aria-label="Armed"></span>':''}
          ${(reqs.length||qualText(m))?`<span class="asub">${esc([reqs.length?'Asked for '+reqs.join(', '):'', QUALS.filter(([k])=>m[k]).map(q=>q[2]).join(' · ')].filter(Boolean).join(' · '))}</span>`:''}</button>
        <div class="seg4" role="group" aria-label="${esc(m.name)} availability">${opt('out','Out')}${opt('AM','AM')}${opt('PM','PM')}${opt('both','Both')}</div></li>`;
    };
    const waiting=active.filter(m=>!answerOf(w.avail&&w.avail[m.id])), done=active.filter(m=>answerOf(w.avail&&w.avail[m.id]));
    body=`${showAvailLink()?linkCardHtml(w,active):''}
      ${waiting.length?`<div class="grp-head"><span>Waiting on ${waiting.length}</span></div><ul class="list">${waiting.map(row).join('')}</ul>`:''}
      ${done.length?`<div class="grp-head"><span>Answered ${done.length}</span></div><ul class="list">${done.map(row).join('')}</ul>`:''}
      <p class="hint">Tap a name to request a specific post. Tap a highlighted choice again to clear it. <span class="dot inline"></span> = armed.</p>
      ${medHtml(w)}
      <button class="btn primary block big" data-act="gen">${generated?'Regenerate schedule':'Generate schedule'}</button>`;
  } else {
    const svc=S.svc, posts=postsFor(svc), mm=memberMap(), sched=(w.sched&&w.sched[svc])||{}, locks=(w.locks&&w.locks[svc])||{};
    const warns=checkService(svc,w);
    const any=Object.values(sched).some(Boolean);
    const svcSeg=`<div class="seg" role="group" aria-label="Service">${SVCS.map(sv=>`<button data-act="svc" data-v="${sv}" aria-pressed="${svc===sv}">${SVC_NAME[sv]}</button>`).join('')}</div>`;
    if(!generated){
      body=`${svcSeg}${emptyBox('No schedule yet','Mark who’s available, then generate. Locked posts and requests are kept.','Generate schedule','gen','')}`;
    } else {
      const warnHtml = warns.length ? `<ul class="warns">${warns.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : `<div class="okline">All posts filled. Armed coverage met.</div>`;
      const prow=p=>{ const m=mm[sched[p.id]];
        return `<li><button class="prow" data-act="assign" data-p="${p.id}"><span class="code">${esc(p.code)}</span><span class="pname${m?'':' open'}">${m?esc(m.name):'Open'}</span>${m&&m.armed?'<span class="dot" aria-label="Armed"></span>':''}${locks[p.id]&&m?'<span class="lock" aria-label="Locked">Locked</span>':''}<span class="pwhere">${esc(p.name||'')}</span></button></li>`; };
      const used=new Set(Object.values(sched));
      const off=active.filter(m=>w.avail&&w.avail[m.id]&&w.avail[m.id][svc]&&!used.has(m.id));
      const md=medicName(w,svc);
      body=`${svcSeg}
        ${warnHtml}
        <ul class="list">${posts.map(prow).join('')}
          ${md?`<li><div class="prow static"><span class="code">Med</span><span class="pname">${esc(md)}</span><span class="pwhere">Medical</span></div></li>`:''}
          ${off.length?`<li><div class="prow static"><span class="code">OFF</span><span class="pname muted" style="font-weight:400">${esc(off.map(m=>m.name).join(', '))}</span></div></li>`:''}</ul>
        <p class="hint">Tap a post to swap or lock someone. <span class="dot inline"></span> = armed.</p>
        <button class="btn block" data-act="showmap">${S.showMap?'Hide map':'Show map'}</button>
        ${S.showMap?mapHtml(svc,sched):''}
        <details class="more"><summary>More options</summary>
          <div class="more-in">
            <button class="btn block" data-act="gen">Regenerate both services</button>
            <label class="check"><input type="checkbox" id="wd-tog" ${S.withDuties?'checked':''}> Include duties in copied text</label>
            <button class="btn block" data-act="copy">Copy schedule as text</button>
            <pre class="text" id="out-text">${esc(weekText(w,S.withDuties))}</pre>
          </div></details>
        <div class="sharebar"><div class="sharebar-in"><button class="btn primary" data-act="mapimg">Share schedule</button><button class="btn" data-act="dutiesimg">Share duties</button></div></div>`;
    }
  }
  v.innerHTML=installCardHtml()+datebar+status+steps+body;
}

const VB={w:380,h:334}, AX=190;
const DEFAULT_LAYOUT={v:2,shapes:[
  {id:'room',kind:'room',mirror:'self',pts:[[30,70],[125,40],[255,40],[350,70],[282,298],[98,298]]},
  {id:'stage',kind:'stage',label:'Stage',mirror:'self',pts:[[125,40],[255,40],[255,74],[190,94],[125,74]]},
  {id:'piano',kind:'fixture',label:'Piano',pts:[[224,46],[244,46],[244,59],[224,59]]},
  {id:'pulpit',kind:'fixture',label:'Pulpit',mirror:'self',pts:[[184,78],[196,78],[196,86],[184,86]]},
  {id:'s1',kind:'section',mirror:'s4',pts:[[42,100],[100,104],[92,208],[74,208]]},
  {id:'s4',kind:'section',mirror:'s1',pts:[[338,100],[280,104],[288,208],[306,208]]},
  {id:'s2',kind:'section',mirror:'s3',pts:[[110,104],[182,102],[182,210],[102,212]]},
  {id:'s3',kind:'section',mirror:'s2',pts:[[270,104],[198,102],[198,210],[278,212]]},
  {id:'s5',kind:'section',mirror:'s6',pts:[[86,226],[182,224],[182,288],[104,290]]},
  {id:'s6',kind:'section',mirror:'s5',pts:[[294,226],[198,224],[198,288],[276,290]]},
  {id:'booth',kind:'fixture',label:'Sound booth',pts:[[248,274],[272,274],[272,286],[248,286]]},
  {id:'d1',kind:'door',label:'Left door',mirror:'d2',pts:[[72,211],[76,224]]},
  {id:'d2',kind:'door',label:'Right door',mirror:'d1',pts:[[308,211],[304,224]]},
  {id:'d3',kind:'door',label:'Front right door',pts:[[347,78],[343,92]]},
  {id:'d4',kind:'door',label:'Rear door',mirror:'self',pts:[[181,298],[199,298]]}]};
const KIND_NAME={room:'Room walls',stage:'Stage',section:'Seating section',fixture:'Object',door:'Door'};
const localL=new WeakSet();
function layout(){ const L=S.layout; return (L&&L.v===2&&Array.isArray(L.shapes))?L:DEFAULT_LAYOUT; }
function editableLayout(){ let L=S.layout; if(!L||!localL.has(L)||L.v!==2){ L=JSON.parse(JSON.stringify(layout())); localL.add(L); S.layout=L; } return L; }
function selShape(){ const L=editableLayout(); return L.shapes.find(x=>x.id===S.selSec); }
let lTimer=null, lSeq=0, lSaved=0, lChain=Promise.resolve();
function layoutDirty(){ return lSaved<lSeq; }
function touchLayout(){ lSeq++; clearTimeout(lTimer); lTimer=setTimeout(flushLayout,300); }
function flushLayout(){
  clearTimeout(lTimer);
  if(lSaved>=lSeq||!S.db||!S.layout) return lChain;
  const seq=lSeq, L=S.layout;
  const body=JSON.parse(JSON.stringify({v:2, shapes:L.shapes, updatedAt:Date.now(), updatedBy:S.me||null}));
  lChain=lChain.then(async()=>{ try{ await withRetry(()=>S.db.doc('settings/map').set(body)); }catch(e){ toast(errMsg(e)); } lSaved=Math.max(lSaved,seq); });
  return lChain;
}
const clampX=x=>Math.round(Math.min(VB.w-4,Math.max(4,x))), clampY=y=>Math.round(Math.min(VB.h-4,Math.max(4,y)));
const ptsStr=s=>s.pts.map(p=>p[0]+','+p[1]).join(' ');
function mirShape(L,s){ if(!S.mirror||!s||!s.mirror) return null; if(s.mirror==='self') return s; return L.shapes.find(x=>x.id===s.mirror)||null; }
function nearestIdx(pts,x,y){ let bi=-1,bd=1e12; pts.forEach((p,i)=>{ const d=(p[0]-x)**2+(p[1]-y)**2; if(d<bd){bd=d;bi=i;} }); return bi; }
function mirrorVertex(L,s,i){ const m=mirShape(L,s); if(!m) return null; const p=s.pts[i]; return {m, i:nearestIdx(m.pts,2*AX-p[0],p[1])}; }
function centroid(s){ const n=s.pts.length; return [s.pts.reduce((a,p)=>a+p[0],0)/n, s.pts.reduce((a,p)=>a+p[1],0)/n]; }

function shapeSvg(s,twinId){
  const sel=S.editMap&&S.selSec===s.id?' sel':(S.editMap&&twinId===s.id?' twin':'');
  if(s.kind==='door') return `<g class="shp door${sel}" data-sid="${esc(s.id)}"><polyline points="${ptsStr(s)}" class="door-l"/><polyline points="${ptsStr(s)}" class="hit"/></g>`;
  const k=KIND_NAME[s.kind]?s.kind:'section';
  const c=centroid(s);
  const lbl=(s.label&&(k==='stage'||k==='section'))?`<text class="sl" x="${c[0].toFixed(0)}" y="${c[1].toFixed(0)}" text-anchor="middle" dominant-baseline="central">${esc(String(s.label).toUpperCase())}</text>`:'';
  return `<g class="shp ${k}${sel}" data-sid="${esc(s.id)}"><polygon points="${ptsStr(s)}"/>${lbl}</g>`;
}
function handlesSvg(s){
  let h=''; const n=s.pts.length, closed=s.kind!=='door';
  const edges=closed?n:n-1;
  for(let i=0;i<edges;i++){ const a=s.pts[i], b=s.pts[(i+1)%n]; if(Math.hypot(a[0]-b[0],a[1]-b[1])<22) continue;
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2; h+=`<g class="hd-m" data-i="${i}"><circle class="hz" cx="${mx}" cy="${my}" r="10"/><circle class="mid" cx="${mx}" cy="${my}" r="4"/></g>`; }
  s.pts.forEach((p,i)=>{ h+=`<g class="hd-v" data-i="${i}"><circle class="hz" cx="${p[0]}" cy="${p[1]}" r="14"/><circle class="vx${S.selPt===i?' on':''}" cx="${p[0]}" cy="${p[1]}" r="6"/></g>`; });
  return `<g id="handles">${h}</g>`;
}

function medHtml(w){
  if(!S.medics.length) return `<div class="card"><strong>Medical</strong><p class="hint">No medical team yet. Add them under Roster, then pick who’s on medical here.</p></div>`;
  const sel=svc=>{ const cur=(w.med&&w.med[svc])||''; const act=S.medics.filter(m=>m.active!==false||m.id===cur);
    return `<label class="field"><span>${SVC_NAME[svc]} (${svc})</span><select id="med-sel-${svc}" data-svc="${svc}" ${S.canWrite?'':'disabled'}><option value="">— Not set —</option>${act.map(m=>`<option value="${m.id}" ${m.id===cur?'selected':''}>${esc(m.name)}</option>`).join('')}</select></label>`; };
  return `<div class="card"><strong>Medical on duty</strong><div class="grid2">${SVCS.map(sel).join('')}</div></div>`;
}
function mapHtml(svc, sched, withNames=true){
  const seats=postsFor(svc).filter(p=>p.seat);
  if(!seats.length) return '';
  const mm=memberMap(), L=layout();
  const DEF={'1':[76,154],'2':[144,156],'3':[236,156],'4':[304,154],'5':[140,257],'6':[240,257]};
  const mk=seats.map(p=>{ const d=DEF[p.code]||[190,160]; const x=p.x??d[0], y=p.y??d[1]; const m=mm[sched[p.id]];
    const nm=m?m.name:'Unfilled'; const short=nm.length>12?nm.slice(0,11)+'…':nm;
    const cls=withNames?(m?'':' empty-mk'):' plain';
    return `<g class="mk${cls}" data-act="${S.editMap||!withNames?'':'assign'}" data-p="${p.id}" data-pid="${p.id}" transform="translate(${x} ${y})"><circle r="13"></circle><text class="c" text-anchor="middle" dy="4">${esc(p.code)}</text>${withNames?`<text class="n" text-anchor="middle" y="27">${esc(short)}</text>`:''}</g>`; }).join('');
  const sel=S.editMap&&L.shapes.find(x=>x.id===S.selSec);
  const twin=sel&&S.mirror&&sel.mirror&&sel.mirror!=='self'?sel.mirror:null;
  const order=['room','stage','section','fixture','door'];
  const shapes=[...L.shapes].sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind));
  let tools='';
  if(S.editMap){
    const minPts=sel&&sel.kind==='door'?2:3;
    tools=`<div class="map-tools">
      ${chk('mir-tog','Mirror edits left ↔ right',S.mirror)}
      ${sel?`<div class="small"><strong>${esc(sel.label||KIND_NAME[sel.kind]||'Shape')}</strong> <span class="muted">· ${sel.pts.length} corners${twin?' · mirrored':''}${sel.mirror==='self'&&S.mirror?' · symmetric':''}</span></div>
        <p class="hint">Drag a dot to move a corner. Drag a small ring to add a corner. Drag the shape to move it.</p>
        <div class="actions">${S.selPt!=null&&sel.pts.length>minPts?'<button class="btn" data-act="ptdel">Delete corner</button>':''}<button class="btn" data-act="secname">Label</button>${sel.kind!=='room'?'<button class="btn" data-act="secdup">Duplicate</button><button class="btn danger" data-act="secdel" data-confirm="Tap again">Delete</button>':''}<button class="btn" data-act="secdesel">Deselect</button></div>`
      :'<p class="hint">Tap the walls, stage, a section or a door to edit its corners. Drag a numbered marker to move a post.</p>'}
      <div class="actions"><button class="btn" data-act="secadd" data-v="section">Add section</button><button class="btn" data-act="secadd" data-v="door">Add door</button><button class="btn" data-act="secadd" data-v="fixture">Add object</button></div>
      <button class="btn danger" data-act="layoutreset" data-confirm="Tap again to reset">Reset layout</button>
    </div>`;
  }
  return `<div class="map${S.editMap?' editing':''}">
    <svg id="map" viewBox="0 0 ${VB.w} ${VB.h}" role="img" aria-label="Sanctuary seat posts">
      ${shapes.map(x=>shapeSvg(x,twin)).join('')}
      ${mk}
      ${sel?handlesSvg(sel):''}
    </svg>
    <div class="sec-head" style="padding:4px 4px 0"><span class="small muted">${S.editMap?'Changes save automatically.':'Seat posts · same map for AM and PM'}</span>${S.canWrite?`<button class="req-btn" data-act="editmap">${S.editMap?'Done':'Edit layout'}</button>`:''}</div>
    ${tools}
  </div>`;
}

function insertMid(L,s,i){
  const n=s.pts.length, a=s.pts[i], b=s.pts[(i+1)%n];
  const P=[Math.round((a[0]+b[0])/2),Math.round((a[1]+b[1])/2)], MP=[2*AX-P[0],P[1]];
  const m=mirShape(L,s); let mj=-1;
  if(m){ const mn=m.pts.length, edges=m.kind==='door'?mn-1:mn; let bd=1e12;
    for(let j=0;j<edges;j++){ const c=m.pts[j], d=m.pts[(j+1)%mn]; const q=[(c[0]+d[0])/2,(c[1]+d[1])/2]; const dd=(q[0]-MP[0])**2+(q[1]-MP[1])**2; if(dd<bd){bd=dd;mj=j;} } }
  if(m===s){
    if(mj===i){ s.pts.splice(i+1,0,[AX,P[1]]); return {i:i+1,mi:{m:s,i:i+1}}; }
    if(mj<i){ s.pts.splice(mj+1,0,MP); s.pts.splice(i+2,0,P); return {i:i+2,mi:{m:s,i:mj+1}}; }
    s.pts.splice(i+1,0,P); s.pts.splice(mj+2,0,MP); return {i:i+1,mi:{m:s,i:mj+2}};
  }
  s.pts.splice(i+1,0,P);
  if(m&&mj>=0){ m.pts.splice(mj+1,0,MP); return {i:i+1,mi:{m,i:mj+1}}; }
  return {i:i+1,mi:null};
}

function bindMap(){
  const wd=document.getElementById('wd-tog'); if(wd) wd.onchange=()=>{ S.withDuties=wd.checked; render(); };
  const svg=document.getElementById('map'); if(!svg) return;
  const tog=document.getElementById('mir-tog'); if(tog) tog.onchange=()=>{ S.mirror=tog.checked; render(); };
  if(!S.editMap) return;
  let drag=null;
  const pt=e=>{ const p=svg.createSVGPoint(); p.x=e.clientX; p.y=e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  const cap=e=>{ try{ svg.setPointerCapture(e.pointerId); }catch{} };
  const upd=sh=>{ if(!sh) return; const g=svg.querySelector('[data-sid="'+sh.id+'"]'); if(g) g.querySelectorAll('polygon,polyline').forEach(el=>el.setAttribute('points',ptsStr(sh))); };
  svg.addEventListener('pointerdown',e=>{
    if(!S.canWrite) return;
    const p=pt(e);
    const hv=e.target.closest('.hd-v'), hm=e.target.closest('.hd-m');
    if(hv||hm){
      e.preventDefault(); const L=editableLayout(), s=L.shapes.find(x=>x.id===S.selSec); if(!s) return;
      let i, mi;
      if(hm){ const r=insertMid(L,s,Number(hm.dataset.i)); i=r.i; mi=r.mi; }
      else { i=Number(hv.dataset.i); mi=mirrorVertex(L,s,i); }
      S.selPt=i; drag={type:'vx',s,i,mi,moved:!!hm,hv}; S.dragging=true; cap(e);
      const hg=document.getElementById('handles'); if(hg&&hm) hg.style.opacity='0';
      upd(s); if(mi) upd(mi.m); return;
    }
    const mk=e.target.closest('.mk');
    if(mk){ e.preventDefault(); drag={type:'mk',g:mk,pid:mk.dataset.pid}; S.dragging=true; cap(e); return; }
    const sg=e.target.closest('.shp');
    if(sg){
      e.preventDefault(); const L=editableLayout(), s=L.shapes.find(x=>x.id===sg.dataset.sid); if(!s) return;
      if(S.selSec!==s.id){ S.selSec=s.id; S.selPt=null; }
      const m=mirShape(L,s);
      drag={type:'move',s,m,start:[p.x,p.y],orig:s.pts.map(q=>[...q]),morig:m&&m!==s?m.pts.map(q=>[...q]):null,moved:false};
      S.dragging=true; cap(e); return;
    }
    if(S.selSec){ S.selSec=null; S.selPt=null; render(); }
  });
  svg.addEventListener('pointermove',e=>{
    if(!drag) return; const p=pt(e);
    if(drag.type==='mk'){ drag.x=clampX(p.x); drag.y=clampY(p.y); drag.g.setAttribute('transform',`translate(${drag.x} ${drag.y})`); return; }
    drag.moved=true;
    if(drag.type==='vx'){
      const s=drag.s, x=clampX(p.x), y=clampY(p.y);
      const onAxis=drag.mi&&drag.mi.m===s&&drag.mi.i===drag.i;
      s.pts[drag.i]=[onAxis?AX:x,y];
      if(drag.mi&&!onAxis) drag.mi.m.pts[drag.mi.i]=[2*AX-x,y];
      upd(s); if(drag.mi&&drag.mi.m!==s) upd(drag.mi.m);
      if(drag.hv) drag.hv.querySelectorAll('circle').forEach(c=>{ c.setAttribute('cx',s.pts[drag.i][0]); c.setAttribute('cy',y); });
      return;
    }
    const s=drag.s, m=drag.m; let dx=p.x-drag.start[0]; const dy=p.y-drag.start[1];
    if(m===s) dx=0;
    s.pts=drag.orig.map(q=>[clampX(q[0]+dx),clampY(q[1]+dy)]); upd(s);
    if(drag.morig){ m.pts=drag.morig.map(q=>[clampX(q[0]-dx),clampY(q[1]+dy)]); upd(m); }
    const hg=document.getElementById('handles'); if(hg) hg.style.opacity='0';
  });
  const end=()=>{
    if(!drag) return; const d=drag; drag=null; S.dragging=false;
    if(d.type==='mk'){ if(d.x!=null) write(()=>S.db.doc('posts/'+d.pid).update({x:d.x,y:d.y})); }
    else if(d.moved) touchLayout();
    render();
  };
  svg.addEventListener('pointerup',end); svg.addEventListener('pointercancel',end);
}

function openSectionLabelSheet(){
  const L=editableLayout(), s=L.shapes.find(x=>x.id===S.selSec); if(!s) return;
  const kinds=s.kind==='room'||s.kind==='door'?'':`<label class="field"><span>Type</span><select id="sl-k">${['section','stage','fixture'].map(k=>`<option value="${k}" ${s.kind===k?'selected':''}>${KIND_NAME[k]}</option>`).join('')}</select></label>`;
  openSheet('Label', `<label class="field"><span>Label (optional)</span><input type="text" id="sl-l" value="${esc(s.label||'')}" placeholder="e.g. Overflow, Choir, Piano" autocomplete="off"></label>${kinds}
    <p class="hint">Labels show on the map for the stage and seating sections.</p>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="sl-save">Save</button></div>`,
  body=>{ body.querySelector('#sl-save').onclick=()=>{ s.label=body.querySelector('#sl-l').value.trim(); const k=body.querySelector('#sl-k'); if(k) s.kind=k.value; touchLayout(); closeSheet(); render(); }; });
}

function viewRoster(v){
  const act=S.members.filter(m=>m.active!==false), ina=S.members.filter(m=>m.active===false);
  const row=m=>`<li><button class="row tap${m.active===false?' dim':''}" data-act="member" data-v="${m.id}"><span class="main"><span class="name">${esc(m.name)}</span><span class="tags">${personTags(m)}${qualTags(m)}${m.active===false?'<span class="tag">Inactive</span>':''}</span></span><span class="muted" aria-hidden="true">›</span></button></li>`;
  const armed=act.filter(m=>m.armed).length;
  v.innerHTML=`<div class="sec-head"><h2 class="sec">Team · ${act.length}</h2>${S.canWrite?'<button class="btn primary" data-act="member" data-v="">Add member</button>':''}</div>
    <div class="stats"><div class="stat"><div class="k">Armed</div><div class="v">${armed} of ${act.length}</div></div><div class="stat"><div class="k">Medical team</div><div class="v">${S.medics.filter(m=>m.active!==false).length}</div></div></div>
    <div class="stats">${QUALS.map(([k,full])=>`<div class="stat"><div class="k">${full}</div><div class="v">${act.filter(m=>m[k]).length} of ${act.length}</div></div>`).join('')}</div>
    ${S.members.length?`<ul class="list">${act.map(row).join('')}${ina.map(row).join('')}</ul>`:emptyBox('No team members yet','Add each person on the security team and mark who carries.','Add member','member','')}
    <div class="sec-head"><h2 class="sec">Medical team · ${S.medics.filter(m=>m.active!==false).length}</h2>${S.canWrite?'<button class="btn" data-act="medic" data-v="">Add</button>':''}</div>
    ${S.medics.length?`<ul class="list">${S.medics.map(m=>`<li><button class="row tap${m.active===false?' dim':''}" data-act="medic" data-v="${m.id}"><span class="main"><span class="name">${esc(m.name)}</span>${m.active===false?'<span class="tags"><span class="tag">Inactive</span></span>':''}</span><span class="muted" aria-hidden="true">›</span></button></li>`).join('')}</ul>`:'<p class="hint">Medical is its own team. Add them here, then pick who’s on medical each Sunday.</p>'}
    <p class="hint">Armed status shows only inside this app. It’s never in the copied schedule. Inactive members stay in history but aren’t scheduled.</p>
    ${accessHtml()}`;
}

function viewPosts(v){
  const R=rules(), st=S.settings||{};
  const group=svc=>{ const ps=postsFor(svc); return `<div class="sec-head"><h2 class="sec">${SVC_NAME[svc]} posts · ${ps.length}</h2></div>${ps.length?`<ul class="list">${ps.map(p=>`<li><button class="row tap" data-act="post" data-v="${p.id}"><span class="code">${esc(label(p))}</span><span class="main"><span class="name">${esc(p.name||p.code)}</span><span class="tags"><span class="tag">${esc(p.zone||'inside')}</span>${needsArmed(p,svc)?'<span class="tag armed">Armed</span>':''}</span><div class="sub">${p.updatedAt?edited(p.updatedAt,p.updatedBy):(p.duties?'':'No duties written yet')}</div></span><span class="muted" aria-hidden="true">›</span></button></li>`).join('')}</ul>`:`<p class="hint">No ${SVC_NAME[svc].toLowerCase()} posts yet.</p>`}`; };
  v.innerHTML=`<div class="sec-head"><h2 class="sec">Posts & duties</h2>${S.canWrite?'<button class="btn primary" data-act="post" data-v="">Add post</button>':''}</div>
    <div class="card"><div class="sec-head"><strong>Armed coverage</strong>${S.canWrite?'<button class="req-btn" data-act="rules">Edit</button>':''}</div>
      <div class="small">${SVCS.map(sv=>{ const ap=postsFor(sv).filter(p=>needsArmed(p,sv)).map(label); const r=R[sv]; const mins=[r.inside?r.inside+' inside':'',r.outside?r.outside+' outside':''].filter(Boolean).join(', ');
        return `<strong>${SVC_NAME[sv]}:</strong> ${ap.length?'armed at '+esc(ap.join(', ')):'no armed posts set'}${mins?` · at least ${mins}`:''}`; }).join('<br>')}</div></div>
    <div class="card"><div class="sec-head"><strong>Team-wide notes</strong>${S.canWrite?'<button class="req-btn" data-act="notes">Edit</button>':''}</div>
      ${st.notes?`<p class="duties">${esc(st.notes)}</p>`:'<p class="hint">Nothing yet. Add notes that apply to every post.</p>'}${st.updatedAt?`<span class="small muted">${edited(st.updatedAt,st.updatedBy)}</span>`:''}</div>
    <div class="sec-head"><h2 class="sec">Sanctuary map</h2></div>
    ${mapHtml('AM',{},false)}
    ${group('AM')}${group('PM')}`;
}

function viewHistory(v){
  const today=defaultSunday();
  const weeks=Object.values(S.weeks).filter(w=>w.sched&&SVCS.some(s=>Object.values(w.sched[s]||{}).some(Boolean))).sort((a,b)=>b.date.localeCompare(a.date));
  const recent=weeks.filter(w=>w.date<=today).slice(0,8);
  const counts={}; recent.forEach(w=>SVCS.forEach(s=>Object.values(w.sched[s]||{}).forEach(m=>{ if(m) counts[m]=(counts[m]||0)+1; })));
  const act=S.members.filter(m=>m.active!==false).sort((a,b)=>(counts[b.id]||0)-(counts[a.id]||0));
  const max=Math.max(1,...act.map(m=>counts[m.id]||0));
  v.innerHTML=`<div class="sec-head"><h2 class="sec">History</h2><div class="actions"><button class="btn" data-act="export">Export backup</button>${S.role==='admin'?'<button class="btn" data-act="import">Import</button>':''}</div></div>
    ${recent.length?`<div class="card"><strong>Services worked · last ${recent.length} Sunday${recent.length>1?'s':''}</strong><div class="bars">${act.map(m=>`<div class="bar"><span class="nm">${esc(m.name)}</span><span class="t"><i style="width:${((counts[m.id]||0)/max*100).toFixed(0)}%"></i></span><span class="ct">${counts[m.id]||0}</span></div>`).join('')}</div></div>`:''}
    ${weeks.length?weeks.map(w=>`<details class="week"><summary><span>${esc(fmtDate(w.date,{weekday:'short',month:'short',day:'numeric',year:'numeric'}))}</span><span class="muted small">${SVCS.map(s=>Object.values(w.sched[s]||{}).filter(Boolean).length).join(' / ')} filled</span></summary><div class="in"><pre class="text">${esc(weekText(w))}</pre><div class="actions"><button class="btn" data-act="openweek" data-v="${w.date}">Open this week</button>${S.canWrite?`<button class="btn danger" data-act="delweek" data-v="${w.date}" data-confirm="Tap again to delete">Delete week</button>`:''}</div></div></details>`).join(''):emptyBox('No schedules yet','Generated schedules appear here. They also drive the rotation so the same people don’t get the same posts every week.')}`;
}

/* ---------- sheets ---------- */
function openSheet(title, html, mount){ $('#sheet-title').textContent=title; $('#sheet-body').innerHTML=html; $('#sheet').hidden=false; if(mount) mount($('#sheet-body')); const f=$('#sheet-body').querySelector('input[type=text],select,textarea'); if(f && matchMedia('(pointer:fine)').matches) f.focus(); }
function closeSheet(){ $('#sheet').hidden=true; $('#sheet-body').innerHTML=''; }
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && !$('#sheet').hidden) closeSheet(); });
function chk(id,lbl,on){ return `<label class="check"><input type="checkbox" id="${id}" ${on?'checked':''}> ${esc(lbl)}</label>`; }
function armConfirm(el, fn){ if(el.dataset.armed==='1'){ fn(); return; } el.dataset.armed='1'; const old=el.textContent; el.textContent=el.dataset.confirm||'Tap again to confirm'; setTimeout(()=>{ if(el.isConnected){ el.dataset.armed=''; el.textContent=old; } },3000); }

function openAssignSheet(pid){
  const p=S.posts.find(x=>x.id===pid); if(!p) return;
  const svc=S.svc, w=week(), sched=(w.sched&&w.sched[svc])||{}, locks=(w.locks&&w.locks[svc])||{};
  const act=S.members.filter(m=>m.active!==false);
  const av=act.filter(m=>w.avail&&w.avail[m.id]&&w.avail[m.id][svc]), na=act.filter(m=>!(w.avail&&w.avail[m.id]&&w.avail[m.id][svc]));
  const where={}; Object.entries(sched).forEach(([k,m])=>{ if(m){ const pp=S.posts.find(x=>x.id===k); if(pp) where[m]=label(pp); } });
  const opt=m=>`<option value="${m.id}" ${sched[pid]===m.id?'selected':''}>${esc(m.name)}${m.armed?' · armed':''}${qualText(m)?' · '+esc(qualText(m)):''}${where[m.id]&&sched[pid]!==m.id?' (now '+esc(where[m.id])+')':''}</option>`;
  const duties=(svc==='PM'&&p.dutiesPM)?p.dutiesPM:p.duties;
  const notes=S.settings&&S.settings.notes;
  openSheet(label(p)+' · '+SVC_NAME[svc], `
    ${p.name?`<div class="small muted">${esc(p.name)} · ${esc(p.zone||'inside')}${needsArmed(p,svc)?' · armed post':''}</div>`:''}
    ${duties?`<p class="duties">${esc(duties)}</p>`:'<p class="hint">No duties written for this post yet.</p>'}
    ${notes?`<p class="duties small muted">${esc(notes)}</p>`:''}
    ${S.canWrite?`<label class="field"><span>Person</span><select id="as-m"><option value="">— Unfilled —</option><optgroup label="Available">${av.map(opt).join('')}</optgroup>${na.length?`<optgroup label="Not marked available">${na.map(opt).join('')}</optgroup>`:''}</select></label>
    ${chk('as-lock','Lock this assignment (keep it when regenerating)',!!locks[pid])}
    <p class="hint">Picking someone already on another post swaps them.</p>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="as-save">Save</button></div>`:''}`,
  body=>{ const b=body.querySelector('#as-save'); if(!b) return; b.onclick=()=>{
    const mid=body.querySelector('#as-m').value, lock=body.querySelector('#as-lock').checked;
    const w=editableWeek(), s=w.sched[svc], L=w.locks[svc], prev=s[pid];
    if(mid){ const other=Object.keys(s).find(k=>k!==pid&&s[k]===mid); if(other){ if(prev) s[other]=prev; else delete s[other]; } s[pid]=mid; w.avail[mid]=w.avail[mid]||{}; w.avail[mid][svc]=true; }
    else delete s[pid];
    if(lock&&mid) L[pid]=true; else delete L[pid];
    touchWeek(); closeSheet(); render(); toast('Saved.');
  }; });
}

function openRequestSheet(mid){
  const m=S.members.find(x=>x.id===mid); if(!m||!guard()) return;
  const a=(week().avail||{})[mid]||{};
  const sel=svc=>`<label class="field"><span>${SVC_NAME[svc]} request</span><select id="rq-${svc}"><option value="">No request</option>${postsFor(svc).map(p=>`<option value="${p.id}" ${a['req'+svc]===p.id?'selected':''}>${esc(label(p))} ${esc(p.name||'')}</option>`).join('')}</select></label>`;
  openSheet(m.name, `<p class="hint">The generator fills requests first, as long as they don’t break armed coverage.</p>${sel('AM')}${sel('PM')}
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="rq-save">Save</button></div>`,
  body=>{ body.querySelector('#rq-save').onclick=()=>{ const w=editableWeek(); w.avail[mid]=w.avail[mid]||{};
    SVCS.forEach(s=>{ const v=body.querySelector('#rq-'+s).value; if(v){ w.avail[mid]['req'+s]=v; w.avail[mid][s]=true; } else delete w.avail[mid]['req'+s]; });
    touchWeek(); closeSheet(); render(); }; });
}

function openMemberSheet(id){
  if(!guard()) return;
  const m=S.members.find(x=>x.id===id)||{name:'',armed:false,med:false,active:true};
  openSheet(id?'Edit member':'Add member', `
    <label class="field"><span>Name as it appears on the schedule</span><input type="text" id="mb-name" value="${esc(m.name)}" placeholder="e.g. David, G." autocomplete="off"></label>
    <div class="checks">${chk('mb-armed','Armed (carries)',m.armed)}${QUALS.map(([k,full])=>chk('mb-'+k,full,m[k])).join('')}${chk('mb-active','Active on the team',m.active!==false)}</div>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="mb-save">Save</button></div>
    ${id?'<button class="btn danger block" id="mb-del" data-confirm="Tap again to delete">Delete member</button><p class="hint">Deleting removes them from future schedules. To keep their history, mark them inactive instead.</p>':''}`,
  body=>{
    body.querySelector('#mb-save').onclick=async()=>{
      const name=body.querySelector('#mb-name').value.trim(); if(!name){ toast('Enter a name.'); return; }
      const data={name, armed:body.querySelector('#mb-armed').checked, active:body.querySelector('#mb-active').checked, updatedAt:Date.now()};
      QUALS.forEach(([k])=>{ data[k]=body.querySelector('#mb-'+k).checked; });
      const ok=await write(()=>id?S.db.doc('members/'+id).set(data):S.db.collection('members').add(data));
      if(ok){ closeSheet(); toast(id?'Saved.':'Added '+name+'.'); }
    };
    const d=body.querySelector('#mb-del'); if(d) d.onclick=()=>armConfirm(d,async()=>{ if(await write(()=>S.db.doc('members/'+id).delete())){ closeSheet(); toast('Deleted.'); } });
  });
}

function openMedicSheet(id){
  if(!guard()) return;
  const m=S.medics.find(x=>x.id===id)||{name:'',active:true};
  openSheet(id?'Edit medical member':'Add medical member', `
    <label class="field"><span>Name</span><input type="text" id="md-name" value="${esc(m.name)}" autocomplete="off"></label>
    <div class="checks">${chk('md-active','Active',m.active!==false)}</div>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="md-save">Save</button></div>
    ${id?'<button class="btn danger block" id="md-del" data-confirm="Tap again to delete">Delete</button>':''}`,
  body=>{
    body.querySelector('#md-save').onclick=async()=>{ const name=body.querySelector('#md-name').value.trim(); if(!name){ toast('Enter a name.'); return; }
      const data={name, active:body.querySelector('#md-active').checked, updatedAt:Date.now()};
      if(await write(()=>id?S.db.doc('medics/'+id).set(data):S.db.collection('medics').add(data))){ closeSheet(); toast('Saved.'); } };
    const d=body.querySelector('#md-del'); if(d) d.onclick=()=>armConfirm(d,async()=>{ if(await write(()=>S.db.doc('medics/'+id).delete())){ closeSheet(); toast('Deleted.'); } });
  });
}
function openPostSheet(id){
  if(!guard()) return;
  const p=S.posts.find(x=>x.id===id)||{code:'',name:'',services:['AM'],zone:'inside',seat:false,requiresArmed:false,requiresMed:false,duties:'',dutiesPM:'',order:(S.posts.length?Math.max(...S.posts.map(x=>x.order||0))+1:1)};
  const sv=p.services||[];
  openSheet(id?'Edit post · '+p.code:'Add post', `
    <div class="grid2"><label class="field"><span>Code</span><input type="text" id="ps-code" value="${esc(p.code)}" placeholder="e.g. DSK" autocomplete="off"></label>
    <label class="field"><span>List order</span><input type="number" id="ps-order" value="${esc(p.order??'')}" inputmode="numeric"></label></div>
    <label class="field"><span>Name</span><input type="text" id="ps-name" value="${esc(p.name)}" placeholder="e.g. Desk / cameras" autocomplete="off"></label>
    <div class="grid2"><div class="field"><span>Services</span><div class="checks">${chk('ps-am','Morning (AM)',sv.includes('AM'))}${chk('ps-pm','Evening (PM)',sv.includes('PM'))}</div></div>
    <label class="field"><span>Counts as</span><select id="ps-zone"><option value="inside" ${p.zone!=='outside'?'selected':''}>Inside</option><option value="outside" ${p.zone==='outside'?'selected':''}>Outside</option></select></label></div>
    <div class="checks">${chk('ps-seat','Seat post (show on sanctuary map)',p.seat)}</div>
    <label class="field"><span>Duties</span><textarea id="ps-duties">${esc(p.duties||'')}</textarea></label>
    <label class="field"><span>Evening duties (optional)</span><textarea id="ps-dutiespm" placeholder="Leave blank to use the duties above">${esc(p.dutiesPM||'')}</textarea></label>
    ${p.updatedAt?`<span class="small muted">${edited(p.updatedAt,p.updatedBy)}</span>`:''}
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="ps-save">Save</button></div>
    ${id?'<button class="btn danger block" id="ps-del" data-confirm="Tap again to delete">Delete post</button>':''}`,
  body=>{
    body.querySelector('#ps-save').onclick=async()=>{
      const q=s=>body.querySelector(s);
      const code=q('#ps-code').value.trim(); if(!code){ toast('Enter a code.'); return; }
      const services=[]; if(q('#ps-am').checked) services.push('AM'); if(q('#ps-pm').checked) services.push('PM');
      const data={code, name:q('#ps-name').value.trim(), services, zone:q('#ps-zone').value, seat:q('#ps-seat').checked,
        requiresArmed:false, requiresMed:false, armedIn:SVCS.filter(sv=>services.includes(sv)&&needsArmed(p,sv)), order:Number(q('#ps-order').value)||0,
        duties:q('#ps-duties').value, dutiesPM:q('#ps-dutiespm').value, updatedAt:Date.now(), updatedBy:S.me||null};
      if(p.x!=null){ data.x=p.x; data.y=p.y; }
      const ok=await write(()=>id?S.db.doc('posts/'+id).set(data):S.db.collection('posts').add(data));
      if(ok){ closeSheet(); toast('Saved.'); }
    };
    const d=body.querySelector('#ps-del'); if(d) d.onclick=()=>armConfirm(d,async()=>{ if(await write(()=>S.db.doc('posts/'+id).delete())){ closeSheet(); toast('Deleted.'); } });
  });
}

function openNotesSheet(){
  if(!guard()) return;
  openSheet('Team-wide notes', `<label class="field"><span>Shown with every post’s duties</span><textarea id="nt">${esc((S.settings&&S.settings.notes)||'')}</textarea></label>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="nt-save">Save</button></div>`,
  body=>{ body.querySelector('#nt-save').onclick=async()=>{ const data={...(S.settings||{}), notes:body.querySelector('#nt').value, updatedAt:Date.now(), updatedBy:S.me||null};
    if(await write(()=>S.db.doc('settings/team').set(JSON.parse(JSON.stringify(data))))){ closeSheet(); toast('Saved.'); } }; });
}

function openRulesSheet(){
  if(!guard()) return;
  const R=rules(); const n=(id,v)=>`<input type="number" id="${id}" min="0" max="10" value="${v}" inputmode="numeric">`;
  const list=sv=>{ const ps=postsFor(sv); if(!ps.length) return '<p class="hint">No posts for this service.</p>';
    return `<div class="checks">${ps.map(p=>chk('ap-'+sv+'-'+p.id,label(p)+(p.name?' · '+p.name:''),needsArmed(p,sv))).join('')}</div>`; };
  openSheet('Armed coverage', `
    <div class="field"><span>Morning · posts that must be armed</span>${list('AM')}</div>
    <div class="field"><span>Evening · posts that must be armed</span>${list('PM')}</div>
    <p class="hint">Optional: a minimum number of armed people inside and outside, on top of the posts above. Set to 0 to rely only on the selected posts.</p>
    <div class="grid2"><label class="field"><span>Morning · inside</span>${n('r-ai',R.AM.inside)}</label><label class="field"><span>Morning · outside</span>${n('r-ao',R.AM.outside)}</label>
    <label class="field"><span>Evening · inside</span>${n('r-pi',R.PM.inside)}</label><label class="field"><span>Evening · outside</span>${n('r-po',R.PM.outside)}</label></div>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="r-save">Save</button></div>`,
  body=>{ body.querySelector('#r-save').onclick=async()=>{
    const g=id=>Math.max(0,Number(body.querySelector(id).value)||0);
    const changes=[];
    S.posts.forEach(p=>{
      const want=SVCS.filter(sv=>{ const el=body.querySelector('#ap-'+sv+'-'+p.id); return el?el.checked:false; });
      const have=SVCS.filter(sv=>(p.services||[]).includes(sv)&&needsArmed(p,sv));
      if(want.join()!==have.join() || !Array.isArray(p.armedIn)) changes.push([p.id,want]);
    });
    for(const [id,want] of changes){ const ok=await write(()=>S.db.doc('posts/'+id).update({armedIn:want, requiresArmed:false})); if(!ok) return; }
    const data={...(S.settings||{}), rules:{AM:{inside:g('#r-ai'),outside:g('#r-ao')},PM:{inside:g('#r-pi'),outside:g('#r-po')}}, updatedAt:Date.now(), updatedBy:S.me||null};
    if(await write(()=>S.db.doc('settings/team').set(JSON.parse(JSON.stringify(data))))){ closeSheet(); toast('Saved.'); } }; });
}

function downloadFile(name, text, type){
  const url=URL.createObjectURL(new Blob([text],{type}));
  const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
async function doExport(){
  await flushWeek(); await flushLayout();
  const data=JSON.stringify({format:'security-scheduler-v1', exportedAt:new Date().toISOString(), docs:S.db.dump()}, null, 2);
  const name='security-backup-'+ymd(new Date())+'.json';
  const file=new File([data],name,{type:'application/json'});
  if(navigator.canShare && navigator.canShare({files:[file]})){ try{ await navigator.share({files:[file]}); return; }catch(e){ if(e&&e.name==='AbortError') return; } }
  downloadFile(name,data,'application/json'); toast('Backup downloaded.');
}
function openImportSheet(){
  if(S.role!=='admin'){ toast('Only admins can import.'); return; }
  openSheet('Import backup', `<p class="hint">Pick a backup file (.json). Matching records are replaced; nothing else is deleted.</p>
    <input type="file" id="im-file" accept="application/json,.json">
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="im-go">Import</button></div>`,
  body=>{ body.querySelector('#im-go').onclick=async()=>{
    const f=body.querySelector('#im-file').files[0]; if(!f){ toast('Choose a file first.'); return; }
    let obj; try{ obj=JSON.parse(await f.text()); }catch{ toast('That file isn’t a valid backup.'); return; }
    const docs=Array.isArray(obj.docs)?obj.docs.filter(d=>d&&typeof d.path==='string'&&d.path.split('/').length===2&&d.data&&typeof d.data==='object'):null;
    if(!docs||!docs.length){ toast('No records found in that file.'); return; }
    try{ await S.db.importDocs(docs); closeSheet(); toast('Imported '+docs.length+' records.'); }catch(e){ toast(errMsg(e)); }
  }; });
}

/* ---------- app access ---------- */
async function loadAccess(){
  if(!S.access) return;
  try{ S.accessList=await S.access.list(); }catch{ S.accessList=[]; }
  if(S.role==='admin'&&S.invites){ try{ S.inviteList=await S.invites.list(); }catch{ S.inviteList=[]; } }
  render();
}
const fmtCode=c=>c.slice(0,4)+'-'+c.slice(4);
function inviteMessage(code){
  const site=(typeof SITE_URL!=='undefined'?SITE_URL:location.origin);
  return `You're invited to the Sunday Security app.\n1. Open ${site}\n2. Tap "First time? Create your password"\n3. Enter invite code ${fmtCode(code)}, your email, and a password.\nThe code works once and expires in 7 days.`;
}
function invitesHtml(){
  if(S.role!=='admin'||!S.invites) return '';
  const now=Date.now();
  const list=(S.inviteList||[]).filter(i=>i.used_at||new Date(i.expires_at).getTime()>now).slice(0,8);
  const row=i=>{
    const used=!!i.used_at;
    return `<li class="row"><span class="code" style="min-width:auto;padding:0 8px">${esc(fmtCode(i.code))}</span><span class="main"><span class="sub" style="overflow-wrap:anywhere">${used?'Used by '+esc(i.used_by||''):'Unused · '+esc(i.role==='admin'?'Admin':'Editor')+' · expires '+esc(new Date(i.expires_at).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</span></span>${used?'':`<button class="req-btn" data-act="invshow" data-v="${esc(i.code)}">Share</button><button class="req-btn" style="color:var(--warn)" data-act="invdel" data-v="${esc(i.code)}" data-confirm="Tap again">Cancel</button>`}</li>`;
  };
  return `<div class="sec-head"><h2 class="sec">Invite codes</h2><button class="btn" data-act="invadd">New code</button></div>
    ${list.length?`<ul class="list">${list.map(row).join('')}</ul>`:''}
    <p class="hint">Text someone a one-time code instead of adding their email. The first person to use it gets access. Unused codes expire after 7 days.</p>`;
}
function openInviteSheet(code){
  const msg=inviteMessage(code);
  openSheet('Invite code', `<div style="font-family:var(--f-mono);font-size:32px;font-weight:600;letter-spacing:.08em;text-align:center">${esc(fmtCode(code))}</div>
    <pre class="text" id="inv-msg">${esc(msg)}</pre>
    <button class="btn primary block" id="inv-copy">Copy message</button>
    <p class="hint">Works once. After someone uses it, it can’t be used again.</p>`,
  body=>{ body.querySelector('#inv-copy').onclick=()=>copyText(msg,'inv-msg'); });
}
function openNewInviteSheet(){
  openSheet('New invite code', `<label class="field"><span>Role for whoever uses it</span><select id="inv-role"><option value="editor">Editor — can change schedules and everything else</option><option value="admin">Admin — can also manage access</option></select></label>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="inv-go">Create code</button></div>`,
  body=>{ body.querySelector('#inv-go').onclick=async()=>{
    try{ const code=await S.invites.create(body.querySelector('#inv-role').value); openInviteSheet(code); loadAccess(); }catch{ toast('Couldn’t create a code. Try again.'); }
  }; });
}
function accessHtml(){
  const isAdmin=S.role==='admin';
  const list=S.accessList;
  const rows=!list?'<p class="hint">Loading…</p>':`<ul class="list">${list.map(a=>`<li class="row"><span class="main"><span class="name" style="overflow-wrap:anywhere">${esc(a.email)}</span><span class="tags"><span class="tag">${esc(a.role==='admin'?'Admin':'Editor')}</span></span></span>${isAdmin&&a.email!==S.me?`<button class="req-btn" style="color:var(--warn)" data-act="accdel" data-v="${esc(a.email)}" data-confirm="Tap again">Remove</button>`:''}</li>`).join('')}</ul>`;
  return `<div class="sec-head"><h2 class="sec">App access</h2>${isAdmin?'<button class="btn" data-act="accadd">Add email</button>':''}</div>
    ${rows}
    ${invitesHtml()}
    <p class="hint">Only these emails can sign in and see the roster, including who is armed. Editors can change schedules; admins can also manage access.</p>
    <div class="card"><div class="sec-head"><strong>Group chat availability link</strong><span class="pill${showAvailLink()?' ok':''}">${showAvailLink()?'On':'Off'}</span></div>
      <p class="hint" style="margin:0">When on, the Sunday tab shows a “Copy message” button with a link. People tap their name and pick AM, PM, both, or out, with no sign-in. Their answers fill in automatically, and you can still mark people by hand.</p>
      ${S.canWrite?`<button class="btn" data-act="linktoggle">${showAvailLink()?'Turn off':'Turn on'}</button>`:''}</div>
    <button class="btn block" data-act="insthow">Install on your phone</button>
    <div class="sec-head"><span class="small muted" style="overflow-wrap:anywhere">Signed in as ${esc(S.me||'')}</span><button class="btn" data-act="signout">Sign out</button></div>`;
}
function openAccessSheet(){
  openSheet('Add email', `<label class="field"><span>Email</span><input type="text" id="ac-email" inputmode="email" autocomplete="off" autocapitalize="none" placeholder="name@example.com"></label>
    <label class="field"><span>Role</span><select id="ac-role"><option value="editor">Editor — can change schedules</option><option value="admin">Admin — can also manage access</option></select></label>
    <div class="actions"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="ac-save">Add</button></div>`,
  body=>{ body.querySelector('#ac-save').onclick=async()=>{
    const email=body.querySelector('#ac-email').value.trim().toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ toast('Enter a valid email.'); return; }
    try{ await S.access.add(email, body.querySelector('#ac-role').value); closeSheet(); toast('Added. They can sign in with that email.'); loadAccess(); }catch(e){ toast('Couldn’t add that email.'); }
  }; });
}

/* ---------- actions ---------- */
const ACTS={
  tab:el=>{ flushWeek(); flushLayout(); S.tab=el.dataset.v; S.editMap=false; S.selSec=null; if(S.tab==='roster') loadAccess(); render(); scrollTo(0,0); },
  date:el=>{ flushWeek(); S.date=shiftDate(S.date,Number(el.dataset.v)); render(); },
  today:()=>{ flushWeek(); S.date=defaultSunday(); render(); },
  openweek:el=>{ flushWeek(); S.date=el.dataset.v; S.tab='sunday'; S.mode='sched'; render(); scrollTo(0,0); },
  mode:el=>{ S.mode=el.dataset.v; S.editMap=false; render(); },
  svc:el=>{ S.svc=el.dataset.v; render(); },
  av4:el=>{ if(!guard()) return; const w=editableWeek(), m=el.dataset.m, k=el.dataset.v; const a=w.avail[m]=w.avail[m]||{};
    if(answerOf(a)===k){ delete w.avail[m]; touchWeek(); render(); toast('Cleared. Moved back to “Waiting on.”'); return; }
    a.AM=(k==='AM'||k==='both'); a.PM=(k==='PM'||k==='both'); a.manualAt=Date.now();
    SVCS.forEach(sv=>{ if(!a[sv]) delete a['req'+sv]; }); touchWeek(); render(); },
  showmap:()=>{ S.showMap=!S.showMap; S.editMap=false; render(); },
  av:el=>{ if(!guard()) return; const w=editableWeek(), m=el.dataset.m, s=el.dataset.s; w.avail[m]=w.avail[m]||{}; w.avail[m][s]=!w.avail[m][s]; if(!w.avail[m][s]) delete w.avail[m]['req'+s]; touchWeek(); render(); },
  allav:el=>{ if(!guard()) return; const w=editableWeek(), s=el.dataset.v; S.members.filter(m=>m.active!==false).forEach(m=>{ w.avail[m.id]=w.avail[m.id]||{}; w.avail[m.id][s]=true; }); touchWeek(); render(); },
  req:el=>openRequestSheet(el.dataset.m),
  gen:()=>generateAll(),
  assign:el=>openAssignSheet(el.dataset.p),
  copy:()=>copyText(weekText(week(),S.withDuties),'out-text'),
  mapimg:()=>saveImage('schedule'),
  dutiesimg:()=>saveImage('duties'),
  editmap:()=>{ S.editMap=!S.editMap; S.selSec=null; S.selPt=null; if(!S.editMap) flushLayout(); render(); },
  member:el=>openMemberSheet(el.dataset.v),
  medic:el=>openMedicSheet(el.dataset.v),
  post:el=>openPostSheet(el.dataset.v),
  notes:()=>openNotesSheet(),
  rules:()=>openRulesSheet(),
  export:()=>doExport(),
  mklink:async()=>{ if(!guard()||!S.links) return; try{ const t=await S.links.create(S.date); S.linkState[S.date]=t; render(); toast('Link created. Copy the message into the group chat.'); }catch{ toast('Couldn’t create the link. Try again.'); } },
  cpmsg:()=>{ const t=S.linkState[S.date]; if(t) copyText(weeklyMessage(S.date,t),'link-msg'); },
  cplink:()=>{ const t=S.linkState[S.date]; if(t) copyText(linkUrl(t),'link-msg'); },
  import:()=>openImportSheet(),
  accadd:()=>openAccessSheet(),
  insthow:()=>openInstallSheet(),
  linktoggle:async()=>{ if(!guard()) return; const on=!showAvailLink(); const data={...(S.settings||{}), availLink:on, updatedAt:Date.now(), updatedBy:S.me||null};
    if(await write(()=>S.db.doc('settings/team').set(JSON.parse(JSON.stringify(data))))) toast(on?'Group chat link turned on. Find it on the Sunday tab.':'Group chat link turned off.'); },
  instgo:async()=>{ const ev=deferredInstall; if(!ev){ openInstallSheet(); return; } deferredInstall=null; try{ ev.prompt(); const r=await ev.userChoice; if(r&&r.outcome==='accepted'){ try{ localStorage.setItem(INSTALL_KEY,'installed'); }catch{} toast('Installed. Open it from your home screen.'); } }catch{ openInstallSheet(); } render(); },
  instlater:()=>{ try{ localStorage.setItem(INSTALL_KEY,String(Date.now()+14*864e5)); }catch{} render(); toast('Hidden for two weeks. Steps are at the bottom of the Roster tab.'); },
  instdone:()=>{ try{ localStorage.setItem(INSTALL_KEY,'installed'); }catch{} closeSheet(); render(); toast('Great. Open it from your home screen from now on.'); },
  invadd:()=>openNewInviteSheet(),
  invshow:el=>openInviteSheet(el.dataset.v),
  invdel:el=>armConfirm(el,async()=>{ try{ await S.invites.revoke(el.dataset.v); toast('Code canceled.'); loadAccess(); }catch{ toast('Couldn’t cancel that code.'); } }),
  accdel:el=>armConfirm(el,async()=>{ try{ await S.access.remove(el.dataset.v); toast('Removed.'); loadAccess(); }catch{ toast('Couldn’t remove that email.'); } }),
  signout:()=>{ if(S.signOut) S.signOut(); },
  secadd:el=>{ const L=editableLayout(), k=el.dataset.v, id='s'+Date.now().toString(36);
    const base = k==='door'?[[130,160],[146,160]] : k==='fixture'?[[130,150],[150,150],[150,164],[130,164]] : [[120,140],[160,140],[160,180],[120,180]];
    const a={id,kind:k,pts:base};
    if(S.mirror){ const b={id:id+'m',kind:k,pts:base.map(q=>[2*AX-q[0],q[1]]),mirror:id}; a.mirror=b.id; L.shapes.push(a,b); } else L.shapes.push(a);
    S.selSec=id; S.selPt=null; touchLayout(); render(); },
  secdup:()=>{ const L=editableLayout(), s=selShape(); if(!s) return; const c={id:'s'+Date.now().toString(36),kind:s.kind,label:s.label||'',pts:s.pts.map(q=>[clampX(q[0]+14),clampY(q[1]+14)])}; L.shapes.push(c); S.selSec=c.id; S.selPt=null; touchLayout(); render(); },
  secdel:el=>armConfirm(el,()=>{ const L=editableLayout(), s=selShape(); if(!s) return; L.shapes=L.shapes.filter(x=>x.id!==s.id); L.shapes.forEach(x=>{ if(x.mirror===s.id) delete x.mirror; }); S.selSec=null; S.selPt=null; touchLayout(); render(); }),
  ptdel:()=>{ const L=editableLayout(), s=selShape(); if(!s||S.selPt==null) return; const min=s.kind==='door'?2:3; if(s.pts.length<=min) return;
    const mi=mirrorVertex(L,s,S.selPt);
    if(mi&&mi.m===s&&mi.i!==S.selPt&&s.pts.length-2>=min){ [S.selPt,mi.i].sort((a,b)=>b-a).forEach(i=>s.pts.splice(i,1)); }
    else { s.pts.splice(S.selPt,1); if(mi&&mi.m!==s&&mi.m.pts.length>min) mi.m.pts.splice(mi.i,1); }
    S.selPt=null; touchLayout(); render(); },
  secdesel:()=>{ S.selSec=null; S.selPt=null; render(); },
  secname:()=>openSectionLabelSheet(),
  layoutreset:el=>armConfirm(el,()=>{ const L=editableLayout(); L.shapes=JSON.parse(JSON.stringify(DEFAULT_LAYOUT.shapes)); S.selSec=null; S.selPt=null; touchLayout(); render(); toast('Layout reset.'); }),
  delweek:el=>armConfirm(el,async()=>{ const d=el.dataset.v; if(await write(()=>S.db.doc('weeks/'+d).delete())){ delete S.weeks[d]; render(); toast('Deleted.'); } }),
  close:()=>closeSheet()
};
document.addEventListener('click',e=>{ const el=e.target.closest('[data-act]'); if(!el||!el.dataset.act) return; const fn=ACTS[el.dataset.act]; if(fn){ e.preventDefault(); fn(el); } });
addEventListener('pagehide',()=>{ flushWeek(); flushLayout(); });
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden'){ flushWeek(); flushLayout(); } });

/* ---------- install on your phone ---------- */
const INSTALL_KEY='ss-install-v1';
let deferredInstall=null;
addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredInstall=e; if(S.db) render(); });
addEventListener('appinstalled',()=>{ deferredInstall=null; try{ localStorage.setItem(INSTALL_KEY,'installed'); }catch{} if(S.db) render(); });
function isStandalone(){ try{ return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true; }catch{ return false; } }
function phoneKind(){
  const ua=navigator.userAgent||'';
  const ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
  if(ios) return /CriOS|FxiOS|EdgiOS|GSA\/|FBAN|FBAV|Instagram|Line\//.test(ua)?'ios-other':'ios';
  if(/Android/.test(ua)) return 'android';
  return 'desktop';
}
function installHidden(){
  if(isStandalone()||phoneKind()==='desktop') return true;
  try{ const v=localStorage.getItem(INSTALL_KEY); if(v==='installed') return true; if(v&&Number(v)>Date.now()) return true; }catch{}
  return false;
}
const SHARE_ICON='<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Share" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5v10h14V11h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function installCardHtml(){
  if(installHidden()) return '';
  const k=phoneKind();
  const primary = k==='android'&&deferredInstall ? '<button class="btn primary" data-act="instgo">Install app</button>' : '<button class="btn primary" data-act="insthow">Show me how</button>';
  return `<div class="install-card"><div class="install-icon" aria-hidden="true"><img src="/icon-v2-192.png" alt="" width="40" height="40"></div>
    <div class="install-text"><strong>Put this app on your home screen</strong><span>Opens in one tap, full screen, like a regular app.</span></div>
    <div class="install-actions">${primary}<button class="req-btn" data-act="instlater">Not now</button></div></div>`;
}
function openInstallSheet(){
  const k=phoneKind();
  const site=(typeof SITE_URL!=='undefined'?SITE_URL:location.origin).replace(/^https?:\/\//,'');
  const iphone=`<div class="inst-steps"><h3>iPhone</h3><ol>
      ${k==='ios-other'?`<li>This page is open in another app’s browser. Open <strong>Safari</strong> and go to <strong>${esc(site)}</strong>.</li>`:'<li>Make sure this page is open in <strong>Safari</strong>.</li>'}
      <li>Tap the <strong>Share</strong> button ${SHARE_ICON} at the bottom of the screen (on iPad it’s at the top). If you don’t see it, tap the three dots <strong>⋯</strong> first, then <strong>Share</strong>.</li>
      <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
      <li>Tap <strong>Add</strong>. The shield icon appears on your home screen.</li></ol></div>`;
  const android=`<div class="inst-steps"><h3>Android</h3><ol>
      <li>Open this page in <strong>Chrome</strong>.</li>
      <li>Tap the <strong>⋮</strong> menu in the top right.</li>
      <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
      <li>Tap <strong>Install</strong>. The shield icon appears with your apps.</li></ol></div>`;
  const body = k==='android' ? android+iphone : k==='desktop' ? `<p class="hint">Open <strong>${esc(site)}</strong> on your phone, then:</p>`+iphone+android : iphone+android;
  openSheet('Install on your phone', `${body}
    <p class="hint">After that, open it from the home screen icon. On iPhone you’ll sign in once more the first time you open it there.</p>
    <div class="actions"><button class="btn" data-act="close">Close</button>${k!=='desktop'?'<button class="btn primary" data-act="instdone">I’ve installed it</button>':''}</div>`);
}

/* ---------- in-app tutorial ---------- */
const TOUR_KEY='ss-tour-done-v1';
const q1=sel=>document.querySelector(sel);
const TOUR=[
  {tab:'sunday', mode:'avail', target:null, title:'Welcome', text:'This quick tour shows how to build the Sunday security schedule. It takes about a minute. Tap Next to start.'},
  {tab:'sunday', mode:'avail', target:()=>q1('.datebar'), title:'Pick the Sunday', text:'Use the arrows to choose which Sunday you’re scheduling.'},
  {tab:'sunday', mode:'avail', target:()=>q1('.status'), title:'Quick status', text:'How many people have answered, how many are available and armed for each service, and whether the schedule is ready.'},
  {tab:'sunday', mode:'avail', target:()=>q1('.steps'), title:'Two steps', text:'Step 1 is availability. Step 2 is the schedule and sharing it.'},
  {tab:'sunday', mode:'avail', target:()=>q1('.arow .seg4'), title:'Mark availability', text:'After asking in the group chat, tap Out, AM, PM, or Both for each person. Anyone not marked stays at the top under “Waiting on.”'},
  {tab:'sunday', mode:'avail', target:()=>q1('.arow .aname'), title:'Requests', text:'Tap a name if that person asked for a specific post. A brown dot means they’re armed. Key, door app, gate app, and medical training show under the name.'},
  {tab:'sunday', mode:'avail', target:()=>{ const s=q1('select[id^="med-sel-"]'); return s?s.closest('.card'):null; }, title:'Medical', text:'Choose who’s on medical for the morning and evening. The medical team is managed on the Roster tab.'},
  {tab:'sunday', mode:'avail', target:()=>q1('button.big[data-act="gen"]'), title:'Generate', text:'When everyone’s marked, tap Generate. Armed posts are filled first, then everyone else rotates so people don’t get the same post every week.'},
  {tab:'sunday', mode:'sched', target:()=>q1('.list .prow')||q1('.steps button[data-v="sched"]'), title:'Check the schedule', text:'Step 2 shows each post and who’s on it. Switch Morning and Evening at the top. Tap any post to swap the person or lock them in place.'},
  {tab:'sunday', mode:'sched', target:()=>q1('.warns')||q1('.okline'), title:'Warnings', text:'Green means every post is filled and armed coverage is met. Anything that needs fixing shows here in red.'},
  {tab:'sunday', mode:'sched', target:()=>q1('.sharebar-in'), title:'Share it', text:'Share schedule makes one picture with both services for the group chat. Share duties sends what each post does.'},
  {tab:'roster', target:()=>q1('[data-act="tab"][data-v="roster"]'), title:'Roster', text:'Add people and tap a person to mark armed, church key, door app, gate app, or medical training. The medical team has its own list here too.'},
  {tab:'roster', admin:true, target:()=>{ const h=[...document.querySelectorAll('h2.sec')].find(x=>/App access/.test(x.textContent)); return h?h.closest('.sec-head'):null; }, title:'Who can sign in', text:'Admins add people here, by email or with a one-time invite code you text them.'},
  {tab:'posts', target:()=>q1('[data-act="tab"][data-v="posts"]'), title:'Posts and duties', text:'Edit what each post does and choose which posts must be armed. Changes show up in the duties picture right away.'},
  {tab:'history', target:()=>q1('[data-act="tab"][data-v="history"]'), title:'History', text:'Past schedules live here, and they drive the rotation. Use Export backup now and then to keep a copy.'},
  {tab:'sunday', mode:'avail', install:true, target:()=>q1('.install-card'), title:'Put it on your phone', text:'Tap “Show me how” to add this app to your home screen. You can also find the steps any time at the bottom of the Roster tab.'},
  {tab:'sunday', mode:'avail', target:()=>q1('#help-btn'), title:'That’s it', text:'Mark availability, generate, check it, and share. Tap ? any time to see this tour again.'},
];
let tour=null;
function tourSteps(){ return TOUR.filter(st=>(!st.admin||S.role==='admin')&&(!st.install||!installHidden())); }
function startTour(){
  if(tour) return;
  closeSheet(); flushWeek();
  tour={i:0, saved:{tab:S.tab, mode:S.mode, svc:S.svc, editMap:S.editMap}};
  const layer=document.createElement('div'); layer.className='tour-layer'; layer.id='tour-layer';
  layer.innerHTML=`<div class="tour-dim" id="td-t"></div><div class="tour-dim" id="td-b"></div><div class="tour-dim" id="td-l"></div><div class="tour-dim" id="td-r"></div><div class="tour-spot" id="tour-spot"></div><div class="tour-card" id="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title"></div>`;
  document.body.appendChild(layer);
  layer.addEventListener('click',e=>{ const b=e.target.closest('[data-tour]'); if(!b) return; const a=b.dataset.tour;
    if(a==='next') tourGo(tour.i+1); else if(a==='back') tourGo(tour.i-1); else endTour(); });
  addEventListener('resize',tourPlace); addEventListener('scroll',tourPlace,{passive:true});
  document.addEventListener('keydown',tourKeys);
  tourGo(0);
}
function tourKeys(e){ if(!tour) return; if(e.key==='Escape') endTour(); else if(e.key==='ArrowRight') tourGo(tour.i+1); else if(e.key==='ArrowLeft') tourGo(tour.i-1); }
function tourGo(i){
  const steps=tourSteps();
  if(i>=steps.length){ endTour(); return; }
  if(i<0) i=0;
  tour.i=i; const st=steps[i];
  S.tab=st.tab; if(st.mode) S.mode=st.mode; S.editMap=false;
  render();
  const el=st.target?st.target():null;
  tour.el=el;
  if(el) el.scrollIntoView({block:'center'});
  const card=document.getElementById('tour-card');
  card.innerHTML=`<div class="tour-count">${i+1} of ${steps.length}</div><h3 id="tour-title">${esc(st.title)}</h3><p>${esc(st.text)}</p>
    <div class="tour-actions"><button class="req-btn" data-tour="skip">${i===steps.length-1?'':'Skip tour'}</button><span style="flex:1"></span>${i>0?'<button class="btn" data-tour="back">Back</button>':''}<button class="btn primary" data-tour="next">${i===steps.length-1?'Done':'Next'}</button></div>`;
  requestAnimationFrame(tourPlace);
  const nb=card.querySelector('[data-tour="next"]'); if(nb) nb.focus({preventScroll:true});
}
function tourPlace(){
  if(!tour) return;
  const spot=document.getElementById('tour-spot'), card=document.getElementById('tour-card'); if(!spot||!card) return;
  const el=tour.el&&tour.el.isConnected?tour.el:null;
  const vh=innerHeight, vw=innerWidth;
  const dim=(id,l,t,w,h)=>{ const d=document.getElementById(id); if(d) d.style.cssText=`left:${l}px;top:${t}px;width:${Math.max(0,w)}px;height:${Math.max(0,h)}px`; };
  if(!el){ dim('td-t',0,0,vw,vh); dim('td-b',0,0,0,0); dim('td-l',0,0,0,0); dim('td-r',0,0,0,0); spot.style.cssText='display:none'; card.style.top=Math.max(80,(vh-card.offsetHeight)/2)+'px'; card.style.bottom='auto'; return; }
  const r=el.getBoundingClientRect(), pad=6;
  spot.style.cssText=`left:${r.left-pad}px;top:${r.top-pad}px;width:${r.width+pad*2}px;height:${r.height+pad*2}px`;
  const L=r.left-pad, T=r.top-pad, R=r.right+pad, B=r.bottom+pad;
  dim('td-t',0,0,vw,T); dim('td-b',0,B,vw,vh-B); dim('td-l',0,T,L,B-T); dim('td-r',R,T,vw-R,B-T);
  const ch=card.offsetHeight, below=vh-r.bottom, above=r.top;
  if(below>=ch+24||below>=above){ card.style.top=Math.min(vh-ch-12, r.bottom+pad+12)+'px'; }
  else { card.style.top=Math.max(12, r.top-pad-12-ch)+'px'; }
  card.style.bottom='auto';
}
function endTour(){
  if(!tour) return;
  const sv=tour.saved; tour=null;
  document.getElementById('tour-layer')?.remove();
  removeEventListener('resize',tourPlace); removeEventListener('scroll',tourPlace);
  document.removeEventListener('keydown',tourKeys);
  try{ localStorage.setItem(TOUR_KEY,'1'); }catch{}
  S.tab=sv.tab; S.mode=sv.mode; S.svc=sv.svc; S.editMap=false; render(); scrollTo(0,0);
}
function maybeAutoTour(){
  let done=false; try{ done=localStorage.getItem(TOUR_KEY)==='1'; }catch{}
  if(!done && S.members.length && S.posts.length) setTimeout(startTour,400);
}

/* ---------- boot ---------- */
function onErr(e){ toast('Lost connection to saved data. Reload to reconnect.'); }
export function start(ctx){
  S.db=ctx.db; S.links=ctx.links||null; S.invites=ctx.invites||null; S.me=ctx.email; S.role=ctx.role; S.access=ctx.access; S.signOut=ctx.signOut; S.canWrite=true;
  document.getElementById('tabs').hidden=false;
  const hb=document.getElementById('help-btn'); if(hb){ hb.hidden=false; hb.onclick=()=>startTour(); }
  render();
  const db=S.db;
  db.collection('members').onSnapshot(snap=>{ S.members=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.name||'').localeCompare(b.name||'')); S.loaded.members=true; render(); if(!S.tourChecked&&S.loaded.posts){ S.tourChecked=true; maybeAutoTour(); } }, onErr);
  db.collection('medics').onSnapshot(snap=>{ S.medics=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.name||'').localeCompare(b.name||'')); render(); }, onErr);
  db.collection('posts').onSnapshot(snap=>{ S.posts=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.order??99)-(b.order??99)); S.loaded.posts=true; render(); if(!S.tourChecked&&S.loaded.members){ S.tourChecked=true; maybeAutoTour(); } }, onErr);
  db.doc('settings/team').onSnapshot(snap=>{ S.settings=snap.exists?snap.data():{}; render(); }, onErr);
  db.doc('settings/map').onSnapshot(snap=>{ if(layoutDirty()||S.dragging) return; const dd=snap.exists?snap.data():null; S.layout=(dd&&dd.v===2&&Array.isArray(dd.shapes))?dd:null; render(); }, onErr);
  db.collection('weeks').onSnapshot(snap=>{ const next={}; snap.docs.forEach(d=>{ next[d.id]={...d.data(), date:d.id}; }); if(isDirty(S.date)&&S.weeks[S.date]) next[S.date]=S.weeks[S.date]; S.weeks=next; S.loaded.weeks=true; render(); }, onErr);
}
export { toast, esc };
