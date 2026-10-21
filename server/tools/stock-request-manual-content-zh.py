"""Build the Simplified Chinese edition without rewriting the English manual."""
from pathlib import Path
import ast, base64, html, json

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/stock-requests/2026-09-30'
pages = []

def shot(name, caption, width=None):
    data = base64.b64encode((OUT/'screenshots'/(name+'.png')).read_bytes()).decode()
    style = f' style="max-width:{width}px"' if width else ''
    return f'<figure{style}><img src="data:image/png;base64,{data}" alt="{html.escape(caption, quote=True)}" tabindex="0" role="button" aria-label="放大截图：{html.escape(caption, quote=True)}"><figcaption>{caption}</figcaption></figure>'

def note(title, text, kind='tip'):
    return f'<aside class="{kind}"><strong>{title}</strong><p>{text}</p></aside>'

def steps(*items):
    return '<ol class="steps">'+''.join(f'<li>{item}</li>' for item in items)+'</ol>'

def table(headers, rows, cls=''):
    return f'<table class="{cls}"><thead><tr>'+''.join(f'<th>{v}</th>' for v in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join(f'<td>{v}</td>' for v in row)+'</tr>' for row in rows)+'</tbody></table>'

def page(key, section, title, role, content, extra=''):
    pages.append({'id':key,'section':section,'title':title,'role':role,'content':content,'extra':extra})

page('start','用户手册','库存申请','销售 + SCM', '''
<div class="cover-intro"><p class="eyebrow">MBBS · OPERATOR APP</p><h1>库存申请</h1><p class="cover-subtitle">销售与 SCM<br>操作指南</p><p class="cover-description">涵盖常规跨货场库存申请及特殊商品供应商询价，从提交申请到查询最终订单处理结果。</p></div>
<div class="cover-routes"><article><span class="route-letter">R</span><h2>常规库存申请</h2><p><b>送货：</b>输入 SO → 自动计算 → 按货场审批 → 生成及打印 TO</p><p><b>自取：</b>预先批准 → 销售填写 SO → 确认处理方式</p><p><b>备货：</b>SCM 审核 → 调整商品及数量 → 直接生成 TO</p></article><article><span class="route-letter">S</span><h2>特殊库存申请</h2><p>由 SCM 向供应商确认客户所需的特殊商品。</p><p>供应商回复 → 客户决定 → SO → PO → 备货及交付</p></article></div>
<div class="cover-meta"><b>更新日期：2026 年 9 月 30 日</b><p>简体中文版 · 已更新送货、数量计算、打印、重试及 TO 备注说明</p></div>
''' + note('截图与按钮名称', '截图使用已部署的应用界面及虚构的培训客户、商品、数量和订单编号，展示不同流程状态，并非真实订单。截图保留英文界面；正文提供中文说明及对应英文按钮名。可用按钮取决于角色和申请状态。') + '<p class="small">HTML 版可点击截图放大，目录链接可直接跳转。PDF 版按 A4 纸张排版，可直接打印。</p>', 'cover')

page('contents','开始使用','选择正确的申请流程','销售 + SCM', '<p class="lead"><b>送货 Delivery</b>使用 SO 自动计算调货；<b>自取 Pickup</b>先批准再关联 SO；<b>备货 Stocking</b>由 SCM 审核后直接生成 TO。</p>' + table(['业务需求','选择','后续流程'],[
 ('需要其他货场的现货，并安排送货','<b>常规 Regular → 送货 Delivery</b>','输入 SO；核对 Base Yard 和 Target Yard → 自动计算数量 → 按路线审批、生成 TO 并排队打印。'),
 ('客户需要其他货场的现货并选择自取','<b>常规 Regular → 自取 Pickup</b>','预先批准 → 销售填写 SO → 确认处理方式；无需最短提前时间。'),
 ('为销售货场备货，需直接调货','<b>常规 Regular → 备货 Stocking</b>','必须由 SCM 审核、调整商品后直接生成 TO；无需销售提供 SO。'),
 ('需向供应商采购或按特定规格询价','<b>特殊 Special</b>','SCM 确认供应商供货，销售记录客户决定，再进入 SO／PO 流程。')]) + '<h2>目录</h2><div class="toc">{{TOC}}</div>' + '<p class="small"><b>SO</b>：销售订单；<b>PO</b>：采购订单；<b>TO</b>：调货单；<b>ETA</b>：预计可供货日期；<b>SCM</b>：供应链管理。</p>')

page('navigation','开始使用','打开申请并查找待办事项','销售 + SCM', '<p class="lead">在销售菜单中打开 <b>Request Stock（库存申请）</b>，或进入 SCM 的库存申请页面。通过 <b>Special / Regular</b> 切换特殊与常规申请。</p>' + shot('01-navigation','销售页面：申请类型、提醒、筛选条件、申请列表及右侧详情。') + steps(
 '选择申请类型和队列／阶段；使用搜索、货场及供应商筛选缩小范围。',
 '点击申请卡片，在右侧查看详情、状态及下一步可执行的操作。需要更新时点击 <b>Refresh（刷新）</b>。',
 '查看顶部提醒。常规申请审批结果和特殊申请流程提醒分别显示；特殊申请中的 <b>My requests（我的申请）</b> 只显示自己的申请。') + note('调整阅读大小', '特殊申请详情提供 <b>−</b>、<b>+</b> 和 <b>Reset（重置）</b> 字号按钮，设置会保存在当前浏览器中。页面同时提供英文和中文选项。'))

page('delivery-create','常规申请 · 送货','送货：输入 SO 与选择货场','销售', steps(
 '打开 <b>Regular（常规）→ New request（新申请）</b>，选择 <b>Delivery（送货）</b>。',
 '输入已保存的 <b>Sales Order number（销售订单号）</b>。系统读取 SO 库存商品行的地点，自动显示 <b>Base Yard（基础货场）</b>；此字段不能手动修改。',
 '选择供货的 <b>Target Yard（目标货场）</b>。等待系统自动计算商品数量和 PALLET，核对后点击 <b>Submit request（提交申请）</b>。') + shot('30-delivery-form','培训示例：Base Yard 为 2967，Target Yard 为 3445，自动计算调货 200 SQFT 和 2 PALLET。',575) + note('调货方向：Target Yard → Base Yard', '本流程的 <b>Target Yard 是 TO 的 From Location（发货地点）</b>；<b>Base Yard 是 TO 的 To Location（收货地点）</b>。例如上图实际为 <b>3445 → 2967</b>。') + '<p class="small">SO 的所有库存商品行必须属于同一个支持的 Base Yard，且该货场须在你的权限范围内。仅 SO 抬头地点一致并不足够。两个货场不能相同；送货申请无需填写到达日期／时间或手动添加商品数量。</p>')

page('delivery-quantities','常规申请 · 送货','送货：核对数量与 PALLET','销售 + SCM', '<p class="lead">只选择 Base Yard 中<b>有欠货（Backorder）</b>的 SO 库存商品行。没有欠货的行不调拨；整张 SO 均无欠货时，无需提交调货申请。</p>' + table(['Target Yard 可用库存','调货数量','界面结果'],[
 ('足够供应该行全部 SO 数量','调拨<b>整行数量</b>','Whole SO line（整行数量）'),
 ('不足整行，但足够供应欠货数量','只调拨<b>欠货数量</b>','Backorder quantity（欠货数量）'),
 ('连欠货数量也不足','<b>停止提交</b>','显示短缺商品、欠货数量及可用库存')]) + '<h2>示例：SO 整行 200 SQFT，欠货 150 SQFT</h2>' + table(['Target Yard 可用数量','结果'],[
 ('200 SQFT 或更多','调拨 200 SQFT。'),('199 SQFT','调拨 150 SQFT。'),('149 SQFT','欠货需求仍差 1 SQFT，阻止提交并显示短缺。')]) + '<p>同一商品出现在多行时，所有行共用一份可用库存。系统先保证各行欠货数量，再按 SO 行顺序判断哪些行可升级为整行调拨。</p>' + '<h2>PALLET 自动计算</h2><p>系统按<b>最终调货数量</b>及商品的每托盘换算计算 PALLET：先合计同一商品的调货数量，除以每托盘数量并向上取整，再把不同商品的托盘数相加。</p>' + table(['换算示例','PALLET 结果'],[
 ('商品 A 每托盘 100 SQFT，调拨 150 或 200 SQFT','2 PALLET'),
 ('同一商品 A 分两行各调拨 50 SQFT','先合计 100 SQFT，再算 1 PALLET')]) + note('以建立 TO 前的重新检查为准', '建立 TO 前会再次核对 SO、库存和数量。SO 上原有的 PALLET、折扣、小计及送货费不作为本次库存商品行。缺少商品托盘换算资料时会停止处理，须先补齐资料再重试。'))

page('delivery-approval','常规申请 · 送货','送货：自动或人工审批','销售 + SCM', table(['调货路线／涉及货场','处理方式'],[
 ('<b>3445 → 2967</b> 或 <b>2967 → 3445</b>','通过 SO、库存及换算检查后，自动批准、建立 TO，并加入货场打印队列。'),
 ('Base Yard 或 Target Yard 涉及 <b>150</b> 或 <b>12441</b>','提交后等待 SCM 人工审批；批准后继续建立 TO 并排队打印。')]) + '<p>SCM 打开待审送货申请，核对 Base Yard、Target Yard、SO 编号及自动计算数量，点击 <b>Approve and create TO（批准并建立调货单）</b>，再确认决定；如拒绝，点击 <b>Reject（拒绝）</b> 并填写原因。</p>' + shot('30-delivery-scm','培训示例：Target Yard 为 150，因此整份送货申请等待 SCM 审批。',520) + note('送货按整份申请审核', '商品和数量来自 SO 及实时库存计算；SCM 审核整份送货申请。新送货流程不使用自取的安全库存预先批准、SO 关联有效期或旧送货提前时间规则。') + '<p class="small">批准后若库存或 SO 有变化，系统可能要求处理短缺或重新检查。查看原申请上的错误和重试操作。</p>')

page('delivery-progress','常规申请 · 送货','送货：进度、打印与重试','销售 + SCM', '<p>处理期间，页面显示当前步骤：<b>检查 SO 数量和 Base Yard → 检查 Target Yard 库存 → 计算数量与 PALLET → 创建／批准 TO → 准备拣货单 → 加入打印队列</b>。按钮和输入框会暂时禁用，请等待结果；连接中断时会重新连接。</p>' + shot('30-delivery-busy','状态提示显示系统正在做什么；处理中的操作按钮不可重复点击。',370) + '<h2>失败后怎样继续</h2><ul><li>检查 SO 失败（包括 524 报错）：点击 <b>Retry SO check（重新检查销售订单）</b>，无需先更改 SO 编号。</li><li>已提交申请需要继续：打开<b>同一份申请</b>，点击 <b>Retry / check progress（重试 / 查看进度）</b>。系统继续检查已保存的工作，复用已有 TO，避免重复建立订单。</li></ul>' + shot('30-delivery-retry','SO 检查失败后，点击 Retry SO check 可重试原有输入。',580) + '<h2>检查结果与打印状态</h2>' + shot('30-delivery-result','TO 已建立，打印已排队；可点击 Refresh print status（刷新打印状态）查看后续状态。',580) + '<p class="small"><b>Print queued</b>＝已排队；<b>Printing TO</b>＝正在打印；<b>Printed</b>＝打印代理已报告完成。打印需处理时检查货场打印机／代理及原申请状态，避免另建申请。</p>' + note('TO Memo（备注）＝SO 编号', '新送货 TO 的备注仅为对应的 SO 编号，例如 <b>SOB121732</b>，不附加其他文字。'))

page('regular-create','常规申请 · 自取／备货','提交自取或备货申请','销售', steps(
 '选择 <b>Regular（常规）</b>，点击 <b>New request（新申请）</b>。确认 <b>Your destination yard（目标货场）</b>，必须是你有权使用的货场。',
 '客户名称为选填。选择 <b>Pickup（自取）或 Stocking（备货）</b>，均无需填写到达日期及时间。送货操作请参阅<a href="#delivery-create">“送货：输入 SO 与选择货场”</a>。',
 '搜索商品，在 <b>Request from yard（来源货场）</b> 中选择供货货场并输入数量。使用可用的 PLT／LYR／SEC／PCS 换算字段；如无包装换算，则使用销售数量字段。',
 '需要多种商品时点击 <b>Add another line（添加一行）</b>，填写备注后点击 <b>Submit request（提交申请）</b>，查看系统给出的审批方式。') + shot('02-regular-form','示例：为目标货场 2967 向 3445 申请 2 PLT × 100 SQFT，即 200 平方英尺。',580) + note('按正确单位查看可用库存', '货场卡片显示销售数量及包装换算。<b>Live − reserved</b> 表示实时数量减去已预留数量后的可申请库存。批准申请本身不会占用库存；NetSuite 在处理 SO 或 TO 时进行库存占用。') + '<p class="small">在首次审批决定前，如按钮仍可用，可点击 <b>Edit request（修改申请）</b> 或 <b>Cancel request（取消申请）</b>。</p>')

page('regular-rules','常规申请 · 自取／备货','自取自动审批与备货审核','销售 + SCM', '<p class="lead"><b>自取（Pickup）</b>沿用预先批准流程；<b>备货（Stocking）</b>始终需要 SCM 人工审核。送货的路线审批规则见<a href="#delivery-approval">送货审批说明</a>。</p>' + steps(
 '自动审批开关已开启。自取无需最短提前时间。',
 '每个来源货场的每种申请商品，在扣除本次发货数量后，剩余可用库存不低于安全库存。',
 '同一商品、同一来源货场的多行数量合并检查；缺少所需策略或库存数据时交由 SCM 审核。') + table(['可用库存','安全库存','申请数量','发货后剩余','自取库存检查'],[
 ('1,000','800','200','800','通过：等于安全库存也允许'),('1,000','800','201','799','人工审核：低于安全库存 1')]) + note('备货始终需要 SCM 审核', '需要 SCM 直接生成 TO 时请选择 Stocking（备货）。即使库存充足，备货也必须人工审核。') + '<h2>自取批准有效期</h2><p>所有明细审核完成后，按申请记录的有效期开始计时。销售须在有效期内填写 SO 并确认处理方式；尚未使用的批准过期后，可重新发起评估。</p>' + '<h2>SCM 设置</h2><p>获授权用户可在 <b>Smart SCM → Settings</b> 调整自动审批开关和批准有效期，再点击 <b>Save settings（保存设置）</b>。以申请记录及当前配置为准；本手册截图的自取有效期示例为 15 分钟。</p>' + note('新送货流程使用独立规则', '新送货申请按货场路线审批并在建立 TO 前检查实际可用库存，不套用本页的自取安全库存、批准倒计时或旧送货提前时间配置。'))

page('regular-safety','常规申请 · 自取','查看审核原因和每行安全库存','SCM', '<p>在人工审核队列打开申请，先阅读 <b>Why SCM review is required（需要 SCM 审核的原因）</b> 和每行库存数据，再作出决定。</p>' + shot('03-regular-scm','申请 201 SQFT 后只剩 799 SQFT，安全库存要求为 800 SQFT；每行清楚显示短缺数量。',620) + '<p class="small">执行前可点击 <b>Refresh stock evidence（刷新库存数据）</b>。检查同一商品／来源货场所有匹配行的申请总量，而不是只看单行数量。</p>')

page('regular-decisions','常规申请 · 自取','审批明细并管理优先补货','SCM', steps(
 '选择要处理的可操作行，核对来源货场、数量及库存数据。如修改明细，先点击 <b>Save line adjustment（保存明细调整）</b>，再进行审批。',
 '选择下面两种批准方式之一，或拒绝所选／全部可操作行。拒绝必须填写原因；批准时可填写说明。',
 '完成全部明细的决定。人工批准或拒绝会提醒销售；自取须等所有明细决定完成后才可处理 SO。') + table(['操作','结果'],[
 ('<b>Approve · TO / location change</b><br>批准：TO／更改地点','获批的自取商品由销售进入 SO 处理方式预览及确认。'),
 ('<b>Approve · source replenishment PO</b><br>批准：来源货场补货 PO','使用相同的自取 SO 流程，同时在 Smart SCM 为对应商品／来源货场增加优先补货需求。'),
 ('<b>Reject selected / Reject all actionable</b><br>拒绝所选／全部可操作行','被拒绝的商品不继续处理。全部可操作行均被拒绝时，该申请的库存处理流程结束。')]) + note('备货使用专用操作', '备货申请使用 <b>Convert to TO（转换为调货单）</b>，由 SCM 审核后直接生成 TO。详见<a href="#pickup-search">备货转换操作</a>。') + '<h2>优先补货需求</h2>' + shot('24-regular-priority','Smart SCM → PO / TO proposals：库存申请补货需求在顶部突出显示。') + '<p>优先需求会保留到后续每次建议计划，包括已暂停的商品，直到 SCM 明确点击 <b>Release（释放）</b>。补货量按当前库存状况及目标计算，可能不同于原申请数量，需以建议计划为准。</p>' + note('Release 的含义', '释放只结束优先需求的持续保留，不会取消已经创建的 PO。'))

page('regular-location','常规申请 · 自取','关联 SO 并确认更改地点','销售', steps(
 '自取申请获批后，先在<b>自己的销售货场</b>创建并保存 SO；库存商品行须仍在该货场，且保持未关闭、未履行状态。',
 '在批准有效期内输入 SO 编号，点击 <b>Review SO routing（查看 SO 处理方式）</b>。如出现 <b>Select SO line</b>，选择正确匹配的 SO 行后再次查看。',
 '阅读确认弹窗。如果 SO 全部库存商品均由本次批准覆盖，且来自同一货场，系统会建议把 SO 地点改到该来源货场。',
 '确认后执行显示的地点变更；点击 <b>Cancel（取消）</b> 则不执行。') + shot('04-regular-so','自取申请批准后，销售输入在自己货场创建的 SO 编号。') + shot('05-regular-location-dialog','单一来源示例：确认把 SO 地点从 2967 更改为 3445。',440) + note('PALLET 及其他附属行', '判断处理方式时，PALLET、折扣、小计及送货费不算作申请库存，不会仅因这些行而生成 TO。更改地点时，也会按适用规则处理 SO 上的附属行。'))

page('regular-transfer','常规申请 · 自取','自取：哪些情况会生成调货单','销售 + SCM', '<p class="lead">已批准库存来自多个货场，或 SO 还包含本次批准范围外的其他库存商品时，系统会建议把获批库存通过 TO 调往销售货场。</p>' + shot('06-regular-to-dialog','多个来源货场时，确认前逐一核对“来源 → 目标”调货路线。',430) + table(['SO 与申请情况','预计处理方式'],[
 ('SO 全部库存商品获批从 3445 供货；销售货场为 2967','SO 地点更改为 3445。'),
 ('获批商品分别来自 3445 和 150；销售货场为 2967','从各来源货场分别创建 TO 到 2967。'),
 ('SO 部分库存商品已在 2967，另有获批商品来自 3445','将获批商品从 3445 调往 2967。'),
 ('SO 另有 PALLET、折扣、小计或送货费','这些附属行本身不改变库存处理方式。')]) + '<h2>两行批准、一行拒绝时如何处理</h2><p>先完成三行的决定，只有获批数量可使用该申请。如果 SO 仍包含第三种库存商品，该商品不属于本次批准，系统会为获批商品采用调货流程。如果 SO 只包含来自同一货场的两种获批商品，则可能采用更改地点流程。</p>' + note('数量必须匹配，SO 不可重复使用', 'SO 必须与获批库存的数量及单位匹配。例如，<b>批准 760 EACH，SO 却为 912 EACH</b>，系统会拒绝并指出商品及数量差异。应修正 SO，或按实际需要重新获得批准。已被另一份常规申请使用的 SO 不能重复使用。'))

page('regular-expiry','常规申请 · 自取','等待、重试及查询处理结果','销售 + SCM', '<div class="two-cols"><div>' + shot('04b-regular-busy','等待 NetSuite 时显示处理状态，并禁用操作按钮。') + '</div><div><h2>处理过程中</h2><p>等待弹窗会说明正在执行的操作。按钮暂时禁用以避免重复提交，请等待结果。</p><p>如果操作需要处理或重试，请重新打开同一份申请并使用可用的重试操作。已启动的操作可继续处理已保存的工作，不要另外创建申请重复执行。</p></div></div>' + '<h2>尚未使用的自取批准已过期</h2>' + shot('07-regular-expired','销售可重新发起已过期的批准，进行新的评估。') + steps(
 '打开过期申请，点击 <b>Re-raise request（重新发起申请）</b>。',
 '查看重新评估结果。系统按当前规则及库存数据重新检查原获批商品。',
 '按新的批准继续操作；此前被拒绝的商品不会自动重新开放。') + '<h2>完成后仍可查看什么</h2><p>申请保留已确认的操作、涉及的地点或 TO 编号、最终数量和完成信息。已完成申请的库存数据保留为当时的快照，不会再用今天的库存扣减一次历史申请量。</p>' + note('安全库存是判断阈值', '关闭 SO 本身不会改变安全库存要求。当前可用库存可能变化，但已完成申请保留历史审核数据。已生成 TO 也不代表实物调货或送货已经完成。'))

page('pickup-search','常规申请 · 备货','SCM 打开转换窗口并添加商品','SCM', '<p class="lead">所有<b>备货（Stocking）</b>申请必须由 SCM 审核。SCM 直接创建 TO，销售无需填写 SO，也无需确认 SO 处理方式弹窗。</p>' + steps(
 '打开备货申请并点击 <b>Convert to TO（转换为调货单）</b>，编辑器会显示可处理的商品。',
 '调整各行来源货场和数量，核对按销售单位换算出的调货数量。',
 '如需增加商品，在 <b>Add an item（添加商品）</b> 输入商品编号或描述，从自动补全列表中选择匹配项。原申请中不应继续处理的行，应先拒绝再转换。') + shot('08-pickup-autocomplete','SCM 将 2 PLT 改为 1 PLT + 8 LYR（180 SQFT），并搜索要增加的墙帽商品。',645))

page('pickup-quantities','常规申请 · 备货','核对最终数量和托盘数量','SCM', '<p>逐一核对原商品及新增商品。为<b>每条 TO 路线设置 PALLET 数量</b>；有换算资料时，系统会提供建议数量，可按实际装载需要调整。</p>' + shot('09-pickup-editor','示例最终增加 10 PC，并为 3445 → 2967 设置 2 PALLET。确认无误后点击 Review and convert to TO（检查并转换为 TO）。',655) + '<p class="small">每个来源货场生成一张 TO，目标始终是申请所属的销售货场。转换一旦开始，应使用已保存的重试流程，不能再任意修改已开始执行的方案。</p>')

page('pickup-confirm','常规申请 · 备货','确认生成 TO 并检查结果','SCM + 销售', '<p>SCM 点击 <b>Review and convert to TO（检查并转换为 TO）</b> 后，系统刷新库存数据，并在居中的确认弹窗显示路线、数量、托盘及安全库存情况。</p>' + shot('09b-pickup-confirm','点击 Confirm and issue TO（确认并生成 TO）创建显示的调货单；点击 Cancel 则返回而不生成。',410) + '<p>等待 NetSuite 完成处理。申请会保存调整后的商品和 TO 编号，销售与 SCM 均可查看实际执行了什么。</p>' + shot('09c-pickup-history','已保存的备货转换结果，包括最终商品数量、路线、TO 编号及完成时间。') + note('需要重试时继续使用同一申请', '重试会继续尚未完成的转换，并保留已经生成的 TO。备货转换不使用销售关联 SO 的批准到期倒计时。'))

page('special-header','特殊申请 · 销售','新建特殊商品询价','销售', '<p class="lead">Special 用于按商品规格向供应商询价。一份申请可包含同一供应商的多种商品。</p>' + steps(
 '点击 <b>New Special case（新建特殊申请）</b>，选择询价门店、询价日期及 <b>NetSuite Sales Rep（销售代表）</b>。',
 '输入客户和供应商，已有目录记录时使用搜索建议；询价阶段也可先手动填写名称。核对客户电话和备注。',
 '设置到期日并选择交付方式。默认到期日通常为询价日期后一个日历月。') + shot('10-special-new-header','申请抬头记录询价客户、供应商、销售代表及到期日。') + table(['特殊申请交付方式','含义'],[
 ('<b>Customer pickup at vendor yard</b><br>客户到供应商货场自取','客户直接到供应商处提货，SCM 确认具体提货地点。'),
 ('<b>Pickup at inquired yard</b><br>在询价门店／货场自取','安排货物到询价货场后，客户再到该处提货。'),
 ('<b>Delivery</b><br>送货','填写送货地址，以及适用的日期、时间段和说明。')]) + note('询价客户与 SO 客户账户', '原询价客户会一直保留在申请中。创建 SO 时须选择实际的 NetSuite 客户／结算账户，该账户可以与询价联系人不同。'))

page('special-items','特殊申请 · 销售','填写商品、价格并提交询价','销售', steps(
 '填写商品名称、颜色、尺寸及详细规格，使 SCM 能准确向供应商核对。',
 '填写数量、销售单位和单位售价。如有折扣，输入折扣百分比并核对税前小计。',
 '填写需求日期、明细备注和包装数量。同一供应商有多种商品时，点击 <b>Add line（添加一行）</b>。',
 '点击 <b>Preview quote（预览报价）</b> 检查客户文件，再点击 <b>Submit to SCM（提交给 SCM）</b>。仅预览并不等于已提交。') + shot('11-special-new-item','商品规格、销售定价、需求日期及包装资料。') + '<h2>价格示例</h2><p><b>2 PLT × $520 ×（1 − 5%）= 税前 $988。</b> 此数额仅为商品小计，托盘费或送货费在 SO 阶段另行添加。</p>' + note('日期和包装', '应用的送货规则要求至少为 <b>SO 创建后的三个工作日</b>，不计周末及应用日历中的安大略省公共假日。如果 SO 创建较晚，期望送货日期也可能需要后移。务必核对单位及包装换算；例如 2 PLT 与 40 PC 可能表示同一商品数量。') + '<p class="small">已保存申请在适用阶段提供文件预览，可在预览窗口点击 <b>Download PDF（下载 PDF）</b> 保存副本。</p>')

page('special-quote','特殊申请 · 销售 + SCM','预览报价及包装数量','销售 + SCM', steps('提交前点击 <b>Preview quote（预览报价）</b>；已保存且尚未建立 SO 时，点击 <b>Preview saved quote（预览已保存报价）</b>。', '核对客户、销售代表、商品说明、销售数量、单价、折扣和总额。', '包装栏按 NetSuite 示例排列：<b>PLT · SEC · LYR · PCS</b>，分别显示已填写的托盘、节、层和件数量，不改变销售金额计算。') + shot('11b-special-quote','特殊申请报价示例：包装数量独立显示，销售定价保持原有计算方式。',450) + '<p class="small">点击 <b>Download PDF（下载 PDF）</b> 保存副本。建立 SO 后，请使用订单预览。</p>')

page('special-check','特殊申请 · SCM','记录供应商供货回复','SCM', steps(
 '打开 <b>New Enquiry（新询价）</b> 阶段的特殊申请，逐项向供应商确认供货。',
 '设置供货状态，核对供应商和提货地点。如需等待，填写预计可供货日期 ETA。',
 '将需要告知客户的信息写入 <b>Sales-visible reply（销售可见回复）</b>；采购内部说明写入 <b>SCM internal note（SCM 内部备注）</b>。',
 '点击 <b>Save stock check（保存供货检查）</b>，将回复提供给销售。') + shot('12-special-scm-stock','SCM 正填写等待生产的回复，包含 ETA 和销售可见说明。') + table(['供货状态','需要记录'],[
 ('<b>In stock</b> · 有现货','确认可供应的商品及供应商提货地点。'),
 ('<b>Wait For Production</b> · 等待生产','填写预计日期，并说明生产等待情况。'),
 ('<b>Wait for Transfer</b> · 等待调货','填写预计日期，并说明调货等待情况。'),
 ('<b>No stock or ETA</b> · 无库存／无到货日期','说明无法供货情况；无可用日期且无库存的商品不能由销售确认接受。')]) + '<p class="small">SCM 内部备注不会显示给销售。影响客户决定的信息应写在销售可见回复中。</p>')

page('special-decision','特殊申请 · 销售','记录客户决定','销售', '<p>申请进入 <b>Await Customer Confirmation（等待客户确认）</b> 后，查看供应商回复，并与客户确认商品、数量及时间安排。</p>' + shot('13-special-customer-decision','客户同意等待生产 ETA，决定与客户备注一起保存。') + steps(
 '有现货时选择 <b>Customer confirms（客户确认）</b>；未来有明确供货日期时，须经客户同意后选择 <b>Customer will wait for ETA（客户愿意等待）</b>。',
 '客户不继续购买时，选择拒绝选项并填写原因；需要时补充客户备注。',
 '点击 <b>Save customer decisions（保存客户决定）</b>，全部明细完成决定后再创建 SO。',
 '只有已接受的商品进入 SO 草稿，被拒绝的商品仍保留在原询价记录中。') + note('ETA 不等于已经可以提货', '客户接受 ETA 后可继续订单流程，但实际提货或调度前，仍须由 SCM 确认商品已经备好。') + '<h2>PO 创建后供应商回复发生变化</h2><p>如果 PO 创建后供应商更改供货信息，可能需要销售记录客户知悉结果。查看变化、联系客户并在申请中保存确认。该供应商回复不会自动改写已有 SO、PO 或调度安排。</p>')

page('special-so-account','特殊申请 · 销售','准备 SO 客户账户及交付信息','销售', '<p class="lead">客户决定完成后，在 <b>Create or link Sales Order（创建或关联销售订单）</b> 中处理已接受商品。</p>' + shot('14a-special-so-account','选择 NetSuite 客户账户及销售代表，再核对业务货场和送货资料。') + steps(
 '从搜索建议中选择有效的 <b>NetSuite customer account（客户账户）</b>；仅填写询价客户名称并不等于已选定 SO 账户。',
 '确认 <b>NetSuite Sales Rep（销售代表）</b> 和 <b>Operational yard（业务货场）</b>。',
 '核对交付方式。如为送货，检查地址、期望日期、时间段、联系人及送货说明。',
 '需要时上传送货现场照片或视频，再按下一页检查商品及收费明细。') + note('确保联系信息可用于实际交付', '填写能联系到的联系人和明确的送货说明。即使 SO 使用另一个贸易账户，原询价客户仍会显示在申请上。'))

page('special-so-create','特殊申请 · 销售','先保存草稿，再创建或关联 SO','销售', shot('14b-special-so-items','已接受商品、PALLET 费用、附属收费项，以及创建／关联 SO 的操作。') + steps(
 '核对商品描述、数量、固定原始售价、折扣及换算后的 NetSuite 数量。填写 <b>Pallets needed（所需托盘数）</b>；0 表示不添加 PALLET，数量大于 0 时必须填写托盘单价。',
 '通过 <b>Add ancillary item（添加附属项）</b> 增加送货费或其他适用收费，点击 <b>Save SO draft（保存 SO 草稿）</b>。之后再次编辑也必须重新保存。',
 '点击 <b>Create in NetSuite（在 NetSuite 创建）</b>；或搜索符合条件的有效 SO，再点击 <b>Link existing SO（关联已有 SO）</b>。如果已有报价单可用，来源选项也支持从报价单转换。') + note('Skip 按钮仅供测试', '如出现 <b>Skip SO creation</b> 或 <b>Skip PO Creation</b>，表示可跳过订单创建进行测试，不会创建真实订单，也不会进入真实调度。实际客户订单必须使用 NetSuite 创建／关联流程。', 'warning'))

page('special-po','特殊申请 · SCM','审核并创建 PO','SCM', steps(
 '等待关联 SO 在 NetSuite 中获批／生效，再打开 <b>Review and create Purchase Order（审核并创建采购订单）</b>。',
 '核对描述、数量和单位。审核后的这些内容会先更新 SO，但客户的销售价格保持不变。',
 '每行填写<b>供应商折扣前的单位采购成本</b>和供应商折扣百分比；没有供应商折扣时也必须填 <b>0</b>。',
 '点击 <b>Create PO in NetSuite</b> 创建采购订单。如需恢复未完成操作，在同一申请中使用 <b>Recover PO operation（恢复 PO 操作）</b>。') + shot('15-special-po','PO 审核使用采购成本及供应商折扣，与客户的销售折扣分别处理。') + '<h2>PO 参考号／装箱单参考号</h2>' + shot('19-special-po-reference','PO 创建后，如有供应商参考号，可在此保存。') + '<p>参考号会与 <b>PO Split</b> 及 <b>PO/TO Schedule</b> 共用；自定义参考号留空时使用 PO 编号。</p>' + note('区分销售折扣与供应商折扣', '客户折扣属于 SO，供应商折扣属于 PO。逐项核对金额；最终订单可能将折扣合并为一条折扣行。'))

page('special-readiness','特殊申请 · SCM','检查 PO 批准状态和备货状态','SCM', shot('16a-special-po-approval','PO 已创建但仍等待 NetSuite 批准时，申请保持 Confirmed（已确认）阶段。',590) + '<p><b>Confirmed 不代表已经可以调度。</b> 系统需确认 PO 已批准，才按备货及交付方式继续处理。</p>' + shot('17-special-readiness','对已经接受但仍在等待的商品，SCM 选择 Not ready（未备好）并填写 ETA，或 Ready for collection（可以提货）。',615) + '<p>更新后点击 <b>Save stock check（保存供货检查）</b>。提醒从 ETA 前三个工作日（周一至周五）开始；一旦到期，必须由 SCM 明确确认已备好才会消除，仅推迟 ETA 不会清除已到期提醒。</p>' + note('同时查看申请阶段和调度状态', '申请阶段表示特殊申请的进度；<b>Dispatch planning（调度计划）</b> 则单独显示 SO／PO 是否已排入计划。向客户承诺提货或送货前，两项都要核对。'))

page('special-fulfillment','特殊申请 · 交付','更新送货资料或完成供应商自取','销售 + SCM', '<p>申请仍有效且尚未排入调度计划时，销售可更新交付方式及送货资料。在申请摘要中选择方式、修改资料，再点击 <b>Save（保存）</b>。</p>' + shot('18-special-delivery','送货资料编辑区：地址、联系人、期望日期、时间段及说明。') + note('资料被锁定时', 'SO／PO 已排计划，或交付安排已开始／完成时，可能无法再修改。应与 SCM 和调度人员协调现有申请，不要另外新建重复申请。') + '<h2>客户到供应商货场自取</h2><p>PO 已批准且所有客户接受的商品均备好后，销售填写<b>实际提货日期</b>及<b>提货参考号／凭证</b>，点击 <b>Complete vendor pickup（完成供应商自取）</b>。</p>' + shot('22-special-vendor-pickup','记录实际提货情况，并填写可追溯的参考信息，例如签收提货凭证编号。') + '<p>如为<b>在询价货场自取</b>或<b>送货</b>，应跟进调度安排和计划状态。SO 或 PO 已创建本身不代表客户已经收到货物。</p>')

page('special-adjustment','特殊申请 · 变更','申请和审核订单调整','销售 + SCM', steps(
 '销售打开 <b>Request an order adjustment（申请订单调整）</b>，修改已接受商品的数量、折扣及／或 PALLET 数量，点击 <b>Request adjustment（提交调整）</b>。原始售价保持固定。',
 'SCM 核对调整前后的包装数量及换算后的 SO／PO 数量，填写审核备注，再选择 <b>Confirm adjustment（确认调整）</b> 或 <b>Reject adjustment（拒绝调整）</b>。',
 '等待更新结果。需 SCM 确认的调整完成前，订单创建和调度会等待。若只完成部分更新，使用 <b>Retry order update（重试订单更新）</b>，直到两个订单均通过核对。') + shot('20-special-adjustment','示例：2 → 3 PLT，对应 SO 40 → 60 PC、PO 40 → 60 PC，同时 PALLET 从 2 改为 3。') + note('商品数量与 PALLET 分别核对', '商品包装换算和单独收费的 PALLET 行是两个数值，都需要检查。远程更新失败或只完成一部分时，继续处理原申请，不要重复创建 SO 或 PO。'))

page('special-close','特殊申请 · 关闭','关闭申请并保留记录','销售 + SCM', table(['申请情况','关闭方式'],[
 ('尚未创建 SO 或 PO','填写原因并点击 <b>Close case（关闭申请）</b>。'),
 ('已创建 SO，尚无 PO','使用可用的 <b>Close SO and case（关闭 SO 及申请）</b> 操作并填写原因。'),
 ('已创建 PO','销售发起关闭申请，由 SCM 审核并确认关闭 SO 和 PO。'),
 ('已排计划、已完成，或被其他操作阻止','先与 SCM／调度人员处理现有计划或未完成操作，此时关闭按钮可能不可用。')]) + shot('21-special-close','SCM 可确认或拒绝关闭关联的 SO 和 PO。') + '<p>如果 NetSuite 关闭操作已开始但未完成，可能需要重试。只有相关订单关闭结果通过核对，申请才会标记为已关闭。已经开始执行的关闭操作不能在中途简单拒绝。</p>' + '<h2>特殊申请到期</h2><p>到期日用于控制尚未生成订单的询价；只有<b>不存在 SO 或 PO</b> 时才会自动到期关闭。字段仍可用时，销售可修改到期日。这与常规自取批准的短时有效期是不同机制。</p>' + '<h2>文件与历史</h2><p>在可用位置预览报价或订单，并点击 <b>Download PDF（下载 PDF）</b>。跟进前先核对订单编号、计划状态和操作记录。销售可查看相应报价／SO 文件；SCM 可从申请查看关联 SO／PO。</p>')

page('statuses','参考资料','理解阶段、队列及提醒','销售 + SCM', '<h2>特殊申请阶段</h2>' + table(['阶段','含义／下一步负责人'],[
 ('<b>New Enquiry</b><br>新询价','SCM 核实供应商供货并回复。'),
 ('<b>Await Customer Confirmation</b><br>等待客户确认','销售记录客户决定并准备 SO。'),
 ('<b>Confirmed</b><br>已确认','申请进入订单处理阶段，应检查 SO／PO 批准状态及待办 SCM 操作。'),
 ('<b>Wait for production / Transfer</b><br>等待生产／调货','客户已接受，但商品尚未备好；SCM 跟进 ETA 和备货情况。'),
 ('<b>Dispatch Arrangement</b><br>调度安排','进入相应调度流程，仍需检查是否已经排入计划。'),
 ('<b>Completed</b><br>已完成','已记录实际业务完成结果。'),
 ('<b>Closed</b><br>已关闭','因取消、拒绝、到期等原因，询价／订单流程已关闭。')]) + '<h2>提醒</h2>' + table(['人员／申请类型','关注内容'],[
 ('销售 · 常规','未读的人工批准／拒绝决定；打开申请查看原因和下一步操作。'),
 ('SCM · 常规','新收到的人工审核申请，包括全部备货申请。'),
 ('销售 · 特殊','自己处于等待客户确认、调度安排或等待生产／调货阶段的申请。'),
 ('SCM · 特殊','新询价及已确认申请，并查看卡片上的备货、订单调整及关闭提醒。')]) + '<p>特殊申请的提醒数量按流程阶段统计，并非单纯的未读消息数。只要仍处于相应阶段，申请就可能继续显示在提醒列表。</p>' + '<h2>常规申请队列和明细状态</h2><p>销售使用 <b>Pending（待处理）</b>、<b>Accepted（已接受）</b>、<b>Completed（已完成）</b>；SCM 还有审核、已批准、等待 TO、已拒绝和已关闭等队列。混合审批结果须同时查看每行决定及保存的 SO／TO 操作。</p>' + note('队列状态不等于客户签收', '申请获批或 TO 创建后，仍可能需要实物调货和收货。是否完成交付应以调货、调度或实际提货结果为准。'))

page('troubleshooting','参考资料','常见问题处理','销售 + SCM', table(['遇到的情况','处理方法'],[
 ('自取要求人工审核','查看原因：自动审批关闭、库存低于安全库存或缺少数据。自取无需最短提前时间。'),
 ('送货要求人工审核','涉及 150 或 12441 时由 SCM 审批；3445 ↔ 2967 自动批准，但仍须通过库存等检查。'),
 ('送货无法计算／显示短缺','核对 SO 库存商品行地点、欠货数量、Target Yard 可用库存及商品托盘换算。见<a href="#delivery-quantities">数量规则</a>。'),
 ('备货申请没有自动批准','这是正常流程。必须由 SCM 审核并直接转换为 TO。'),
 ('自取 SO 数量与批准不一致','按错误信息比较商品、单位及合计。批准 760 而 SO 为 912，超出 152；应修正 SO 或按实际数量重新获得批准。'),
 ('SO 含 PALLET、折扣、小计或送货费','这些属于附属行，不是申请库存。应查看实际库存商品行来判断处理方式。'),
 ('SO 编号已被使用','查看原常规申请；另一份申请应使用其他符合条件的 SO。'),
 ('批准已过期','对于尚未使用的自取批准，点击 <b>Re-raise request（重新发起）</b>，核对新结果后再继续。'),
 ('等待 NetSuite／按钮被禁用','等待处理；如出现需要处理的提示或重试按钮，在同一申请中继续。'),
 ('读取时 SO 已发生变化','先完成 SO 修改。送货使用原申请的检查／重试操作；自取重新点击 <b>Review SO routing</b> 检查并确认。'),
 ('特殊申请的 Create in NetSuite 不可点','选择有效客户账户和销售代表，填写必填项并 <b>Save SO draft</b>；处理待 SCM 确认的数量调整。'),
 ('特殊申请无法创建 PO','确认 SO 已获批、供应商有效，填写采购成本及每行供应商折扣；没有折扣也必须填 0。'),
 ('已有 PO，但申请仍为 Confirmed','查看 PO 批准提示。系统确认 NetSuite 已批准后，才继续相应调度／备货流程。'),
 ('修改 ETA 后提醒仍存在','实际备好后由 SCM 选择 <b>Ready for collection（可以提货）</b>。新 ETA 不会清除已到期的提醒。'),
 ('无法修改交付方式或关闭申请','检查计划、完成状态、待审批调整及提示信息，与 SCM／调度人员协调现有申请。'),
 ('其他错误持续出现','向 SCM／支持人员提供申请号、SO／PO／TO 编号、完整报错及刚执行的操作。保留原申请以便检查已保存的处理状态。')], 'compact') + '<p class="small">浏览器操作中断不代表订单一定没有创建。重试前先核对已保存的申请和订单编号。</p>')

page('quick-reference','参考资料','日常核对清单和术语','销售 + SCM', '<div class="two-cols"><section><h2>销售</h2><ul><li>送货核对 Base Yard 与 SO 商品行地点一致，Target Yard 为供货货场。</li><li>送货核对自动数量、PALLET、TO 备注及打印状态。</li><li>自取 SO 在自己的销售货场创建，并与批准内容匹配。</li><li>执行前阅读处理方式确认弹窗。</li><li>特殊询价保存客户的真实决定。</li><li>核对 SO 账户、售价、折扣、托盘及送货资料。</li><li>查看提醒和最终处理结果。</li></ul></section><section><h2>SCM</h2><ul><li>送货涉及 150／12441 时审核整份申请。</li><li>自取检查人工审核原因及每行安全库存。</li><li>自取须完成所有需要处理的明细决定。</li><li>备货生成 TO 前，检查修改／新增商品及 PALLET 数量。</li><li>跟进优先补货，适当时明确释放。</li><li>特殊申请核实供应商、ETA 及提货地点。</li><li>检查 PO 成本、折扣及批准状态。</li><li>处理备货、调整和关闭待办。</li></ul></section></div>' + table(['术语','本手册中的含义'],[
 ('Base Yard（基础货场）','送货 SO 库存商品行所属货场；TO 的收货地点。'),
 ('Target Yard（目标货场）','送货中选定的供货货场；TO 的 From Location。调货方向为 Target Yard → Base Yard。'),
 ('自取／备货的来源／目标货场','分别为供货货场／发起申请并接收库存的销售货场。'),
 ('安全库存','用于判断发货后来源货场剩余库存是否足够的最低阈值。'),
 ('PLT／LYR／SEC／PC 或 PCS','托盘／层／节／件，具体换算按商品资料确定。'),
 ('Sales UOM · 销售单位','例如 SQFT（平方英尺）或 EACH（个），用于比较批准商品的数量。'),
 ('PALLET 行','订单中单独的托盘商品／收费行，不算作常规申请的库存商品。'),
 ('优先补货','在 Smart SCM 建议计划中持续保留，直到明确释放的常规申请补货需求。'),
 ('Revision · 版本','申请的已保存版本；其他人修改后应先刷新。'),
 ('Attention／Recovery','操作需要检查或在同一申请中恢复／重试，才能继续完成。')]) + note('适用范围', '本版说明以 <b>2026 年 9 月 30 日</b> 核对的已部署功能为准。配置及可用操作可能调整，请以实际申请显示的数值、原因和确认信息为准。'))

# Reuse only inert presentation constants; do not execute the English builder.
source = ast.parse((ROOT/'tools/stock-request-manual-content.py').read_text())
constants = {}
for node in source.body:
    if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('CSS','script'):
        constants[node.targets[0].id] = ast.literal_eval(node.value)
CSS = constants['CSS'] + '''
body{font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei","Microsoft YaHei","PingFang SC",Arial,sans-serif;font-size:14px;line-height:1.55}h1,h2,h3{line-height:1.28;letter-spacing:0}h1{font-size:28px}.cover-intro h1{font-size:60px;letter-spacing:3px}.cover-subtitle{line-height:1.3}.cover-description{line-height:1.6}.cover-routes{margin-bottom:25px}.cover-routes article{min-height:250px}.cover-routes h2{font-size:21px}.page-kicker>span:first-child{letter-spacing:1px}.lead{line-height:1.6}.steps li{margin-bottom:9px}table{line-height:1.5;font-size:12.6px}th{font-size:11.6px}.small{font-size:11.8px;line-height:1.5}figcaption{font-size:11.3px;line-height:1.45}aside{font-size:12.8px;line-height:1.5}#contents .toc{font-size:12px;line-height:1.5}#contents .toc a{padding:1px 0}#contents .lead{font-size:14px}#contents td{padding:6px 8px}#statuses table{font-size:12px}#statuses td{padding:6px 9px}#troubleshooting table{font-size:12.4px;line-height:1.55}button{font-family:inherit}
'''
toc_groups = [(group,[n for n,p in enumerate(pages,1) if p['section'].startswith(prefix) and p['id']!='contents']) for group,prefix in [('开始使用','开始使用'),('常规库存申请','常规申请'),('特殊库存申请','特殊申请'),('参考资料','参考资料')]]
toc = ''.join(f'<h3>{group}</h3>'+''.join(f'<a href="#{pages[n-1]["id"]}"><span>{pages[n-1]["title"]}</span><b>{n:02}</b></a>' for n in nums) for group,nums in toc_groups)
body = []
for n,p in enumerate(pages,1):
    body.append(f'''<section class="page {p['extra']}" id="{p['id']}" data-page="{n}"><header class="page-header"><span class="brand">MBBS</span><span>库存申请 · 用户手册</span></header><div class="page-kicker"><span>{p['section']}</span><span class="role">{p['role']}</span></div><h1 class="page-title">{p['title']}</h1><div class="page-body">{p['content'].replace('{{TOC}}',toc)}</div><footer class="page-footer"><span>2026 年 9 月 30 日 · {p['section']}</span><span>{n:02} / {len(pages):02}</span></footer></section>''')
document = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="MBBS 常规及特殊库存申请中文用户手册，面向销售与 SCM，附界面截图和操作说明。功能核对日期：2026 年 9 月 30 日。"><title>MBBS 库存申请 — 中文用户手册</title><style>'+CSS+'</style></head><body><nav class="toolbar" aria-label="手册导航"><b>MBBS 库存申请</b><a href="#contents">目录</a><a href="#delivery-create">送货申请</a><a href="#regular-create">自取／备货</a><a href="#special-header">特殊申请</a><a href="#troubleshooting">常见问题</a><button onclick="window.print()">打印／保存 PDF</button></nav>'+''.join(body)+'<dialog id="imageViewer" aria-label="放大截图"><button autofocus>关闭</button><img alt=""><p></p></dialog><script>'+constants['script']+'</script></body></html>'
(OUT/'Stock_Request_User_Manual_2026-09-30_zh-CN.html').write_text(document)
(OUT/'manual-index-zh-CN.json').write_text(json.dumps([{'page':n,'id':p['id'],'section':p['section'],'title':p['title'],'audience':p['role']} for n,p in enumerate(pages,1)],ensure_ascii=False,indent=2)+'\n')
assert len(pages)==32 and len({p['id'] for p in pages})==32
assert all(text in document for text in ['Target Yard → Base Yard','SOB121732','Retry SO check','欠货数量','PALLET 自动计算'])
print(f"Built Chinese offline HTML: {len(pages)} pages, {document.count('<figure')} screenshots, {len(document.encode()):,} bytes.")
