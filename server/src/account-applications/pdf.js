import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { PROVINCES } from '../../public/account-applications/domain.js';

const NATURE_LABELS = { renovation: 'Renovation', landscaping: 'Landscaping' };
const provinceName = (code) => PROVINCES.find(([value]) => value === code)?.[1] || code;
const torontoTime = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', dateStyle: 'medium', timeStyle: 'short' })
  .format(new Date(value));

// The PDF is shared with the staff member who created the application, so it never
// contains card digits or ID-document images; it only records whether they were given.
export function renderApplicationPdf({ number, profile, logo = null, data, signature, submittedAt, attestationText, cardAuthorizationText,
  cardProvided, documents = {} }) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margins: { left: 48, right: 48, top: 44, bottom: 50 }, bufferPages: true,
      info: { Title: `${number} — Customer Account Application`, Author: profile.legalName } });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      document.registerFont('regular', fileURLToPath(new URL('../field-sales/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)));
      document.registerFont('bold', fileURLToPath(new URL('../field-sales/fonts/NotoSansCJKsc-Bold.otf', import.meta.url)));
      const width = 516;
      // Letterhead: company logo (uploaded per company in Application Setup) beside the company details.
      const top = 40, textX = logo ? 228 : 48, textWidth = logo ? 336 : width;
      if (logo) document.image(logo, 48, top, { fit: [165, 62], valign: 'center' });
      document.font('bold').fontSize(15).text(profile.legalName, textX, top, { width: textWidth });
      document.font('regular').fontSize(9).fillColor('#444')
        .text([...(profile.addressLines || []), [profile.phone && `Tel ${profile.phone}`, profile.hstNumber && `HST ${profile.hstNumber}`].filter(Boolean).join(' · ')]
          .filter(Boolean).join('\n'), textX, document.y, { width: textWidth });
      document.y = Math.max(document.y, logo ? top + 66 : document.y);
      document.moveTo(48, document.y + 6).lineTo(564, document.y + 6).strokeColor('#bc1821').lineWidth(1.2).stroke().lineWidth(1);
      document.y += 16;
      document.fillColor('#000');
      document.font('bold').fontSize(13).text('Customer Account Application', 48, document.y, { width });
      document.font('regular').fontSize(9).text(`${number} · Submitted ${torontoTime(submittedAt)} (Toronto)`, 48, document.y, { width });
      document.moveDown(0.6);
      const row = (label, value) => {
        const y = document.y;
        document.font('bold').fontSize(9.5).text(label, 48, y, { width: 150 });
        const labelBottom = document.y;
        document.font('regular').fontSize(9.5).text(value || '—', 205, y, { width: width - 157 });
        document.y = Math.max(document.y, labelBottom) + 3;
      };
      const section = (title) => {
        if (document.y > 650) document.addPage();
        document.moveDown(0.4).font('bold').fontSize(11).text(title, 48, document.y, { width });
        document.moveTo(48, document.y + 1).lineTo(564, document.y + 1).strokeColor('#bbb').stroke();
        document.moveDown(0.4);
      };
      section('Business');
      row('Legal name', data.legalName);
      row('Business trade name', data.tradeName || 'Same as legal name');
      row('Address', `${data.street}\n${data.city}, ${provinceName(data.province)} ${data.postalCode}`);
      row('Phone', data.phone);
      row('Email', data.email);
      row('Nature of business', ['renovation', 'landscaping']
        .map((value) => `[${data.nature.includes(value) ? 'X' : '  '}] ${NATURE_LABELS[value]}`).join('    '));
      section('Documents and payment');
      row('Business card', documents.business_card ? `Provided (${documents.business_card})` : 'Not provided');
      row("Driver's licence", documents.drivers_license ? `Provided (${documents.drivers_license})` : 'Not provided');
      row('Credit card on file', cardProvided ? 'Provided — details are held securely by Accounting' : 'Not provided');
      if (cardProvided && cardAuthorizationText) row('Card authorization', cardAuthorizationText);
      section('Declaration and signature');
      document.font('regular').fontSize(9.5).text(attestationText, 48, document.y, { width, lineGap: 2 });
      document.moveDown(0.6);
      row('Print name', data.signerName);
      row('Title', data.signerTitle);
      row('Date', torontoTime(submittedAt));
      if (document.y > 640) document.addPage();
      document.font('bold').fontSize(9.5).text('Signature', 48, document.y + 4);
      document.image(signature, 48, document.y + 4, { fit: [260, 92] });
      document.rect(48, document.y + 2, 262, 96).strokeColor('#ccc').stroke();
      const pages = document.bufferedPageRange();
      for (let index = 0; index < pages.count; index += 1) {
        document.switchToPage(index);
        document.font('regular').fontSize(8).fillColor('#666')
          .text(`${number} · ${profile.legalName} · ${index + 1}/${pages.count}`, 48, 752, { lineBreak: false });
      }
      document.end();
    } catch (error) { document.destroy(); reject(error); }
  });
}
