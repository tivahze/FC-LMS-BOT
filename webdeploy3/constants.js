export const BASE = 'https://proclubs.ea.com/api/fc';
export const PLATFORMS = ['common-gen5','common-gen4','nx'];
export const LABEL = {'common-gen5':'Current Gen','common-gen4':'Last Gen',nx:'Switch'};
export const MATCH_TYPES = ['friendlyMatch','leagueMatch','playoffMatch'];
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
export const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');
export const cuid = (p,id) => `FC26:${p}:${id}`;
export const puid = (p,id) => `FC26:${p}:${id}`;
export const muid = (p,id) => `FC26:${p}:${id}`;
export const now = () => Math.floor(Date.now()/1000);
export const gap = () => Math.max(350, Number(process.env.EA_REQUEST_GAP_MS || 600));

export const ARCHETYPES = {
  '1': {name:'Shot Stopper', playstyle:'Deflector', group:'Gardien'},
  '2': {name:'Sweeper Keeper', playstyle:'Far Throw', group:'Gardien'},
  '3': {name:'Progressor', playstyle:'Intercept', group:'Défenseur'},
  '4': {name:'Boss', playstyle:'Anticipate', group:'Défenseur'},
  '5': {name:'Engine', playstyle:'Rapid', group:'Défenseur'},
  '6': {name:'Marauder', playstyle:'Trickster', group:'Défenseur'},
  '7': {name:'Recycler', playstyle:'Tiki Taka', group:'Milieu'},
  '8': {name:'Maestro', playstyle:'Incisive', group:'Milieu'},
  '9': {name:'Creator', playstyle:'Quick Step', group:'Milieu'},
  '10': {name:'Spark', playstyle:'Technical', group:'Milieu'},
  '11': {name:'Magician', playstyle:'Inventive', group:'Attaquant'},
  '12': {name:'Finisher', playstyle:'Acrobatic', group:'Attaquant'},
  '13': {name:'Target', playstyle:'Press Proven', group:'Attaquant'}
};

export function ratingOf(v){
  let x = num(v?.rating ?? v?.ratingAve ?? v?.averageRating ?? v?.avgRating ?? v?.ratingAvg ?? v?.roleRating ?? v?.matchRating);
  if(x>10 && x<=100) x/=10;
  if(x>100 && x<=1000) x/=100;
  return x>10 ? 0 : x;
}
export function positionOf(v){
  const x = v?.favoritePosition ?? v?.proPosition ?? v?.proPos ?? v?.positionName ?? v?.position ?? v?.pos ?? '';
  return String(x ?? '');
}
export function archetypeOf(v){
  const id = String(v?.archetypeid ?? v?.archetypeId ?? v?.archetype_id ?? v?.buildId ?? '');
  const a = ARCHETYPES[id] || null;
  return {id, name:a?.name||'', playstyle:a?.playstyle||'', group:a?.group||''};
}
export function stringPlaystyles(v){
  const x = v?.playStyles ?? v?.playstyles ?? v?.playStyleNames ?? v?.equippedPlayStyles ?? v?.traits ?? [];
  const arr = Array.isArray(x) ? x : (typeof x==='string' ? x.split(/[|,;]/) : []);
  return [...new Set(arr.map(z=>String(z).trim()).filter(z=>z && !/^\d+$/.test(z)))].slice(0,10);
}
export function roleBucket(pos){
  const s = String(pos||'').toLowerCase();
  if(!s) return '';
  if(s==='0' || /goal|keeper|gk/.test(s)) return 'GK';
  if(/def|back|cb|lb|rb|lwb|rwb/.test(s)) return 'DEF';
  if(/mid|cm|cdm|cam|lm|rm/.test(s)) return 'MID';
  if(/forw|attack|striker|wing|st|lw|rw|cf/.test(s)) return 'FWD';
  return '';
}
export const signatureFor = id => ARCHETYPES[String(id||'')]?.playstyle || '';
export const archetypeName = id => ARCHETYPES[String(id||'')]?.name || '';
