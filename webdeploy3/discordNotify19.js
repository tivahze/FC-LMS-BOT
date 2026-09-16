import {Store} from './store5.js';

const WEBHOOK=String(process.env.DISCORD_WEBHOOK_URL||'').trim();
const previousUpsertMatch=Store.prototype.upsertMatch;

Store.prototype.upsertMatch=async function(match,platform){
  let existed=true;
  if(this.mode==='postgres'&&match?.id){
    try{existed=!!(await this.one('SELECT 1 ok FROM matches WHERE platform=$1 AND match_id=$2 LIMIT 1',[platform,String(match.id)]))}catch{}
  }
  await previousUpsertMatch.call(this,match,platform);
  if(!WEBHOOK||existed||!match?.id)return;
  try{
    const home=match.home||{},away=match.away||{};
    const body={username:'FC Clubs Global',embeds:[{title:`${home.name||'Club'} ${Number(home.goals||0)} - ${Number(away.goals||0)} ${away.name||'Club'}`,description:`Nouveau match FC Clubs Global archivé`,fields:[{name:'Type',value:String(match.type||'Match'),inline:true},{name:'Plateforme',value:String(platform||''),inline:true},{name:'EA Match ID',value:String(match.id),inline:false}],timestamp:new Date((Number(match.ts)||Math.floor(Date.now()/1000))*1000).toISOString()}]};
    const r=await fetch(WEBHOOK,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!r.ok)console.warn(`[DISCORD] webhook HTTP ${r.status}`);
  }catch(e){console.warn('[DISCORD]',e.message)}
};

console.log(`[DISCORD] automatic match notifications ready (${WEBHOOK?'webhook configured':'DISCORD_WEBHOOK_URL not set'})`);
