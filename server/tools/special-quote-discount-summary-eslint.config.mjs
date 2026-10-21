import base from '../eslint.mbt.config.js';
export default [...base, {
  files: ['src/special-stock-documents.js', 'src/field-sales/company-pdf.js'],
  languageOptions: base[0].languageOptions,
  rules: base[0].rules
}];
