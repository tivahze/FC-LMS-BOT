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
async function waitForApiReady(maxMs=45000){
  const start=Date.now();
  while(Date.now()-start<maxMs){
    try{
      const h=await get('/api/health');
      if(h?.ready)return true;
      $('#indexStatus').textContent='Initialisation de la base FC27…';
    }catch{}
    await sleep(700);
  }
  return false;
}
const itemsOf=x=>Array.isArray(x?.items)?x.items:[];

function linePlayer(p,i){return`<a class="line" href="${playerUrl(p)}"><span><b>#${i+1} ${esc(p.name)}</b><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span><b>${nf(p.goals)}</b> buts</span></a>`}
function lineClub(c,i){return`<a class="line" href="${clubUrl(c)}"><span><b>#${i+1} ${esc(c.name)}</b><span class="small muted"> • ${esc(labels[c.platform]||c.platform)}</span></span><span><b>${nf(c.skill)}</b> skill</span></a>`}
function formPlayer(p,i){return`<a class="line" href="${playerUrl(p)}"><span><b>#${i+1} ${esc(p.name)}</b><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span class="formMini">${nf(Math.round(Number(p.form10||0)))}</span></a>`}
function formClub(c,i){return`<a class="line" href="${clubUrl(c)}"><span><b>#${i+1} ${esc(c.name)}</b><span class="small muted"> • ${nf(c.wins10)}V ${nf(c.draws10)}N sur ${nf(c.games10)}</span></span><span class="formMini">${nf(Math.round(Number(c.form10||0)))}</span></a>`}
function popularPlayer(p){return`<a class="line" href="${playerUrl(p)}"><span><b>${esc(p.name)}</b><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span>${nf(p.views)} vue${Number(p.views)!==1?'s':''}</span></a>`}
function popularClub(c){return`<a class="line" href="${clubUrl(c)}"><span><b>${esc(c.name)}</b><span class="small muted"> • ${esc(labels[c.platform]||c.platform)}</span></span><span>${nf(c.views)} vue${Number(c.views)!==1?'s':''}</span></a>`}
function recentPlayer(p){return`<a class="line" href="${playerUrl(p)}"><span><b>${esc(p.name)}</b><span class="newTag">Mis à jour</span><span class="small muted"> • ${esc(p.club_name||'Sans club')}</span></span><span class="small muted">${relative(p.updated_at)}</span></a>`}
function recentClub(c){return`<a class="line" href="${clubUrl(c)}"><span><b>${esc(c.name)}</b><span class="newTag">Mis à jour</span><span class="small muted"> • ${esc(labels[c.platform]||c.platform)}</span></span><span class="small muted">${relative(c.updated_at)}</span></a>`}
function activeClub(c){const games=Number(c.games||0),wr=games?Number(c.wins||0)/games*100:0;return`<a class="card" style="padding:15px" href="${clubUrl(c)}"><div class="identity"><div class="crest">${esc(c.name?.[0]||'?')}</div><div><b>${esc(c.name)}</b><div class="small muted">${esc(labels[c.platform]||c.platform)}</div></div></div><div class="metrics" style="grid-template-columns:repeat(3,1fr);margin-bottom:0"><div class="metric"><b>${nf(games)}</b><span>Matchs</span></div><div class="metric"><b>${nf(c.wins)}</b><span>Victoires</span></div><div class="metric"><b>${wr.toFixed(1)}%</b><span>% V</span></div></div></a>`}
function plus(v){return`+${nf(Math.max(0,Number(v||0)))}`}
function setGrowth(idP,idC,g){$(idP).textContent=plus(g?.players);$(idC).textContent=`${plus(g?.clubs)} clubs`}
function nextTarget(n,type){const steps=type==='players'?[100,250,500,1000,2500,5000,10000,25000,50000,100000]:[50,100,250,500,1000,2500,5000,10000,25000];return steps.find(x=>x>n)||Math.ceil(n/10000+1)*10000}
function milestoneCard(label,value,type){const target=nextTarget(value,type),prev=type==='players'?(target<=100?0:target<=250?100:target<=500?250:target<=1000?500:target<=2500?1000:target<=5000?2500:target<=10000?5000:Math.floor(value/10000)*10000):(target<=50?0:target<=100?50:target<=250?100:target<=500?250:target<=1000?500:target<=2500?1000:target<=5000?2500:Math.floor(value/5000)*5000),pct=Math.max(2,Math.min(100,((value-prev)/(target-prev||target))*100));return`<div style="padding:14px 15px;border:1px solid #3a2c49;border-radius:15px;background:linear-gradient(145deg,#171020,#0e0b14)"><div style="display:flex;justify-content:space-between;gap:12px;align-items:end;margin-bottom:9px"><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#9e8bb4;font-weight:900">Prochain palier ${label}</div><b style="font-size:18px;color:#efe9ff">${nf(value)} / ${nf(target)}</b></div><span style="font-size:11px;color:#9f95aa">${Math.max(0,target-value)} restants</span></div><div style="height:8px;background:#0a0710;border-radius:99px;overflow:hidden;border:1px solid #2d2239"><div style="height:100%;width:${pct.toFixed(1)}%;background:linear-gradient(90deg,#7c3aed,#c084fc);box-shadow:0 0 18px #7c3aed88;border-radius:99px"></div></div></div>`}
function renderMilestones(s){let el=document.getElementById('growthMilestones');if(!el){el=document.createElement('div');el.id='growthMilestones';el.style.cssText='display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;position:relative';const grid=document.querySelector('.growthGrid');grid?.insertAdjacentElement('afterend',el);const st=document.createElement('style');st.textContent='@media(max-width:650px){#growthMilestones{grid-template-columns:1fr!important}}';document.head.appendChild(st)}el.innerHTML=milestoneCard('joueurs',Number(s.players||0),'players')+milestoneCard('clubs',Number(s.clubs||0),'clubs')}
function renderGrowth(s){const g=s.growth||{};setGrowth('#g1Players','#g1Clubs',g.h1);setGrowth('#g6Players','#g6Clubs',g.h6);setGrowth('#g24Players','#g24Clubs',g.h24);setGrowth('#gAllPlayers','#gAllClubs',g.sinceTracking);renderMilestones(s);const id=s.idSweep||{},ge=s.growthEngine||{},parts=[];if(id.batch)parts.push(`${nf(id.batch)} IDs / ${nf(id.intervalMinutes)} min`);if(ge.hydrateBatch)parts.push(`${nf(ge.hydrateBatch)} clubs hydratés / cycle`);if(s.trackedClubs)parts.push(`${nf(s.trackedClubs)} clubs suivis`);if(!parts.length&&g.snapshotMinutes)parts.push(`instantané toutes les ${nf(g.snapshotMinutes)} min`);$('#indexStatus').textContent=parts.length?parts.join(' • '):'Suivi de croissance actif'}
function renderQuickStats(s){if(!s)return false;for(const[id,value]of [['#heroPlayers',s.players],['#sPlayers',s.players],['#sClubs',s.clubs],['#sMatches',s.matches],['#sApps',s.appearances]])$(id).textContent=nf(value);if($('#storage'))$('#storage').textContent=s.storage==='postgres'?'PostgreSQL':s.storage==='sqlite'?'Local':(s.storage||'—');return true}
function renderCoreStats(s,advanced=true){if(!s)return false;const ids=[['#heroPlayers',s.players],['#sPlayers',s.players],['#sClubs',s.clubs],['#sMatches',s.matches],['#sApps',s.appearances]];for(const[id,value]of ids)$(id).textContent=nf(value);if(advanced){renderGrowth(s);$('#qUnresolved').textContent=nf(s.quality?.unresolvedClubs);$('#qDup').textContent=nf(s.quality?.duplicatePlayerGroups);$('#qOrphan').textContent=nf(s.quality?.orphanAppearances);$('#latestMatch').textContent=relative(s.latestMatch);$('#latestUpdate').textContent=relative(s.latestUpdate)}else{$('#indexStatus').textContent='Indexation active • statistiques détaillées temporairement indisponibles';$('#qUnresolved').textContent='—';$('#qDup').textContent='—';$('#qOrphan').textContent='—';$('#latestMatch').textContent='—';$('#latestUpdate').textContent='—';renderMilestones(s)}$('#storage').textContent=s.storage==='postgres'?'PostgreSQL':s.storage==='sqlite'?'Local':(s.storage||'—');return true}

function installSearchKeyboard(){
  const input=$('#globalSearch'),box=$('#suggestions');if(!input||!box||input.dataset.fcgKeyboard==='1')return;input.dataset.fcgKeyboard='1';let active=-1;
  const options=()=>[...box.querySelectorAll('a.suggestion')];
  const paint=()=>{const list=options();if(active>=list.length)active=list.length-1;list.forEach((a,i)=>{a.setAttribute('role','option');a.setAttribute('aria-selected',String(i===active));a.classList.toggle('search-active',i===active);if(i===active)a.scrollIntoView({block:'nearest'})});input.setAttribute('aria-expanded',String(!box.hidden))};
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','suggestions');input.setAttribute('aria-expanded','false');box.setAttribute('role','listbox');
  new MutationObserver(()=>{active=-1;paint()}).observe(box,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  input.addEventListener('keydown',e=>{const list=options();if(e.key==='ArrowDown'&&list.length){e.preventDefault();active=(active+1+list.length)%list.length;paint()}else if(e.key==='ArrowUp'&&list.length){e.preventDefault();active=(active-1+list.length)%list.length;paint()}else if(e.key==='Enter'&&active>=0&&list[active]){e.preventDefault();list[active].click()}else if(e.key==='Escape'){box.hidden=true;active=-1;paint();input.blur()}});
  document.addEventListener('keydown',e=>{const tag=document.activeElement?.tagName?.toLowerCase();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();input.select()}else if(e.key==='/'&&!['input','textarea','select'].includes(tag)){e.preventDefault();input.focus()}});
  const st=document.createElement('style');st.textContent='.suggestion.search-active{background:linear-gradient(90deg,#2c173d,#20122b)!important;box-shadow:inset 3px 0 0 #b56cff!important;color:#fff!important}.suggestions{overflow:auto!important;max-height:min(62vh,520px)!important;overscroll-behavior:contain!important}';document.head.appendChild(st);paint();
}

async function load(){
  $('#activeClubs').innerHTML='<div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div><div class="skeleton" style="height:110px"></div>';
  for(const id of ['#heroPlayers','#sPlayers','#sClubs','#sMatches','#sApps'])$(id).textContent='…';
  $('#indexStatus').textContent='Chargement FC27…';

  const bootPromise=safeGet('/api/boot-stats',null);
  const readyPromise=waitForApiReady();
  const boot=await bootPromise;
  if(renderQuickStats(boot))$('#indexStatus').textContent='Compteurs chargés • initialisation des statistiques détaillées…';

  const ready=await readyPromise;
  if(!ready)$('#indexStatus').textContent='Les statistiques détaillées mettent plus de temps que prévu…';

  const statsPromise=safeGet('/api/v8/stats',null);
  const sectionsPromise=Promise.all([
    safeGet('/api/v8/rankings?type=player&metric=goals&minGames=3&limit=8',{items:[]}),
    safeGet('/api/v8/rankings?type=club&metric=skill&minGames=3&limit=8',{items:[]}),
    safeGet('/api/v8/rankings?type=player&metric=form10:desc&minGames=3&limit=8',{items:[]}),
    safeGet('/api/v8/rankings?type=club&metric=form10:desc&minGames=3&limit=8',{items:[]}),
    safeGet('/api/v8/rankings?type=club&metric=games&minGames=0&limit=6',{items:[]}),
    safeGet('/api/matches',{items:[]}),
    safeGet('/api/v8/popular?type=player&limit=8',{items:[]}),
    safeGet('/api/v8/popular?type=club&limit=8',{items:[]}),
    safeGet('/api/players?sort=recent:desc&limit=10',{items:[]}),
    safeGet('/api/clubs?sort=recent:desc&limit=10',{items:[]})
  ]);

  let stats=await statsPromise;
  if(!renderCoreStats(stats,true)){
    stats=await safeGet('/api/dashboard',null);
    if(!renderCoreStats(stats,false)){
      $('#indexStatus').textContent='Connexion aux statistiques en cours…';
      for(const id of ['#heroPlayers','#sPlayers','#sClubs','#sMatches','#sApps'])$(id).textContent='…';
      setTimeout(()=>load().catch(console.error),2500);
    }
  }

  const[pr,cr,fp,fc,active,m,pp,pc,rp,rc]=await sectionsPromise;
  $('#topPlayers').innerHTML=itemsOf(pr).map(linePlayer).join('')||empty('Aucune donnée disponible pour le moment.');
  $('#topClubs').innerHTML=itemsOf(cr).map(lineClub).join('')||empty('Aucune donnée disponible pour le moment.');
  $('#formPlayers').innerHTML=itemsOf(fp).map(formPlayer).join('')||empty('Pas encore assez de matchs récents.');
  $('#formClubs').innerHTML=itemsOf(fc).map(formClub).join('')||empty('Pas encore assez de matchs récents.');
  $('#activeClubs').innerHTML=itemsOf(active).map(activeClub).join('')||empty('Aucun club actif disponible.');
  $('#recentPlayers').innerHTML=itemsOf(rp).slice(0,6).map(recentPlayer).join('')||empty('Aucun joueur mis à jour récemment.');
  $('#recentClubs').innerHTML=itemsOf(rc).slice(0,6).map(recentClub).join('')||empty('Aucun club mis à jour récemment.');
  $('#popularPlayers').innerHTML=itemsOf(pp).map(popularPlayer).join('')||empty('Les consultations apparaîtront ici.');
  $('#popularClubs').innerHTML=itemsOf(pc).map(popularClub).join('')||empty('Les consultations apparaîtront ici.');
  $('#matches').innerHTML=itemsOf(m).slice(0,10).map(x=>`<a class="matchrow linkrow" href="${matchUrl(x)}"><b>${esc(x.home_name||'—')}</b><strong>${nf(x.home_goals)}-${nf(x.away_goals)}</strong><b>${esc(x.away_name||'—')}</b><span class="small muted">${relative(x.ts)}</span></a>`).join('')||empty('Aucun match archivé pour le moment.');
}

installSearchKeyboard();
load().catch(e=>{console.error('[HOME FATAL]',e);$('#activeClubs').innerHTML=empty('Impossible de charger cette section.');$('#indexStatus').textContent='Une partie des données est momentanément indisponible.'});
