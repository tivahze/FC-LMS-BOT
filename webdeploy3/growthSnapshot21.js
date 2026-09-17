import {Store} from './store5.js';
import {num} from './constants.js';

const SNAPSHOT_MINUTES=Math.max(15,Number(process.env.GROWTH_SNAPSHOT_MINUTES||30));
let timerStarted=false;

async function counts(store){
  return store.one(`SELECT
    (SELECT COUNT(*) FROM clubs) clubs,
    (SELECT COUNT(*) FROM players) players,
    (SELECT COUNT(*) FROM matches) matches,
    (SELECT COUNT(*) FROM match_players) appearances`);
}
async function capture(store,force=false){
  if(store.mode!=='postgres')return;
  const now=Math.floor(Date.now()/1000),last=await store.one('SELECT ts FROM growth_snapshots ORDER BY ts DESC LIMIT 1');
  if(!force&&num(last?.ts)>now-SNAPSHOT_MINUTES*60)return;
  const c=await counts(store);
  await store.pool.query(`INSERT INTO growth_snapshots(ts,clubs,players,matches,appearances) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ts) DO NOTHING`,[now,num(c?.clubs),num(c?.players),num(c?.matches),num(c?.appearances)]);
  await store.pool.query(`DELETE FROM growth_snapshots WHERE ts < $1`,[now-45*86400]);
  console.log(`[GROWTH21] snapshot clubs=${num(c?.clubs)} players=${num(c?.players)} matches=${num(c?.matches)} appearances=${num(c?.appearances)}`);
}
async function baseline(store,seconds){
  const target=Math.floor(Date.now()/1000)-seconds;
  return (await store.one('SELECT * FROM growth_snapshots WHERE ts<=$1 ORDER BY ts DESC LIMIT 1',[target])) || (await store.one('SELECT * FROM growth_snapshots ORDER BY ts ASC LIMIT 1'));
}
function diff(cur,base){return{
  clubs:Math.max(0,num(cur?.clubs)-num(base?.clubs)),
  players:Math.max(0,num(cur?.players)-num(base?.players)),
  matches:Math.max(0,num(cur?.matches)-num(base?.matches)),
  appearances:Math.max(0,num(cur?.appearances)-num(base?.appearances)),
  baselineTs:num(base?.ts)
}}

const prevInit=Store.prototype.init;
Store.prototype.init=async function(){
  await prevInit.call(this);if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS growth_snapshots(ts BIGINT PRIMARY KEY,clubs INTEGER NOT NULL,players INTEGER NOT NULL,matches INTEGER NOT NULL,appearances INTEGER NOT NULL)`);
  await this.pool.query(`CREATE INDEX IF NOT EXISTS growth_snapshots_ts_idx ON growth_snapshots(ts DESC)`);
  await capture(this,true);
  if(!timerStarted){timerStarted=true;setInterval(()=>capture(this).catch(e=>console.warn('[GROWTH21]',e.message)),SNAPSHOT_MINUTES*60000).unref()}
};

const prevDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await prevDashboard.call(this);if(this.mode!=='postgres')return d;
  try{
    const cur=await counts(this),[h1,h6,h24,first]=await Promise.all([baseline(this,3600),baseline(this,21600),baseline(this,86400),this.one('SELECT * FROM growth_snapshots ORDER BY ts ASC LIMIT 1')]);
    return{...d,growth:{current:{clubs:num(cur?.clubs),players:num(cur?.players),matches:num(cur?.matches),appearances:num(cur?.appearances)},h1:diff(cur,h1),h6:diff(cur,h6),h24:diff(cur,h24),sinceTracking:diff(cur,first),snapshotMinutes:SNAPSHOT_MINUTES,startedAt:num(first?.ts)}};
  }catch(e){console.warn('[GROWTH21 dashboard]',e.message);return d}
};
console.log('[GROWTH21] persistent growth snapshots enabled');
