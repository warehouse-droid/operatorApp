import assert from 'node:assert/strict';
import test from 'node:test';
import { typeDiagnostics } from '../../tools/special-so-122477-diagnostics.mjs';

test('existing constraint diagnostics survive shifted lines and expanded inferred caller signatures', () => {
  const before = "src/service.js(338,39): error TS2345: Argument of type '{ finder: (id)=>Promise<any> }' is not assignable.\n  Types of property 'findLinkedOrder' are incompatible.\n    Type '() => Promise<any>' is not assignable to type 'null'.\n";
  const after = "src/service.js(328,39): error TS2345: Argument of type '{ finder: (id,{query})=>Promise<any> }' is not assignable.\n  Types of property 'findLinkedOrder' are incompatible.\n    Type '() => Promise<any>' is not assignable to type 'null'.\n";
  assert.deepEqual(typeDiagnostics(after), typeDiagnostics(before));
  assert.notDeepEqual(typeDiagnostics(after.replace("type 'null'", "type 'number'")), typeDiagnostics(before));
  assert.notDeepEqual(typeDiagnostics(after.replace('src/service.js', 'src/new.js')), typeDiagnostics(before));
});

test('new single-line errors, error codes and additional occurrences are preserved', () => {
  const original = 'src/service.js(1,1): error TS2741: locationId is missing.\n';
  assert.notDeepEqual(typeDiagnostics(original.replace('locationId', 'entityId')), typeDiagnostics(original));
  assert.notDeepEqual(typeDiagnostics(original.replace('TS2741', 'TS2345')), typeDiagnostics(original));
  assert.equal(typeDiagnostics(original + original).length, 2);
});
