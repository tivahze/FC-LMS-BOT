import{$,esc,nf,playerUrl,clubUrl,matchUrl,attachGlobalSearch,get,relative,labels}from'./v8-common.js';

attachGlobalSearch($('#globalSearch'),$('#suggestions'));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function safeGet(url,fallback){
  let last;
  for(let attempt=0;attempt<2;attempt++){
    try{return await get(url)}catch(e){last=e;if(attempt===0)await sleep(300)}
  }
  console.warn('[HOME]',url,last?.message||last);
  return typeof fallback==='function'?fallback(last):fallback;
}
const empty=msg=>`<div class="empty">${esc(msg)}</div>`;
const itemsOf=x=>Array.isArray(x?.items)?x.items:[];
const setText=(selector,value)=>{const el=$(selector);if(el)el.textContent=value};

function popularPlayer(p){
  return`<a class="line" href="${playerUrl(p)}"><span><b>${esc(p.name)}</b><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span>${nf(p.views)} vue${Number(p.views)!==1?'s':''}</span></a>`;
}
function popularClub(c){
  return`<a class="line" href="${clubUrl(c)}"><span><b>${esc(c.name)}</b><span class="small muted"> • ${esc(labels[c.platform]||c.platform)}</span></span><span>${nf(c.views)} vue${Number(c.views)!==1?'s':''}</span></a>`;
}
function recentPlayer(p){
  return`<a class="line" href="${playerUrl(p)}"><span><b>${esc(p.name)}</b><span class="newTag">Mis à jour</span><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span class="small muted">${relative(p.updated_at)}</span></a>`;
}
function recentClub(c){
  return`<a class="line" href="${clubUrl(c)}"><span><b>${esc(c.name)}</b><span class="newTag">Mis à jour</span><span class="small muted"> • ${esc(labels[c.platform]||c.platform)}</span></span><span class="small muted">${relative(c.updated_at)}</span></a>`;
}
function activeClub(c){
  const games=Number(c.games||0),wr=games?Number(c.wins||0)/games*100:0;
  return`<a class="card" style="padding:15px" href="${clubUrl(c)}"><div class="identity"><div class="crest">${esc(c.name?.[0]||'?')}</div><div><b>${esc(c.name)}</b><div class="small muted">${esc(labels[c.platform]||c.platform)}</div></div></div><div class="metrics" style="grid-template-columns:repeat(3,1fr);margin-bottom:0"><div class="metric"><b>${nf(games)}</b><span>Matchs</span></div><div class="metric"><b>${nf(c.wins)}</b><span>Victoires</span></div><div class="metric"><b>${wr.toFixed(1)}%</b><span>% V</span></div></div></a>`;
}
function renderStats(s){
  if(!s)return false;
  for(const[id,value]of [['#heroPlayers',s.players],['#sPlayers',s.players],['#sClubs',s.clubs],['#sMatches',s.matches],['#sApps',s.appearances]])setText(id,nf(value));
  return true;
}

function installSearchKeyboard(){
  const input=$('#globalSearch'),box=$('#suggestions');
  if(!input||!box||input.dataset.fcgKeyboard==='1')return;
  input.dataset.fcgKeyboard='1';
  let active=-1;
  const options=()=>[...box.querySelectorAll('a.suggestion')];
  const paint=()=>{
    const list=options();
    if(active>=list.length)active=list.length-1;
    list.forEach((a,i)=>{
      a.setAttribute('role','option');
      a.setAttribute('aria-selected',String(i===active));
      a.classList.toggle('search-active',i===active);
      if(i===active)a.scrollIntoView({block:'nearest'});
    });
    input.setAttribute('aria-expanded',String(!box.hidden));
  };
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls','suggestions');
  input.setAttribute('aria-expanded','false');
  box.setAttribute('role','listbox');
  new MutationObserver(()=>{active=-1;paint()}).observe(box,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  input.addEventListener('keydown',e=>{
    const list=options();
    if(e.key==='ArrowDown'&&list.length){e.preventDefault();active=(active+1+list.length)%list.length;paint()}
    else if(e.key==='ArrowUp'&&list.length){e.preventDefault();active=(active-1+list.length)%list.length;paint()}
    else if(e.key==='Enter'&&active>=0&&list[active]){e.preventDefault();list[active].click()}
    else if(e.key==='Escape'){box.hidden=true;active=-1;paint();input.blur()}
  });
  document.addEventListener('keydown',e=>{
    const tag=document.activeElement?.tagName?.toLowerCase();
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();input.select()}
    else if(e.key==='/'&&!['input','textarea','select'].includes(tag)){e.preventDefault();input.focus()}
  });
  const st=document.createElement('style');
  st.textContent='.suggestion.search-active{background:linear-gradient(90deg,#2c173d,#20122b)!important;box-shadow:inset 3px 0 0 #b56cff!important;color:#fff!important}.suggestions{overflow:auto!important;max-height:min(62vh,520px)!important;overscroll-behavior:contain!important}';
  document.head.appendChild(st);
  paint();
}

async function load(){
  for(const id of ['#heroPlayers','#sPlayers','#sClubs','#sMatches','#sApps'])setText(id,'…');
  const activeEl=$('#activeClubs');
  if(activeEl)activeEl.innerHTML='<div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div>';

  const bootPromise=safeGet('/api/boot-stats',null);
  const dataPromise=Promise.all([
    safeGet('/api/v8/popular?type=player&limit=8',{items:[]}),
    safeGet('/api/v8/popular?type=club&limit=8',{items:[]}),
    safeGet('/api/players?sort=recent:desc&limit=10',{items:[]}),
    safeGet('/api/clubs?sort=recent:desc&limit=10',{items:[]}),
    safeGet('/api/v8/rankings?type=club&metric=games&minGames=0&limit=6',{items:[]}),
    safeGet('/api/matches',{items:[]}),
    safeGet('/api/v8/stats',null)
  ]);

  const boot=await bootPromise;
  renderStats(boot);

  const[pp,pc,rp,rc,active,m,fullStats]=await dataPromise;
  if(!renderStats(fullStats)){
    const fallback=await safeGet('/api/dashboard',null);
    renderStats(fallback||boot);
  }

  const popularPlayers=$('#popularPlayers');
  if(popularPlayers)popularPlayers.innerHTML=itemsOf(pp).map(popularPlayer).join('')||empty('Les consultations apparaîtront ici.');
  const popularClubs=$('#popularClubs');
  if(popularClubs)popularClubs.innerHTML=itemsOf(pc).map(popularClub).join('')||empty('Les consultations apparaîtront ici.');
  const recentPlayers=$('#recentPlayers');
  if(recentPlayers)recentPlayers.innerHTML=itemsOf(rp).slice(0,6).map(recentPlayer).join('')||empty('Aucun joueur mis à jour récemment.');
  const recentClubs=$('#recentClubs');
  if(recentClubs)recentClubs.innerHTML=itemsOf(rc).slice(0,6).map(recentClub).join('')||empty('Aucun club mis à jour récemment.');
  if(activeEl)activeEl.innerHTML=itemsOf(active).map(activeClub).join('')||empty('Aucun club actif disponible.');
  const matches=$('#matches');
  if(matches)matches.innerHTML=itemsOf(m).slice(0,10).map(x=>`<a class="matchrow linkrow" href="${matchUrl(x)}"><b>${esc(x.home_name||'—')}</b><strong>${nf(x.home_goals)}-${nf(x.away_goals)}</strong><b>${esc(x.away_name||'—')}</b><span class="small muted">${relative(x.ts)}</span></a>`).join('')||empty('Aucun match archivé pour le moment.');
}

installSearchKeyboard();
load().catch(e=>{
  console.error('[HOME FATAL]',e);
  const active=$('#activeClubs');
  if(active)active.innerHTML=empty('Impossible de charger cette section.');
});
