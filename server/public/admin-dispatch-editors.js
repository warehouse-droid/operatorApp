window.AdminDispatchEditors = {
  mount(container, request) {
    if (!container) {return;}
    let editors = [], notice = '';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, character =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    function render() {
      container.innerHTML = `<p role="status">${escape(notice)}</p>
        <div class="actions"><button type="button" data-editor-action="refresh">Refresh editors</button></div>
        <div class="table-scroll"><table><thead><tr><th>Plan date</th><th>Editing user</th><th>Last activity</th><th>Expires</th><th>Action</th></tr></thead>
        <tbody>${editors.map((editor, index) => `<tr><td>${escape(editor.planDate)}</td><td>${escape(editor.operatorName)}</td>
          <td>${escape(new Date(editor.heartbeatAt).toLocaleString())}</td><td>${escape(new Date(editor.expiresAt).toLocaleString())}</td>
          <td><button type="button" data-editor-action="kick" data-editor-index="${index}">Kick out</button></td></tr>`).join('')
          || '<tr><td colspan="5">No one is editing a date plan.</td></tr>'}</tbody></table></div>`;
    }
    async function load() {
      const payload = await request('/api/admin/dispatch-plan-editors');
      editors = payload.editors || [];
      render();
    }
    container.addEventListener('click', async event => {
      const button = event.target.closest('[data-editor-action]');
      if (!button) {return;}
      try {
        if (button.dataset.editorAction === 'refresh') {await load(); return;}
        const selected = editors[Number(button.dataset.editorIndex)];
        if (!selected || !window.confirm(`Kick ${selected.operatorName || 'this user'} out of Edit Mode for ${selected.planDate}? Their editing access will end.`)) {return;}
        button.disabled = true;
        const result = await request('/api/admin/dispatch-plan-editors/kick', {
          method: 'POST', body: JSON.stringify({ planDate: selected.planDate, operatorId: selected.operatorId,
            sessionId: selected.sessionId, acquiredAt: selected.acquiredAt, selectionId: selected.selectionId })
        });
        notice = result.released ? `${selected.operatorName} has been kicked out of Edit Mode.` : 'That user is already out of Edit Mode.';
        await load();
      } catch (error) {
        notice = error.message;
        try {await load();} catch {render();}
      }
    });
    notice = 'Loading date-plan editors…';
    render();
    void load().then(() => { notice = ''; render(); }).catch(error => { notice = error.message; render(); });
  }
};
