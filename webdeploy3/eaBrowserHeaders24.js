const originalFetch=globalThis.fetch;

if(typeof originalFetch==='function'&&!globalThis.__FC_EA_FETCH_PATCHED__){
  globalThis.__FC_EA_FETCH_PATCHED__=true;
  globalThis.fetch=async function(input,init={}){
    let url='';
    try{url=typeof input==='string'?input:(input?.url||String(input||''))}catch{}
    if(url.includes('://proclubs.ea.com/')){
      const headers=new Headers(init.headers||{});
      headers.set('accept','application/json');
      headers.set('accept-language','en-US,en;q=0.9,fr;q=0.8');
      headers.set('user-agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
      headers.set('sec-ch-ua','"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"');
      headers.set('sec-ch-ua-mobile','?0');
      headers.set('sec-ch-ua-platform','"Windows"');
      headers.set('sec-fetch-site','same-origin');
      headers.set('sec-fetch-mode','cors');
      headers.set('sec-fetch-dest','empty');
      headers.set('referer','https://proclubs.ea.com/');
      init={...init,headers};
    }
    return originalFetch(input,init);
  };
  console.log('[EA24] browser-like EA request headers enabled globally');
}
