import http from 'node:http';
import {selectedProductHtml,ENDURA_SKU} from './stock-check-fixture.js';

export async function catalogPortal({invalidPickup=false}={}) {
  const requests=[];
  const masters=['endura-coping','beacon-hill-smooth'];
  const products=[
    {sku:ENDURA_SKU,master:masters[0],name:'Endura™ Coping 24x14 Cham Oat Beige',colour:'OAT BEIGE',pickup:'Pickering'},
    {sku:'177ECSF163703-0',master:masters[0],name:'Endura™ Coping 24x14 FN Oat Beige',colour:'OAT BEIGE',pickup:invalidPickup?'Unknown plant':'Pickering'},
    {sku:'0262XL0631907-0',master:masters[1],name:'Beacon Hill™ Smooth XL 6cm Granite Fusion',colour:'GRANITE FUSION',pickup:'Ayr'}
  ];
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      let body=''; for await(const chunk of req) {body+=chunk;}
      const fields=Object.fromEntries(new URLSearchParams(body));
      requests.push({method:req.method,path:url.pathname,query:url.search,fields});
      res.setHeader('Content-Type','text/html; charset=utf-8');
      if(url.pathname==='/SearchDWwithAttributes.aspx') {
        const page=url.searchParams.get('page')==='2'?2:1;
        const master=masters[page-1];
        return res.end(`<html><body><form method="post" action="${url.pathname+url.search}">
          <input type="hidden" name="__VIEWSTATE" value="synthetic-catalog">
          <select id="ctl00_cpholder_itemlist_PageSizectl_dlPageSize" name="ctl00$cpholder$itemlist$PageSizectl$dlPageSize"><option value="20" selected>20</option><option value="200">200</option></select>
          <a href="/products/products/${master}">${master}</a>
          ${page===1?'<a id="catalogPagerNext" href="/SearchDWwithAttributes.aspx?page=2">Next</a>':''}
          </form></body></html>`);
      }
      const master=url.pathname.split('/').pop(),pool=products.filter(row=>row.master===master);
      if(!pool.length) {res.statusCode=404;return res.end('Missing fixture product');}
      const chosen=pool.find(row=>row.sku===url.searchParams.get('child'));
      if(chosen) {
        let html=selectedProductHtml({pickup:chosen.pickup,sku:chosen.sku});
        html=html.replaceAll('Endura™ Coping 24x14 Cham Oat Beige',chosen.name).replaceAll('OAT BEIGE',chosen.colour);
        html=html.replaceAll('ENDURA™ COPING',master==='beacon-hill-smooth'?'BEACON HILL™ SMOOTH':'ENDURA™ COPING');
        return res.end(html);
      }
      const colour1=fields.__EVENTTARGET?.includes('$ctl01$');
      const tiles=req.method==='POST'?(colour1?pool:pool.slice(0,1)):[];
      return res.end(`<html><head><title>Products - Unilock - ${master} - ${master} - MASTER</title></head><body>
        <form method="post" action="/products/products/${master}"><input type="hidden" name="__VIEWSTATE" value="synthetic-product">
        ${[0,1].map(i=>`<a id="ctl00_cpholder_ctl00_rptFinish_ctl00_rptColorF_ctl0${i}_colorFinishId" title="${pool[0].colour}, SMOOTH" href='javascript:__doPostBack("ctl00$cpholder$ctl00$rptFinish$ctl00$rptColorF$ctl0${i}$colorFinishId", "")'>${pool[0].colour}</a>`).join('')}
        ${tiles.map((row,i)=>`<a id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl0${i}_Link" title="${row.sku}"><span id="ctl00_cpholder_ctl00_rptChildShape_ctl00_rptChildItem_ctl0${i}_Label2">${row.name}</span></a>`).join('')}
        </form></body></html>`);
    } catch {
      res.statusCode=500;res.end('Fixture request failed');
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:'http://127.0.0.1:'+server.address().port,requests,products,
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
