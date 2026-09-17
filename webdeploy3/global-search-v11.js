const input=document.querySelector('#globalSearch');
const box=document.querySelector('#suggestions');
if(input&&box){
  let active=-1;
  const options=()=>[...box.querySelectorAll('a.suggestion')];
  const setExpanded=()=>input.setAttribute('aria-expanded',String(!box.hidden));
  const paint=()=>{const list=options();if(active>=list.length)active=list.length-1;list.forEach((a,i)=>{a.setAttribute('role','option');a.setAttribute('aria-selected',String(i===active));a.classList.toggle('search-active',i===active);if(i===active)a.scrollIntoView({block:'nearest'})});setExpanded()};
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls','suggestions');input.setAttribute('aria-expanded','false');box.setAttribute('role','listbox');
  const observer=new MutationObserver(()=>{active=-1;paint()});observer.observe(box,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
  input.addEventListener('input',()=>{active=-1;const q=input.value.trim();if(q.length>=2){box.hidden=false;box.innerHTML='<div class="search-enhanced-loading"><i></i><span>Recherche en cours…</span></div>';setExpanded()}else setExpanded()});
  input.addEventListener('keydown',e=>{const list=options();if(e.key==='ArrowDown'&&list.length){e.preventDefault();active=(active+1+list.length)%list.length;paint()}else if(e.key==='ArrowUp'&&list.length){e.preventDefault();active=(active-1+list.length)%list.length;paint()}else if(e.key==='Enter'&&active>=0&&list[active]){e.preventDefault();list[active].click()}else if(e.key==='Escape'){e.preventDefault();box.hidden=true;active=-1;setExpanded();input.blur()}});
  box.addEventListener('mousemove',e=>{const a=e.target.closest?.('a.suggestion');if(!a)return;const list=options(),i=list.indexOf(a);if(i>=0&&i!==active){active=i;paint()}});
  document.addEventListener('keydown',e=>{const tag=document.activeElement?.tagName?.toLowerCase();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.focus();input.select()}else if(e.key==='/'&&!['input','textarea','select'].includes(tag)){e.preventDefault();input.focus()}});
  const style=document.createElement('style');style.textContent=`
  .suggestions{overflow:auto!important;max-height:min(62vh,520px)!important;overscroll-behavior:contain!important}
  .suggestions:not([hidden])::after{content:'↑ ↓ naviguer  •  Entrée ouvrir  •  Échap fermer';display:block;padding:9px 12px;border-top:1px solid #342340;color:#8f809d;font-size:10px;text-align:center;background:#0d0912;position:sticky;bottom:0}
  .suggestion.search-active{background:linear-gradient(90deg,#2c173d,#20122b)!important;box-shadow:inset 3px 0 0 #b56cff!important;color:#fff!important}
  .search-enhanced-loading{display:flex;align-items:center;gap:10px;padding:16px;color:#b9acc4;font-size:12px}
  .search-enhanced-loading i{width:14px;height:14px;border:2px solid #5d3a74;border-top-color:#c084fc;border-radius:50%;animation:searchSpin .65s linear infinite}
  @keyframes searchSpin{to{transform:rotate(360deg)}}
  @media(max-width:650px){.suggestions:not([hidden])::after{content:'↑ ↓ • Entrée • Échap';font-size:9px}.suggestions{max-height:58vh!important}}
  `;document.head.appendChild(style);paint();
}
