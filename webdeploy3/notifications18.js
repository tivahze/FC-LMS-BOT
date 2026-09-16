import {Store} from './store5.js';
import {muid,num} from './constants.js';

const WEBHOOK=String(process.env.DISCORD_WEBHOOK_URL||'').trim();
const oldUpsert=Store.prototype.upsertMatch;
const sent=new Set();

async function discord(match,platform){
  if(!WEBHOOK)return;
  const id=String(match?.id||match?.match_id||'');
  if(!id||sent.has(`${platform}:${id}`))return;
  sent.add(`${platform}:${id}`);
  const h=match.home||{},a=match.away||{};
  const payload={
    username:'FC Clubs Global',
    embeds:[{
      title:`${h.name||'Club'} ${num(h.goals)} - ${num(a.goals)} ${a.name||'Club'}`,
      description:`Nouveau match FC Clubs archivé automatiquement.`,
      fields:[
        {name:'Plateforme',value:String(platform||'—'),inline:true},
        {name:'Type',value:String(match.type||match.match_type||'Match'),inline:true},
        {name:'Match ID EA',value:id,inline:false}
      ],
      timestamp:new Date((num(match.ts)||Math.floor(Date.now()/1000))*1000).toISOString()
    }]
  };
  try{const r=await fetch(WEBHOOK,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});if(!r.ok)console.warn('[DISCORD] webhook',r.status)}catch(e){console.warn('[DISCORD]',e.message)}
}

Store.prototype.upsertMatch=async function(match,platform){
  let existed=true,id=String(match?.id||match?.match_id||'');
  if(this.mode==='postgres'&&id){try{existed=!!(await this.one('SELECT 1 ok FROM matches WHERE uid=$1',[muid(platform,id)]))}catch{}}
  const out=await oldUpsert.call(this,match,platform);
  if(!existed&&WEBHOOK)discord(match,platform).catch(()=>{});
  return out;
};

console.log(`[DISCORD] automatic match notifications ${WEBHOOK?'enabled':'ready (DISCORD_WEBHOOK_URL not set)'}`);
