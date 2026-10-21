import { existing as previous, own as caseEdits } from './special-case-edits-suites.mjs';
export const existing = [...new Set([...previous,...caseEdits])];
export const own = ['test/mbt/unit/special-header-note.test.js','test/mbt/integration/special-header-note-http.test.js','test/mbt/integration/special-header-note-browser.test.js','test/mbt/integration/special-header-note-markup.test.js'];
