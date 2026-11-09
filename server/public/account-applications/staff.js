import { mountAccountApplications, staffToken } from './manage.js';

const section = location.pathname.split('/')[1];
const headings = { sales: 'Account Applications', mbt: 'MBT Account Applications', mbr: 'MBR Account Applications' };
const root = document.getElementById('aaStaffApp');
if (!staffToken()) location.assign('/?next=' + encodeURIComponent(location.pathname));
else mountAccountApplications(root, { basePath: `/${section}/account-applications`, heading: headings[section] || 'Account Applications' });
