import{$,esc,nf,labels,playerUrl,clubUrl,matchUrl,get,relative}from'./v8-common.js';

let loading=false,retryTimer=null;

function eventHtml(e){
  const d=e.data||{};
  if(e.type==='match')return `<a class="feedItem" href="${matchUrl(d)}"><div class="feedIcon">⚽</div><div><b>${esc(d.home_name)} ${nf(d.home_goals)}-${nf(d.away_goals)} ${esc(d.away_name)}</b><div class="small muted">Match archivé • ${esc(d.match_type||'')} • ${esc(labels[d.platform]||d.platform)}</div></div><span>${relative(e.at)}</span></a>`;
  if(e.type==='club')return `<a class="feedItem" href="${clubUrl(d)}"><div class="feedIcon">◆</div><div><b>${esc(d.name)}</b><div class="small muted">Club mis à jour • ${nf(d.games)} matchs • ${nf(d.skill)} Skill</div></div><span>${relative(e.at)}</span></a>`;
  return `<a class="feedItem" href="${playerUrl(d)}"><div class="feedIcon">●</div><div><b>${esc(d.name)}</b><div class="small muted">Joueur mis à jour • ${esc(d.club_name||'Sans club')} • ${nf(d.goals)} buts</div></div><span>${relative(e.at)}</span></a>`;
}

function render(items){
  $('#content').innerHTML=`<section class="panel feed">${items.map(eventHtml).join('')||'<div class="empty">Aucune activité pour le moment.</div>'}</section><div class="small muted" style="text-align:center;margin-top:10px">Actualisation automatique toutes les 30 secondes.</div>`;
}

async function load({quiet=false}={}){
  if(loading)return;
  loading=true;
  try{
    const r=await get('/api/v9/live?limit=80');
    clearTimeout(retryTimer);
    render(r.items||[]);
  }catch(e){
    if(!quiet)$('#content').innerHTML='<div class="empty">Connexion au flux en cours…</div>';
    clearTimeout(retryTimer);
    retryTimer=setTimeout(()=>load({quiet:false}),1500);
  }finally{
    loading=false;
  }
}

load();
setInterval(()=>load({quiet:true}),30000);
