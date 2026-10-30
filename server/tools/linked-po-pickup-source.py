"""Select this task's changes without copying concurrent Driver UI work."""
import re


def candidate_source(server, file, baseline):
    if file == 'public/driver.js':
        anchor = '        <h3>${escapeHtml(order.orderRef)}</h3>\n'
        addition = '''        ${job.stopType === "pickup" && order.poRefs?.length
          ? `<p class="pickup-po-refs"><strong>${t("driver.poRef", "PO Ref")}:</strong> ${order.poRefs.map(escapeHtml).join(", ")}</p>` : ""}
'''
        assert baseline.count(anchor) == 1
        assert addition in (server / file).read_text(), 'PO-reference change missing from workspace'
        return baseline.replace(anchor, anchor + addition)
    if file in ['public/driver.html', 'public/driver-service-worker.js']:
        result, count = re.subn(r'/driver\.js\?v=[^"\s]+', '/driver.js?v=20261028-linked-po-pickup', baseline)
        assert count == 1
        if file.endswith('worker.js'):
            assert '${DRIVER_CACHE_PREFIX}v53' in result and '${DRIVER_CACHE_PREFIX}refresh-v53' in result
            result = result.replace('${DRIVER_CACHE_PREFIX}v53', '${DRIVER_CACHE_PREFIX}v54').replace('${DRIVER_CACHE_PREFIX}refresh-v53', '${DRIVER_CACHE_PREFIX}refresh-v54')
        return result
    return (server / file).read_text()
