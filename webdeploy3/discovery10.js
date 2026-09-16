import {Store} from './store5.js';
import {ea,extractClubs} from './crawler5.js';
import {PLATFORMS,sleep,gap,num} from './constants.js';

const ALPHABET='abcdefghijklmnopqrstuvwxyz0123456789';
const INTERVAL_MINUTES=Math.max(5,Number(process.env.DISCOVERY_INTERVAL_MINUTES||8));
const BATCH=Math.max(20,Number(process.env.DISCOVERY_BATCH||100));
const MAX_DEPTH=Math.min(5,Math.max(2,Number(process.env.DISCOVERY_MAX_DEPTH||4)));
const EXPAND_MIN=Math.max(5,Number(process.env.DISCOVERY_EXPAND_MIN||12));
const active={running:false,processed:0,found:0,expanded:0,lastPrefix:'',lastPlatform:'',lastError:'',started:0};

async function seed(store){
  for(const platform of PLATFORMS){
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
      ON CONFLICT(platform,prefix) DO NOTHING`,[platform,child,depth+1,Math.max(1,score)]);
    n++;
  }
  return n;
}

async function searchPrefix(store,row){
  const ids=new Set();
  let maxReturned=0;
  for(const endpoint of ['/allTimeLeaderboard/search','/currentSeasonLeaderboard/search']){
    try{
      const clubs=await extractClubs(store,await ea(endpoint,{platform:row.platform,clubName:row.prefix,maxResultCount:50}),row.platform);
      maxReturned=Math.max(maxReturned,clubs.length);
      for(const c of clubs)ids.add(String(c.id));
    }catch(e){active.lastError=e.message}
    await sleep(gap());
  }
  const count=ids.size;
  const shouldExpand=row.depth===1 || (row.depth===2&&count>=Math.min(EXPAND_MIN,8)) || (row.depth>=3&&(count>=EXPAND_MIN||maxReturned>=45));
  let children=0;
  if(shouldExpand&&row.depth<MAX_DEPTH)children=await expand(store,row.platform,row.prefix,row.depth,count*10+maxReturned);
  await store.pool.query(`UPDATE discovery_frontier SET state='done',last_count=$1,last_run=EXTRACT(EPOCH FROM NOW())::BIGINT,priority=$2 WHERE platform=$3 AND prefix=$4`,[count,count*10+maxReturned,row.platform,row.prefix]);
  active.processed++;
  active.found+=count;
  active.expanded+=children;
  active.lastPrefix=row.prefix;
  active.lastPlatform=row.platform;
  return count;
}

async function cycle(store){
  if(store.mode!=='postgres'||active.running)return;
  active.running=true;active.processed=0;active.found=0;active.expanded=0;active.lastError='';active.started=Math.floor(Date.now()/1000);
  try{
    const rows=await store.q(`SELECT platform,prefix,depth,priority FROM discovery_frontier
      WHERE state='pending'
      ORDER BY depth ASC,priority DESC,prefix ASC
      LIMIT $1`,[BATCH]);
    for(const row of rows){
      try{await searchPrefix(store,row)}catch(e){
        active.lastError=e.message;
        await store.pool.query(`UPDATE discovery_frontier SET last_run=EXTRACT(EPOCH FROM NOW())::BIGINT,priority=GREATEST(priority-1,0) WHERE platform=$1 AND prefix=$2`,[row.platform,row.prefix]);
      }
      await sleep(gap());
    }
    const s=await store.one(`SELECT COUNT(*) total,
      COUNT(*) FILTER(WHERE state='pending') pending,
      COUNT(*) FILTER(WHERE state='done') done,
      COALESCE(SUM(last_count),0) hits
      FROM discovery_frontier`);
    const c=await store.one('SELECT COUNT(*) c FROM clubs');
    console.log(`[DISCOVERY10] processed=${active.processed} hits=${active.found} expanded=${active.expanded} frontier=${num(s?.total)} pending=${num(s?.pending)} done=${num(s?.done)} clubs=${num(c?.c)}${active.lastError?' error='+active.lastError:''}`);
  }finally{active.running=false}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS discovery_frontier(
    platform TEXT NOT NULL,
    prefix TEXT NOT NULL,
    depth INTEGER DEFAULT 1,
    state TEXT DEFAULT 'pending',
    last_count INTEGER DEFAULT 0,
    last_run BIGINT DEFAULT 0,
    priority INTEGER DEFAULT 0,
    PRIMARY KEY(platform,prefix)
  );
  CREATE INDEX IF NOT EXISTS discovery_frontier_state_idx ON discovery_frontier(state,depth,priority);`);
  await seed(this);
  setTimeout(()=>cycle(this).catch(e=>console.warn('[DISCOVERY10]',e.message)),20000).unref();
  setInterval(()=>cycle(this).catch(e=>console.warn('[DISCOVERY10]',e.message)),INTERVAL_MINUTES*60000).unref();
};

const previousDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await previousDashboard.call(this);
  if(this.mode!=='postgres')return d;
  let s={total:0,pending:0,done:0,hits:0};
  try{
    s=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='pending') pending,COUNT(*) FILTER(WHERE state='done') done,COALESCE(SUM(last_count),0) hits FROM discovery_frontier`)||s;
  }catch(e){
    if(e?.code!=='42P01')console.warn('[DISCOVERY10 dashboard]',e.message);
  }
  return{...d,adaptiveDiscovery:{...active,total:num(s?.total),pending:num(s?.pending),done:num(s?.done),hits:num(s?.hits),intervalMinutes:INTERVAL_MINUTES,batch:BATCH,maxDepth:MAX_DEPTH}};
};
