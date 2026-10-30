import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
function extract(file,name) {
  const text=readFileSync(file,"utf8"),start=text.indexOf(`function ${name}(`),end=text.indexOf("\nfunction ",start+1);
  return text.slice(start,end<0 ? undefined : end);
}
test("driver stop identifies only the bin involved in its physical action",()=>{
  const context={window:{DriverBinUI:{requirements:()=>[]}},t:(_key,text)=>text,escapeHtml:String,
    driverBinActionLabel:job=>job.mbt.actionCode,binAssetRoleLabel:String,binEvidenceLabel:String};
  vm.runInNewContext(extract("public/driver.js","renderDriverBinSummary"),context);
  const assets={expected:{assetId:"new",assetCode:"B042"},outgoing:{assetId:"new",assetCode:"B042"},incoming:{assetId:"old",assetCode:"B017"}};
  const collection=context.renderDriverBinSummary({status:"pending",mbt:{actionCode:"pickup_bin",displayReference:"BIN00001X-1C",exactAssets:assets}});
  assert.match(collection,/BIN00001X-1C/);assert.match(collection,/B017/);assert.doesNotMatch(collection,/B042/);
  const delivery=context.renderDriverBinSummary({status:"pending",mbt:{actionCode:"deliver_bin",displayReference:"BIN00001X-1D",exactAssets:assets}});
  assert.match(delivery,/B042/);assert.doesNotMatch(delivery,/B017/);
});


test("Dispatch renders a historical stop's read-only labels without exposing its opaque order ID",()=>{
  const context={binStopLabelsById:new Map([["stop1",{reference:"BIN00001C-DP",assetCode:"B017"}]])};
  vm.runInNewContext(extract("public/dispatch.js","binStopDisplayLabel"),context);
  const label=context.binStopDisplayLabel({id:"stop1",actionCode:"dump_bin",mbt:{visitId:"legacy"}},{id:"opaque-old-order"});
  assert.match(label,/BIN00001C-DP/);assert.match(label,/B017/);assert.doesNotMatch(label,/opaque/);
});
