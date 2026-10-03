const destinations=[
  ['boss',['boss']],['admin',['admin']],['control',['admin','yard_manager']],
  ['operator',['operator','admin']],['delivery',['operator','admin']],
  ['dispatch',['dispatcher','admin']],['scm',['scm','scm_staff','admin']],
  ['sales',['sales','admin']],['aggregate-requests',['sales','scm','admin']],
  ['field-sales',['field_sales','admin']],['mbt',['mbt_frontdesk','mbt_billing','admin']]
];
export function staffReturnPath(value,roles=[]) {
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x20]/.test(value)){return '';}
  try {
    const url=new URL(value,'https://mbbs.invalid');
    if(url.origin!=='https://mbbs.invalid'){return '';}
    const destination=destinations.find(([name])=>url.pathname===`/${name}`||url.pathname===`/${name}.html`||url.pathname.startsWith(`/${name}/`));
    return destination&&destination[1].some(role=>roles.includes(role))?url.pathname+url.search+url.hash:'';
  }catch{return '';}
}
