import {Store} from './store5.js';
import {ea,extractClubs} from './crawler5.js';
import {sleep,gap,num} from './constants.js';

const ALPHABET='abcdefghijklmnopqrstuvwxyz0123456789';
const SEARCH_PLATFORMS=(process.env.DISCOVERY_PLATFORMS||'common-gen5').split(',').map(x=>x.trim()).filter(Boolean);
const INTERVAL_MINUTES=Math.max(5,Number(process.env.DISCOVERY_INTERVAL_MINUTES||10));
const BATCH=Math.max(10,Number(process.env.DISCOVERY_BATCH||40));
const MAX_DEPTH=Math.min(5,Math.max(2,Number(process.env.DISCOVERY_MAX_DEPTH||4)));
const EXPAND_MIN=Math.max(3,Number(process.env.DISCOVERY_EXPAND_MIN||8));
const active={running:false,processed:0,found:0,expanded:0,newClubs:0,lastPrefix:'',lastPlatform:'',lastError:'',started:0};

async function seed(store){
  for(const platform of SEARCH_PLATFORMS){
    for(const ch of ALPHABET){
      await store.pool.query(`INSERT INTO discovery_frontier(platform,prefix,depth,state,last_count,last_run,priority)
        VALUES($1,$2,1,'pending',0,0,100)
        ON CONFLICT(platform,prefix) DO NOTHING`,[platform,ch]);
    }
  }
}

async function expand(store,platform,prefix,depth,score){
  if(depth>=MAX_DEPTH)return 0;
  let n=0;
  for(const ch of ALPHABET){
    const child=prefix+ch;
    await store.pool.query(`INSERT INTO discovery_frontier(platform,prefix,depth,state,last_count,last_run,priority)
      VALUES($1,$2,$3,'pending',0,0,$4)
      ON CONFLICT(platform,prefix) DO UPDATE SET priority=GREATEST(discovery_frontier.priority,EXCLUDED.priority)`,[platform,child,depth+1,Math.max(2,score)]);
    n++;
  }
  return n;
}

async function searchPrefix(store,row){
  const ids=new Set();let maxReturned=0,errors=0;
  for(const endpoint of ['/currentSeasonLeaderboard/search','/allTimeLeaderboard/search']){
    try{
      const clubs=await extractClubs(store,await ea(endpoint,{platform:row.platform,clubName:row.prefix,maxResultCount:50}),row.platform);
      maxReturned=Math.max(maxReturned,clubs.length);for(const c of clubs)ids.add(String(c.id));
    }catch(e){active.lastError=e.message;errors++}
    await sleep(gap());
  }
  const count=ids.size;
  const shouldExpand=count>0&&(row.depth===1||(row.depth===2&&count>=3)||(row.depth>=3&&(count>=EXPAND_MIN||maxReturned>=45)));
  let children=0;if(shouldExpand&&row.depth<MAX_DEPTH)children=await expand(store,row.platform,row.prefix,row.depth,count*10+maxReturned);
  const nextState=errors===2&&/EA 400/.test(active.lastError||'')?'skipped':'done';
  await store.pool.query(`UPDATE discovery_frontier SET state=$1,last_count=$2,last_run=EXTRACT(EPOCH FROM NOW())::BIGINT,priority=$3 WHERE platform=$4 AND prefix=$5`,[nextState,count,count*10+maxReturned,row.platform,row.prefix]);
  active.processed++;active.found+=count;active.expanded+=children;active.lastPrefix=row.prefix;active.lastPlatform=row.platform;return count;
}

async function cycle(store){
  if(store.mode!=='postgres'||active.running)return;
  active.running=true;active.processed=0;active.found=0;active.expanded=0;active.newClubs=0;active.lastError='';active.started=Math.floor(Date.now()/1000);
  try{
    const before=num((await store.one('SELECT COUNT(*) c FROM clubs'))?.c);
    const rows=await store.q(`SELECT platform,prefix,depth,priority FROM discovery_frontier
      WHERE state='pending' AND platform=ANY($2::text[]) AND (depth=1 OR priority>1)
      ORDER BY priority DESC,depth ASC,CASE platform WHEN 'common-gen5' THEN 0 ELSE 1 END,last_run ASC,prefix ASC LIMIT $1`,[BATCH,SEARCH_PLATFORMS]);
    console.log(`[DISCOVERY10] focused cycle rows=${rows.length} clubsBefore=${before} batch=${BATCH} platforms=${SEARCH_PLATFORMS.join(',')}`);
    for(const row of rows){
      try{await searchPrefix(store,row)}catch(e){active.lastError=e.message;await store.pool.query(`UPDATE discovery_frontier SET state=CASE WHEN $3 LIKE '%EA 400%' THEN 'skipped' ELSE state END,last_run=EXTRACT(EPOCH FROM NOW())::BIGINT,priority=GREATEST(priority-5,0) WHERE platform=$1 AND prefix=$2`,[row.platform,row.prefix,e.message||''])}
      if(active.processed>0&&active.processed%10===0)console.log(`[DISCOVERY10] progress ${active.processed}/${rows.length} hits=${active.found} prefix=${active.lastPlatform}:${active.lastPrefix}`);
      await sleep(gap());
    }
    const s=await store.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='pending') pending,COUNT(*) FILTER(WHERE state='done') done,COUNT(*) FILTER(WHERE state='skipped') skipped,COALESCE(SUM(last_count),0) hits FROM discovery_frontier`);
    const after=num((await store.one('SELECT COUNT(*) c FROM clubs'))?.c);active.newClubs=Math.max(0,after-before);
    console.log(`[DISCOVERY10] done processed=${active.processed} hits=${active.found} newClubs=${active.newClubs} expanded=${active.expanded} pending=${num(s?.pending)} skipped=${num(s?.skipped)} clubs=${after}`);
  }finally{active.running=false}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS discovery_frontier(platform TEXT NOT NULL,prefix TEXT NOT NULL,depth INTEGER DEFAULT 1,state TEXT DEFAULT 'pending',last_count INTEGER DEFAULT 0,last_run BIGINT DEFAULT 0,priority INTEGER DEFAULT 0,PRIMARY KEY(platform,prefix))`);
  await this.pool.query(`CREATE INDEX IF NOT EXISTS discovery_frontier_state_idx ON discovery_frontier(state,depth,priority)`);
  await this.pool.query(`UPDATE discovery_frontier SET state='skipped' WHERE state='pending' AND (NOT(platform=ANY($1::text[])) OR (depth>1 AND priority<=1))`,[SEARCH_PLATFORMS]);
  await seed(this);
  const f=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='pending') pending,COUNT(*) FILTER(WHERE state='skipped') skipped FROM discovery_frontier`);
  console.log(`[DISCOVERY10] focused ready frontier=${num(f?.total)} pending=${num(f?.pending)} skipped=${num(f?.skipped)} interval=${INTERVAL_MINUTES}m batch=${BATCH}`);
  setTimeout(()=>cycle(this).catch(e=>console.warn('[DISCOVERY10]',e.message)),25000).unref();setInterval(()=>cycle(this).catch(e=>console.warn('[DISCOVERY10]',e.message)),INTERVAL_MINUTES*60000).unref();
};

const previousDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await previousDashboard.call(this);if(this.mode!=='postgres')return d;let s={total:0,pending:0,done:0,skipped:0,hits:0};
  try{s=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='pending') pending,COUNT(*) FILTER(WHERE state='done') done,COUNT(*) FILTER(WHERE state='skipped') skipped,COALESCE(SUM(last_count),0) hits FROM discovery_frontier`)||s}catch(e){if(e?.code!=='42P01')console.warn('[DISCOVERY10 dashboard]',e.message)}
  return{...d,adaptiveDiscovery:{...active,total:num(s?.total),pending:num(s?.pending),done:num(s?.done),skipped:num(s?.skipped),hits:num(s?.hits),intervalMinutes:INTERVAL_MINUTES,batch:BATCH,maxDepth:MAX_DEPTH,platforms:SEARCH_PLATFORMS}};
};
