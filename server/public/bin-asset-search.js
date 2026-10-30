/* Shared native bin selector with search; the selected bin survives filtering. */
/* global Option */
(() => {
  function attach(select) {
    if (!select || select.dataset.binSearch) return;
    select.dataset.binSearch='true';
    const options=[...select.options].filter(option=>!option.value || !option.disabled);
    const placeholder=options.find(option=>!option.value) || new Option('Choose bin','');
    const bins=options.filter(option=>option.value);
    const label=document.createElement('label');label.textContent='Search bins';
    const input=document.createElement('input');input.type='search';input.autocomplete='off';
    input.placeholder='Bin number, size or location';input.disabled=select.matches(':disabled');
    label.append(input);
    const status=document.createElement('p');status.dataset.binSearchStatus='true';status.setAttribute('aria-live','polite');
    select.closest('label').before(label);select.closest('label').after(status);
    function filter() {
      const selected=select.value,terms=input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matches=bins.filter(option=>terms.every(term=>option.textContent.toLowerCase().includes(term)));
      const visible=bins.filter(option=>option.value===selected || matches.includes(option));
      select.replaceChildren(placeholder.cloneNode(true),...visible.map(option=>option.cloneNode(true)));
      select.value=visible.some(option=>option.value===selected)?selected:'';
      status.textContent=matches.length ? `${matches.length} available bin${matches.length===1?'':'s'}${terms.length?' match':''}.`
        : `${bins.length?'No matching bins.':'No available bins.'}${select.value?' Current selection kept.':''}`;
    }
    input.addEventListener('input',filter);
    input.addEventListener('keydown',event=>{if(event.key==='Enter') event.preventDefault();});
    filter();
  }
  window.BinAssetSearch={attach};
})();
