import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../../public/aggregate-requests-i18n.js', import.meta.url), 'utf8');
function formatter(language = 'en') {
  const window = { MBBS_I18N: { language: () => language, message: value => value } };
  vm.runInNewContext(source, { window });
  return window.MBBSAggregateI18n;
}
test('submission timestamps include Toronto weekday, full date, seconds and daylight-saving offset', () => {
  const { dateTime } = formatter();
  const winter = dateTime('2026-01-15T02:03:04Z');
  assert.match(winter, /Wed/);
  assert.match(winter, /Jan 14, 2026/);
  assert.match(winter, /21:03:04 EST \(Toronto\)/);
  const summer = dateTime('2026-09-25T12:03:04Z');
  assert.match(summer, /Fri/);
  assert.match(summer, /Sep 25, 2026/);
  assert.match(summer, /08:03:04 EDT \(Toronto\)/);
  assert.match(dateTime('2026-11-01T05:30:00Z'), /01:30:00 EDT/);
  assert.match(dateTime('2026-11-01T06:30:00Z'), /01:30:00 EST/);
});
test('submission date labels and full timestamps support Chinese and absent timestamps', () => {
  const { dateTime, text } = formatter('zh-CN');
  assert.equal(text('Submitted at'), '提交时间');
  assert.match(dateTime('2026-09-25T12:03:04Z'), /2026年9月25日/);
  assert.match(dateTime('2026-09-25T12:03:04Z'), /08:03:04.*多伦多/);
  for (const value of [null, undefined, '', 'not-a-date']) { assert.equal(dateTime(value), '—'); }
});
