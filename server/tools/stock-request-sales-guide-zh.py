"""Create a standalone Chinese Sales guide for Delivery and Special orders."""
import base64
import hashlib
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/stock-requests/2026-09-30'
NAME = 'Stock_Request_Sales_Guide_2026-09-30_zh-CN.html'
source = (OUT / 'Stock_Request_User_Manual_2026-09-30_zh-CN.html').read_text()
fragments = {}
for block in source.split('<section class="page ')[1:]:
    key = re.search(r' id="([^"]+)"', block).group(1)
    fragments[key] = block.split('<div class="page-body">', 1)[1].split('</div><footer class="page-footer">', 1)[0]
sections = []


def add(key, title, group, body):
    sections.append({'id': key, 'title': title, 'group': group,
                     'body': body.replace('<h2>', '<h3>').replace('</h2>', '</h3>')})


def reuse(key, title, group):
    add(key, title, group, fragments[key].replace('下一页', '下一节'))


def shot(name, caption, width=600):
    file = OUT / 'sales-guide/screenshots' / (name + '.png')
    data = base64.b64encode(file.read_bytes()).decode()
    label = html.escape(caption, quote=True)
    return f'<figure style="max-width:{width}px"><img src="data:image/png;base64,{data}" alt="{label}" tabindex="0" role="button" aria-label="放大截图：{label}"><figcaption>{label}</figcaption></figure>'


def note(title, text):
    return f'<aside><strong>{title}</strong><p>{text}</p></aside>'


def steps(*items):
    return '<ol class="steps">' + ''.join(f'<li>{item}</li>' for item in items) + '</ol>'


def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{v}</th>' for v in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{v}</td>' for v in row) + '</tr>' for row in rows) + '</tbody></table></div>'


navigation = fragments['navigation'].replace('，或进入 SCM 的库存申请页面', '')
add('navigation', '打开销售库存申请页面', '开始使用', navigation)
reuse('delivery-create', '填写 SO 和选择货场', '常规送货 Delivery')
reuse('delivery-quantities', '核对自动数量和 PALLET', '常规送货 Delivery')
add('delivery-approval', '提交后查看审批结果', '常规送货 Delivery',
    table(['调货路线', '销售提交后的结果'], [
        ('<b>3445 → 2967</b> 或 <b>2967 → 3445</b>', '通过 SO、实际库存及换算检查后，系统自动批准、创建 TO 并排队打印。'),
        ('Base Yard 或 Target Yard 涉及 <b>150</b> 或 <b>12441</b>', '申请显示 <b>Waiting for SCM approval（等待 SCM 审批）</b>。等待审批结果；批准后系统继续创建 TO 并排队打印。')])
    + note('不检查安全库存', '最新常规送货流程<b>不检查安全库存阈值</b>，但仍检查 <b>Target Yard 的可用库存</b>。足够时调拨整行；不足整行时只调拨欠货数量；连欠货也不足时停止提交并显示短缺。')
    + shot('delivery-waiting-sales', '销售视图：Target Yard 为 150，申请等待 SCM 审批。')
    + steps('提交后在原申请中查看 Base Yard、Target Yard、SO 编号、商品数量和审批状态。',
            '需人工审批时等待 SCM 处理；如果被拒绝，先查看原因，再与 SCM 确认后续安排。',
            '已批准但显示错误或需要处理时，打开同一申请并使用重试／查看进度操作。'))
reuse('delivery-progress', '查看 TO、打印状态与重试', '常规送货 Delivery')

reuse('special-header', '新建特殊商品询价', '特殊订单 Special')
reuse('special-items', '填写商品、售价并提交询价', '特殊订单 Special')
reuse('special-quote', '预览报价和包装数量', '特殊订单 Special')
reuse('special-decision', '查看供应商回复并记录客户决定', '特殊订单 Special')
reuse('special-so-account', '选择 SO 客户账户和交付资料', '特殊订单 Special')
create = fragments['special-so-create'].split('<aside class="warning">', 1)[0]
create = create.replace('下一页', '下一节')
add('special-so-create', '保存草稿，再创建或关联 SO', '特殊订单 Special', create
    + note('创建后核对 SO 编号', '等待操作完成并核对保存的 SO 编号及状态。如中断或报错，先查看同一申请中已有的订单和可用恢复操作，再继续处理。'))
add('special-follow', '跟进订单、ETA 和调度', '特殊订单 Special',
    '<p>SO 创建或关联后，销售继续在原申请中跟进 SO／PO、供货及调度状态，并把进度告知客户。</p>'
    + shot('special-orders-sales', '销售视图：查看 SO／PO 编号、PO 批准提示及单独的 Dispatch planning（调度计划）状态。')
    + table(['申请阶段／提示', '销售下一步'], [
        ('<b>New Enquiry</b> · 新询价', '等待 SCM 的供应商回复，留意自己的申请提醒。'),
        ('<b>Await Customer Confirmation</b> · 等待客户确认', '联系客户，逐行记录接受、愿意等待 ETA 或拒绝；保存决定。'),
        ('<b>Confirmed</b> · 已确认', '查看 SO 是否已创建／生效，并跟进 SCM 的 PO 处理及批准状态。'),
        ('<b>Wait for production / Transfer</b> · 等待生产／调货', '核对 ETA 和最新回复，向客户更新进度；实际备好后再安排交付。'),
        ('<b>Dispatch Arrangement</b> · 调度安排', '核对是否已排入计划，确认日期、地址、联系人和交付说明。'),
        ('<b>Completed / Closed</b> · 已完成／已关闭', '查看最终结果、原因及已保存的订单和历史。')])
    + note('向客户确认交付前', '申请处于 Confirmed、SO／PO 已创建或客户已接受 ETA，都不代表已备好或已安排送货。须同时核对供货状态和 <b>Dispatch planning</b>，再确认实际交付安排。'))
reuse('special-fulfillment', '更新交付资料或记录供应商自取', '特殊订单 Special')
add('special-adjustment', '申请订单调整', '特殊订单 Special',
    steps('在原申请中打开 <b>Request an order adjustment（申请订单调整）</b>。',
          '核对并填写已接受商品的新数量、折扣及／或 PALLET 数量；原始售价保持固定。',
          '点击 <b>Request adjustment（提交调整）</b>，等待 SCM 确认。',
          '查看调整结果及更新后的数量。若仍显示待审批或更新未完成，先跟进原申请，再向客户确认最终结果。')
    + shot('special-adjustment-sales', '销售视图：申请把商品从 2 PLT 调整为 3 PLT，并把 PALLET 数量调整为 3。')
    + note('商品包装数量与 PALLET 分别核对', '商品的 PLT／PC 换算与订单单独的 PALLET 行是两项数值。需要审批的调整完成前，订单创建和调度会等待；操作中断时继续跟进原申请。'))
add('special-close', '申请关闭、到期与查看文件', '特殊订单 Special',
    table(['原申请情况', '销售操作'], [
        ('尚未创建 SO 或 PO', '填写关闭原因，点击 <b>Close case（关闭申请）</b>。'),
        ('已有 SO，尚无 PO', '使用 <b>Close SO and case（关闭 SO 及申请）</b>；如操作未完成且出现 <b>Retry SO closure（重试关闭 SO）</b>，继续处理原申请。'),
        ('已有 PO', '填写原因并点击 <b>Request closure · SCM confirmation（申请关闭 · 等待 SCM 确认）</b>，跟进审批及订单关闭结果。'),
        ('按钮不可用／已排计划', '查看页面提示，与 SCM／调度人员协调原申请和现有计划。')])
    + shot('special-close-sales', '销售视图：填写关闭原因并提交，由 SCM 确认已有 SO／PO 的关闭。')
    + '<h3>询价到期</h3><p>询价仅在<b>尚不存在 SO 或 PO</b>时自动到期关闭。字段仍可编辑时，销售可修改到期日并点击 <b>Save expiry（保存到期日）</b>。</p>'
    + '<h3>文件与历史</h3><p>使用可用的报价／SO 预览，核对客户、商品及订单编号，并点击 <b>Download PDF（下载 PDF）</b>。取消或关闭后，原申请及订单处理历史仍用于追溯；以申请显示的最终结果为准。</p>')
add('troubleshooting', '销售常见问题与提交前核对', '日常参考',
    table(['遇到的问题', '销售处理方法'], [
        ('Delivery 的 Base Yard 不正确／读取失败', '核对 SO 所有库存商品行的地点须一致。Base Yard 由商品行地点决定。'),
        ('Delivery 显示短缺', '比较欠货与 Target Yard 可用库存；与 SCM 协调供货，再检查原申请。'),
        ('Delivery 出现 524 或 SO 检查失败', '点击 <b>Retry SO check</b>，无需修改原输入。已提交申请使用 <b>Retry / check progress</b>。'),
        ('按钮全部禁用／正在处理', '查看当前步骤并等待结果；连接中断时系统会重新连接检查同一操作。'),
        ('TO 显示 Print queued', '打印仍在队列中；点击 <b>Refresh print status</b> 查看后续结果。'),
        ('特殊订单 Create in NetSuite 不可点', '选择有效客户账户及销售代表，补齐必填资料，点击 <b>Save SO draft</b>；查看是否有待确认调整。'),
        ('客户不愿等待 ETA', '记录客户真实决定和原因，保存明细决定；只让已接受商品进入 SO。'),
        ('无法修改交付资料或关闭', '查看计划、完成状态及未完成调整，联系 SCM／调度跟进现有申请。'),
        ('错误持续出现', '提供申请号、SO／TO／PO 编号、当前步骤和完整报错，方便检查已保存的结果。')])
    + '<h3>每次提交前</h3><ul><li>送货：核对 <b>Target Yard → Base Yard</b>、SO 商品行地点、欠货、调货数量与 PALLET。</li><li>特殊订单：核对规格、单位、售价、折扣、客户决定、SO 账户及交付资料。</li><li>操作后：核对订单编号、审批／打印／调度状态，再向客户确认进度。</li></ul>')

CSS = '''
:root{--ink:#183b46;--green:#087e74;--line:#dbe8e8;--muted:#58717a;--paper:#fff;--back:#f1f6f6}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:80px}body{margin:0;background:var(--back);color:var(--ink);font:15px/1.75 "Noto Sans CJK SC","WenQuanYi Zen Hei","Microsoft YaHei","PingFang SC",Arial,sans-serif}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible,img:focus-visible{outline:3px solid #efb547;outline-offset:4px}.topbar{position:sticky;top:0;z-index:5;background:#153b46;color:white;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px max(20px,calc((100vw - 1180px)/2))}.brand{font-weight:bold;letter-spacing:2px}.topbar a{color:#c7ede5}.topbar nav{display:flex;gap:18px;align-items:center}.print-button{border:0;border-radius:6px;padding:6px 12px;background:#d9f4e9;color:#143b40}.hero{max-width:1180px;margin:0 auto;padding:42px 22px 25px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--green);font-weight:bold}h1{font-size:36px;line-height:1.3;margin:10px 0 12px}h2{font-size:24px;line-height:1.4;margin:6px 0 20px}h3{font-size:18px;line-height:1.45;margin:26px 0 10px}p{margin:10px 0 16px}.meta,.small{color:var(--muted);font-size:13px}.flow-cards{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px}.flow-card{display:block;background:white;border:1px solid var(--line);border-top:4px solid var(--green);border-radius:10px;padding:20px}.flow-card strong{display:block;font-size:21px;margin-bottom:8px}.flow-card p{color:var(--ink);margin:4px 0}.layout{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:240px minmax(0,1fr);gap:24px;padding:0 22px 40px}.toc{position:sticky;top:83px;align-self:start;max-height:calc(100vh - 103px);overflow:auto;background:white;border:1px solid var(--line);border-radius:10px;padding:14px}.toc summary{font-weight:bold;cursor:pointer}.toc h3{font-size:13px;margin:16px 0 5px;color:var(--green)}.toc a{display:block;font-size:13px;padding:6px 0;color:var(--ink);border-bottom:1px solid #eff4f4}.toc a.is-current{color:var(--green);font-weight:bold}.toc a span{color:var(--green);margin-right:6px}.guide-section{background:white;border:1px solid var(--line);border-radius:12px;margin-bottom:22px;padding:28px 30px;scroll-margin-top:80px}.section-label{font-size:12px;color:var(--green);font-weight:bold;letter-spacing:1px}.lead{font-size:16px}.steps{padding-left:25px}.steps li{padding-left:4px;margin-bottom:13px}.steps li::marker{color:var(--green);font-weight:bold}ul{padding-left:23px}li{margin:8px 0}figure{width:100%;margin:22px auto}figure img{display:block;width:100%;height:auto;border:1px solid #c9dadd;border-radius:6px;cursor:zoom-in}figcaption{font-size:12px;color:var(--muted);line-height:1.6;margin-top:8px}aside{border-left:4px solid var(--green);background:#edf8f4;padding:15px 18px;border-radius:0 8px 8px 0;margin:20px 0;font-size:14px}aside p{margin:5px 0 0}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px;line-height:1.6;margin:18px 0}th{text-align:left;background:#153b46;color:white;padding:12px}td{vertical-align:top;padding:12px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}tr:nth-child(even) td{background:#f2f7f7}table th:first-child{width:31%}.table-wrap{width:100%}.site-footer{max-width:1180px;margin:0 auto;padding:10px 22px 35px;color:var(--muted);font-size:12px}dialog{border:0;border-radius:10px;padding:16px;max-width:96vw;max-height:96vh}dialog::backdrop{background:#092432d9}dialog img{display:block;max-width:90vw;max-height:80vh;object-fit:contain}dialog button{display:block;margin-left:auto;background:var(--green);color:white;border:0;border-radius:5px;padding:7px 14px}dialog p{font-size:13px}.back-top{display:inline-block;padding:8px 0}.toc-mobile-note{display:none}
@media(max-width:800px){.topbar{padding:10px 14px;gap:8px}.topbar nav{gap:12px;font-size:13px}.brand{font-size:13px}.hero{padding:26px 16px 20px}h1{font-size:28px}.flow-cards{grid-template-columns:1fr;gap:12px}.layout{display:block;padding:0 14px 24px}.toc{position:static;max-height:none;margin-bottom:18px}.toc-mobile-note{display:block;font-size:12px;color:var(--muted)}.guide-section{padding:22px 18px}h2{font-size:22px}table{font-size:13px}th,td{padding:9px 7px}table th:first-child{width:35%}.print-button{padding:5px 7px;font-size:12px}.meta{font-size:12px}}
@media print{@page{size:A4;margin:14mm}html{scroll-behavior:auto}body{background:white;font-size:11pt}.topbar,.toc,.back-top,dialog{display:none!important}.hero,.layout{padding:0;max-width:none;display:block}.hero{break-after:page}.guide-section{border:0;border-radius:0;margin:0;padding:0;break-before:page}h1{font-size:26pt}h2{font-size:19pt}h2,h3{break-after:avoid}figure,aside,tr{break-inside:avoid}figure img{cursor:default}a{color:inherit}table{font-size:10pt}.site-footer{padding:12px 0}.flow-card{border:1px solid var(--line)}*{animation:none!important;transition:none!important}}
'''
toc = '<details open class="toc" id="contents"><summary>操作目录</summary><p class="toc-mobile-note">点击下方标题跳转；可收起目录继续阅读。</p>'
last = None
for number, section in enumerate(sections, 1):
    if section['group'] != last:
        toc += '<h3>' + section['group'] + '</h3>'
        last = section['group']
    toc += f'<a href="#{section["id"]}"><span>{number:02}</span>{section["title"]}</a>'
toc += '</details>'
body = ''.join(f'<section class="guide-section" id="{s["id"]}"><div class="section-label">{n:02} · {s["group"]} · 销售</div><h2>{s["title"]}</h2>{s["body"]}<a class="back-top" href="#contents">返回目录 ↑</a></section>' for n, s in enumerate(sections, 1))
SCRIPT = '''
const viewer=document.getElementById('imageViewer');
function zoom(image){viewer.querySelector('img').src=image.src;viewer.querySelector('img').alt=image.alt;viewer.querySelector('p').textContent=image.alt;viewer.showModal();}
document.querySelectorAll('figure img').forEach(image=>{image.addEventListener('click',()=>zoom(image));image.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();zoom(image);}});});
viewer.querySelector('button').addEventListener('click',()=>viewer.close());
viewer.addEventListener('click',event=>{if(event.target===viewer){const r=viewer.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)viewer.close();}});
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){document.querySelectorAll('.toc a').forEach(a=>a.classList.toggle('is-current',a.hash==='#'+entry.target.id));}},{rootMargin:'-80px 0px -65% 0px'});document.querySelectorAll('.guide-section').forEach(section=>observer.observe(section));}
'''
document = '''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="MBBS 销售人员中文操作指南：常规送货 Delivery 与特殊订单 Special。"><title>MBBS 销售操作指南 · 送货与特殊订单</title><style>''' + CSS + '''</style></head><body><header class="topbar"><span class="brand">MBBS · SALES</span><nav aria-label="快速导航"><a href="#delivery-create">送货</a><a href="#special-header">特殊订单</a><button class="print-button" onclick="window.print()">打印</button></nav></header><header class="hero" id="start"><div class="eyebrow">销售人员操作指南 · 简体中文</div><h1>送货与特殊订单</h1><p>从申请、客户确认到订单跟进，按销售人员的下一步操作阅读。</p><div class="meta">更新日期：2026 年 9 月 30 日 · SO＝销售订单 · TO＝调货单 · PO＝采购订单</div><div class="flow-cards"><a class="flow-card" href="#delivery-create"><strong>常规送货 Delivery</strong><p>输入 SO → 核对 Base Yard／Target Yard → 自动计算 → 提交 → 查看 TO 和打印</p></a><a class="flow-card" href="#special-header"><strong>特殊订单 Special</strong><p>提交询价 → 查看供应商回复 → 记录客户决定 → 创建／关联 SO → 跟进交付</p></a></div></header><div class="layout">''' + toc + '<main>' + body + '''</main></div><footer class="site-footer">培训截图使用虚构资料。英文界面按钮配有中文说明；点击截图可放大，按 Esc 可关闭。</footer><dialog id="imageViewer" aria-label="放大截图"><button autofocus>关闭</button><img alt=""><p></p></dialog><script>''' + SCRIPT + '</script></body></html>'
assert len(sections) == 16
assert 'Target Yard → Base Yard' in document and '不检查安全库存阈值' in document
assert all(key not in document for key in ['id="regular-create"', 'id="pickup-search"', 'id="special-po"', 'SCM internal note', 'Confirm adjustment（确认调整）', 'Create PO in NetSuite'])
(OUT / NAME).write_text(document)
(OUT / 'sales-guide-index-zh-CN.json').write_text(json.dumps([{'number': n, 'id': s['id'], 'title': s['title'], 'workflow': s['group'], 'audience': '销售'} for n, s in enumerate(sections, 1)], ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'html': str(OUT / NAME), 'sections': len(sections), 'screenshots': document.count('<figure'), 'bytes': len(document.encode()), 'sha256': hashlib.sha256(document.encode()).hexdigest()}, ensure_ascii=False))
