// Field Sales → Account applications (customer account-application links for any company).
import { mountAccountApplications } from '/account-applications/manage.js';

function ensureStyles() {
  if (document.querySelector('link[data-account-applications-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/account-applications/aa.css?v=20261106-1'; link.dataset.accountApplicationsCss = '';
  document.head.append(link);
}

export async function render(_ctx, view) {
  if (!navigator.onLine) {
    view.innerHTML = '<div class="panel panel-pad stack"><h1>Account applications</h1><p>Connect to the internet to create or check customer account applications.</p></div>';
    return;
  }
  ensureStyles();
  const root = document.createElement('div');
  root.className = 'aa-scope aa-embedded';
  view.replaceChildren(root);
  mountAccountApplications(root, { token: localStorage.getItem('mbbs.staff.token') || '', routing: 'internal', heading: 'Account Applications' });
}
