import{$,esc,nf,f2,labels,playerUrl,clubUrl,matchUrl,get,dateTime}from'./v8-common.js';

let loading=false,retryTimer=null;

function matchCard(title,x,sub){
  if(!x)return`<div class="recordCard"><div class="kicker">${esc(title)}</div><div class="empty">Aucune donnée</div></div>`;
  return`<a class="recordCard" href="${matchUrl(x)}"><div class="kicker">${esc(title)}</div><b>${esc(x.home_name)} ${nf(x.home_goals)}-${nf(x.away_goals)} ${esc(x.away_name)}</b><strong>${esc(sub(x))}</strong><span>${dateTime(x.ts)}</span></a>`;
}
function playerCard(title,x,unit){
  if(!x)return`<div class="recordCard"><div class="kicker">${esc(title)}</div><div class="empty">Aucune donnée</div></div>`;
  return`<div class="recordCard"><div class="kicker">${esc(title)}</div><a href="${playerUrl({platform:x.platform,player_id:x.player_id,name:x.name})}"><b>${esc(x.name)}</b></a><strong>${unit==='note'?f2(x.value):nf(x.value)} ${unit==='note'?'':esc(unit)}</strong><a class="small muted" href="${matchUrl(x)}">${esc(x.home_name)} ${nf(x.home_goals)}-${nf(x.away_goals)} ${esc(x.away_name)}</a></div>`;
}
function render(r){
  const s=r.longestWinStreak||{};
  $('#content').innerHTML=`<section class="recordGrid">${matchCard('Match avec le plus de buts',r.goalsMatch,x=>`${nf(x.value)} buts au total`)}${matchCard('Plus gros écart',r.marginMatch,x=>`${nf(x.value)} buts d’écart`)}${playerCard('Plus de buts sur un match',r.playerGoals,'buts')}${playerCard('Plus de passes sur un match',r.playerAssists,'passes')}${playerCard('Plus de contributions sur un match',r.playerContrib,'B+P')}${playerCard('Meilleure note observée',r.playerRating,'note')}<div class="recordCard"><div class="kicker">PLUS LONGUE SÉRIE DE VICTOIRES ARCHIVÉE</div>${s.club_id?`<a href="${clubUrl({platform:s.platform,club_id:s.club_id,name:s.club_name})}"><b>${esc(s.club_name||'Club')}</b></a><strong>${nf(s.wins)} victoires</strong><span>${esc(labels[s.platform]||s.platform)}</span>`:'<div class="empty">Aucune donnée</div>'}</div></section><section class="panel"><p class="muted">Ces records reflètent uniquement les matchs FC27 actuellement archivés par FC Clubs Global. Ils évoluent à mesure que la base grandit.</p></section>`;
}

async function load({quiet=false}={}){
  if(loading)return;
  loading=true;
  const btn=$('#reload');
  if(btn){btn.disabled=true;btn.textContent='Chargement…'}
  try{
    const p=$('#platform').value;
    const r=await get(`/api/v9/records?platform=${encodeURIComponent(p)}`);
    clearTimeout(retryTimer);
    render(r);
  }catch(e){
    if(!quiet)$('#content').innerHTML='<div class="empty">Chargement des records…</div>';
    clearTimeout(retryTimer);
    retryTimer=setTimeout(()=>load({quiet:false}),1500);
  }finally{
    loading=false;
    if(btn){btn.disabled=false;btn.textContent='Actualiser'}
  }
}

$('#platform').onchange=()=>load();
$('#reload').onclick=()=>load();
load();
