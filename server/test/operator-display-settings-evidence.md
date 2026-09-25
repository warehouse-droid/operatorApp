# Operator display settings and PWA units

Implemented and deployed on 2026-09-18. See [deployment verification](operator-display-settings-deployment.md).

## Behaviour

- Operator and driver Chinese displays map PLT to 板, LYR to 层, SEC to 组, and PCS to 件. Other units, English labels, stored codes, and quantity calculations retain their existing behaviour.
- The operator main-menu gear opens account settings with separate general and detail-panel controls for headings, item names, descriptions, labels, and quantities. Font sizes use integer pixels from 8 through 48, with minus/plus controls, colour/HEX controls, and adjacent previews. Spacing supports compact, standard, and spacious, with detail inheritance.
- Save persists through the authenticated account API; Cancel discards edits. Reset restores the original styles and spacing after Save and preserves the device-keyboard choice. Cached preferences are scoped to the authenticated account.
- Device keyboard is off by default for customer-pickup and return order-number inputs. Those inputs stay editable for hardware scanners and switch between `inputmode="none"` and `inputmode="text"`. The on-screen order keypad is always available, including SOB/SOA/SOM prefixes, digits, clear, and backspace. Enter/Tab scanner terminators submit once while a lookup is in progress.
- Large text expands the quantity layout and permits vertical scrolling. Operator and driver service-worker assets have matching new versions.

## Validation

Passed against the current source:

| Check | Result |
| --- | --- |
| `npm run test:operator-display-settings` | 12 tests passed, including UOM preservation, style validation/defaults, keypad edits, pickup regressions, and PWA cache assets |
| `npm run test:operator-display-settings:db` | 4 tests passed with real authentication and PostgreSQL in a disposable database |
| `npm run test:operator-display-settings:browser` | Chromium passed: rendering, save/cancel/reset, account synchronization/isolation, failed save/load recovery, scanner events, keypad touch/caret editing, and driver units |
| Large-font browser layouts | Passed at 1280×800, 1024×768, 768×1024, and 390×844, in both normal and compact lists, including all categories at 48 px |
| `node src/pwa-i18n-harness.js` | Passed, 874 referenced keys |
| `node src/driver-offline-client-harness.js` | Passed |
| Syntax and focused ESLint checks | Passed |
| Fresh database migrations | All 206 migrations passed, including the new preferences table |

Database tests require `MBT_TEST_ISOLATED=1` and a disposable database named `mbt_test`. Browser tests require Playwright Chromium; `DISPLAY_TEST_ARTIFACTS` controls the screenshot directory. The validation run used isolated containers and no production application APIs.

Browser screenshots are in `server/test-artifacts/operator-display-settings/`: `settings.png`, `detail-maximum.png`, `detail-phone.png`, and `return-keypad.png`.

The existing `node src/operator-return-ui-harness.js` fails its assertion “selected return balances must render in two columns.” The same failure was reproduced using the pre-change operator JavaScript, CSS, HTML, and translations. The original operator stylesheet was not changed by this work.

## Deployment and device follow-up

The deployment applied `206_operator_ui_preferences.sql` and released the server and public assets together. The unrelated pending migration 203 was left untouched.

Physical Android and Windows tablet checks remain: with Device keyboard off, scan each order field and verify the OS keyboard stays hidden; then enable it and verify touch typing. Browser automation verifies the editable fields, input modes, scanner key events, and custom keypad, but does not emulate an operating-system keyboard.
