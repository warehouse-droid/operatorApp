# MBBS / MBT Odoo API 与 Webhook 集成规范

版本：1.0 | 日期：2026 年 10 月 22 日 | 状态：拟实施规范 | 语言：简体中文

适用对象：MBBS 与 MBT 业务负责人、Odoo 实施团队、应用开发团队及集成运维人员。

本文规定以 Odoo 替换应用现有 NetSuite 集成所需的接口，依据上述日期审阅的应用源代码以及已确认的 MBT 职责调整编写。本文描述的是待实施方案，并不表示集成已经部署。文中所有 `/api/mbbs/v1`、`/api/integrations/odoo/v1` 路径、事件名称及传输结构，均为需要开发的自定义接口契约。

Odoo 的版本、版本类型、托管方式、已安装模块及自定义技术模型名尚未核实。业务契约不依赖具体版本；Odoo 开发人员须在实施签核前完成第 17 节的环境确认。API 路径、字段名、枚举值及 JSON 示例保留原文，以便开发团队直接对照。

## 1. 业务目标与已确认决策

现有 Node.js/PostgreSQL 应用继续负责堆场作业、调度、司机及现场执行，Odoo 取代 NetSuite 成为 ERP。现有 MBBS 流程通过 Odoo 适配层继续提供服务；更换 ERP 不得隐式改变收货、履约出库、退货、审批或库存移动的业务触发时点。

对于 MBT，**订单在 Odoo 中下单；订单、订单段（Leg）及作业（Job）均由 Odoo 创建和修订**。Odoo 同时负责价格、费用、押金、计费及会计处理。应用接收工作任务，调度车辆与司机，执行 BIN 箱体作业，记录凭证，并把执行结果回传 Odoo。应用不再创建另一份 MBT 订单，也不重复计算账单。

假定 Odoo 的自定义 BIN 实现沿用现有 BIN 订单逻辑。第 8 节的层级、换箱规则、实体箱体关系和执行约束均为必须保留的要求，不能直接以通用任务流程替代。

| 决策项 | 已确认方向 |
| --- | --- |
| 覆盖范围 | 分阶段、受控地替换现有 NetSuite 集成的全部能力 |
| 受众与交付格式 | 兼顾业务与开发交接；本中文版提供 Markdown 源文件及对应 PDF |
| 托管设计 | 支持自定义模块的 Odoo.sh 或自托管部署；具体环境待确认 |
| MBT 工作定义 | Odoo 提供订单、订单段、作业、依赖关系及修订版本 |
| MBT 现场执行 | 应用负责调度分配、执行、实体箱体保管状态及凭证 |
| MBT 商业职责 | Odoo 负责定价与计费，包括 MBT/MBBS 之间的交叉收费 |
| 其他集成 | Samsara、路线与地图、照片存储以及本地 PWA 行为继续由应用负责 |

MBR Contracts 目前独立于 NetSuite 和 MBT。除非另行提出需求，新增 MBR 与 Odoo 的集成不属于此次替换范围。历史 NetSuite/MBT 记录须保持可读、可审计。

## 2. 系统边界与数据归属

每个字段或操作仅由一个系统作为权威来源。接收 ERP 更新时，不得重置本地备货状态、司机进度、照片或调度分配。

| 信息 | 权威系统 | 集成行为 |
| --- | --- | --- |
| 客户、供应商、商业地址、付款条件、税务及信用状态 | Odoo | 导入标准记录及启用/停用变更 |
| 产品及变体、库存计量单位、商业计量单位、ERP 库存及已承诺数量 | Odoo | 导入定义与库存观测值，保留观测时间 |
| MBBS 商业订单与财务状态 | Odoo | 应用可发起受支持且已授权的命令；由 Odoo 校验并返回权威结果 |
| 配送指示与要求日期 | Odoo（更新被接受后） | 保留应用现有编辑能力，并检查预期修订版本 |
| 本地调度计划、合并/拆分、工作锁及操作员进度 | 应用 | 保留本地标识与历史，并关联原始 ERP 行 |
| 现场执行凭证与实际发生时间 | 应用 | 使用稳定凭证 ID 发布不可变结果或更正 |
| MBT 订单、送箱/换箱/收箱定义、订单段及作业 | Odoo 自定义模块 | 接收完整、带版本的聚合数据；不在本地创建商业订单 |
| MBT 车辆/司机分配、实体箱体状态、预留及保管关系 | 应用 | 将已接受的分配变更和实际移动回传 Odoo |
| MBT 服务价格、租赁费、卸料费、发票及交叉收费 | Odoo | 每项业务服务只消费一次计费依据，不按每个执行部分重复收费 |
| 现场运营备注、堆场路线、卸料场适用性及车队约束 | 默认沿用应用现有登记数据 | Odoo 引用映射后的 ID；导入不得覆盖本地运营字段 |
| 箱体及箱型登记数据 | 默认沿用应用现有登记数据 | 与 Odoo 共享稳定引用，不另建独立编号的实体箱体主数据 |

商业地址变更仅作为未来工作的变更建议。已签发给司机的指示保留冻结的现场/地址快照，直至通过明确的运营变更流程。Odoo 可指定箱体或箱型，但应用仍须在调度前核实实际保管关系、兼容性及可用性。

共享运营登记数据通过 `operational.reference.upsert` 命令向 Odoo 发布启用/停用定义。首次导出包括 MBT 使用的堆场、车辆、司机、箱型、实体箱体、卸料场及物料。这些是运营引用，不是要求建立财务产品或员工档案；Odoo 模块负责映射到实际采用的模型。

## 3. 现有集成清单与替换要求

应用实际集成行为比早期概览文档更广。当前路由包括订单、客户、履约/收货对账 Webhook，以及持久化过账队列和 Webhook 队列。本清单主要依据代码；未检查生产环境的功能启用情况。

| 能力 | 应用现有行为 | Odoo 对应要求 |
| --- | --- | --- |
| 订单读取与实时更新 | 销售单/采购单/调拨单（SO/PO/TO）的表头、行、审批、日期、地址及进度 | 带版本的订单快照、搜索及事务提交后的事件 |
| 客户 | 共享客户主数据和退货模块投影；检测过时或冲突更新 | 客户/地址/公司标识、增量导入、停用状态及冲突处理 |
| 产品与库存读取 | 产品定义、PLT/LYR/SEC/PCS 换算、库位库存及销售历史 | 按变体区分产品、明确单位换算、库存观测及历史需求数据 |
| 自提与履约出库 | 部分自提、按库位过账、来源行核验、套件及持久化重试 | 按实际数量对正确出库单/库存移动仅确认一次，并核验来源行 |
| 收货 | PO/TO 收货、部分收货、单位、照片及采购额外费用核验 | 入库单确认、剩余数量、收货凭证及独立费用信息 |
| 调拨与在途 | TO 创建/更新/审批、发出/接收阶段、本地 CO 移动及依赖 | 关联出库与入库移动；区分内部及跨公司路线 |
| Smart SCM | 采购与调拨建议、供应商产品编码、补货及采购历史 | 幂等采购/调拨命令与采购历史 |
| 常规/特殊库存 | 关联销售/采购/调拨工作、数量/描述调整、关闭及恢复 | 保留供需关联、审批、来源修订版本及不确定写入的恢复流程 |
| 销售与 Field Sales | 本地报价、确认后创建销售单、客户/产品查询、旧报价读取 | 从应用已批准报价创建确认销售业务，保留必要报价/订单引用及文档获取能力 |
| 订单维护 | 配送备注/日期、采购历史编辑、审批及特殊订单调整 | 范围明确的授权命令、乐观并发控制及结果核验 |
| 退货与贷项 | 商品/托盘退货、退货授权及贷项流程、原始行/原因映射 | 实物逆向移动与财务退款分别处理，并保持关联 |
| 库存损坏/盘点 | 损坏转移及可复核的本地盘点 | 映射损坏/隔离/报废政策；仅提交明确批准的库存调整 |
| 文档与凭证 | SO/PO/报价 PDF、拣货单、照片及附件上传 | 经授权获取文档，使用稳定凭证/附件引用 |
| MBT | 现有合同、BIN 工作、执行、费率及本地计费结构 | 导入 Odoo 定义的 BIN 工作并回传运营事实；将后续商业职责转移至 Odoo |

保留按堆场、按功能控制的过账开关。源码中，自提、收货、配送准备、退货及贷项均有独立开关，此外还有其他履约触发点。迁移时必须盘点实际配置，并为每项业务完成操作确定唯一的 ERP 过账系统。连接成功不代表可以启用全部 Odoo 写入。

## 4. 架构与消息流

围绕现有领域服务开发 Odoo 自定义桥接模块及应用适配层。桥接模块负责标准化快照、命令校验、事务安全的结果、出站变更日志和 Webhook 投递。应用适配层负责标识映射、持久化入站处理、出站命令以及本地数据投影。

```text
Odoo 业务变更
    -> 在同一事务中提交业务数据、版本及出站事件
    -> Webhook 发送器与重试
    -> 应用持久化收件箱 -> 应用 ERP 所属字段
    -> 现有调度、操作员及司机界面

应用操作或 MBT 执行
    -> 在同一事务中提交本地结果及出站命令
    -> Odoo 命令收件箱 -> 执行已授权业务操作
    -> 在同一事务中提交结果及后续 Odoo 事件
    -> 应用核验结果并对账本地投影

定时恢复
    -> 读取变更流 -> 补齐遗漏 -> 比较当前快照
```

Webhook 是携带持久化业务快照的通知，并不能证明应用已经完成处理。HTTP 202 表示已持久化、待处理。现场完成、ERP 过账和事件投递必须分别记录状态。

Odoo Studio 提供 Webhook 通知动作，但本文要求的投递保障、认证、版本控制及恢复能力仍须由自定义桥接模块实现，不应视为 Studio 自动提供的保证。参见 [Odoo 自动化文档](https://www.odoo.com/documentation/19.0/applications/studio/automated_actions.html)。

库存和会计操作须调用 Odoo 业务方法，不能直接修改库存余额或强行设置交易状态来模拟完成。需要多项相互依赖模型操作的命令，应尽可能在同一业务事务内执行；无法原子完成的多单据工作，必须暴露明确的步骤和可恢复结果。

## 5. 标识、数量、日期与状态规则

### 5.1 稳定标识

使用 `(sourceInstance, companyId, entityType, entityId)` 四元组标识外部业务实体。传输中的 ID 为不透明字符串。`sourceInstance` 标识已配置的数据库及环境；不得根据调用方自行提供的数据库名称决定访问权限。

建立明确映射，将该四元组对应到现有本地 ID，并在适用时保留旧 NetSuite 账户/模型/内部 ID。不能将 Odoo 记录 ID 写入 `netsuite_id` 列后假定其代表同一记录。不得仅按名称、电子邮件、SKU 或显示单号匹配客户与订单。

必须提供稳定行 ID。同一产品可能出现在多条订单行中；一条 Odoo 商业订单行也可能关联多个库存移动和欠交单。须同时保留商业行 `lineId` 与作业行 `operationLineId`，以及各自单位和库位信息。列表位置、产品 ID、NetSuite `orderLine` 及 Odoo 库存移动 ID 是不同概念。

BIN 订单、订单段、作业、箱体及凭证分别使用独立且稳定的 ID。`BIN00001X-1D` 等人工可读编号仅用于显示，不是数据库键。不得为了适配新的 ERP ID 而更改已签发的访问/停靠点 ID 或不可变凭证。

### 5.2 通用值约定

| 数据项 | 契约 |
| --- | --- |
| 数量、换算因子、距离、重量 | 十进制字符串，明确计量单位；不能隐式舍入，也不能将负向移动伪装为收货 |
| 金额 | 十进制字符串及 ISO 币种；Odoo 负责税额和会计舍入；传输处理不得使用浮点数计算 |
| 缺失 / null / 零 | 必填字段缺失为无效；null 表示明确未知或不适用；零表示测量或计算结果确实为零 |
| 时间戳 | 带毫秒的 UTC ISO 8601，例如 `2026-10-22T14:00:00.000Z` |
| 业务日期 | `YYYY-MM-DD`，不得经由 UTC 午夜进行转换 |
| BIN 业务时区 | `America/Toronto`；同日规则必须正确处理夏令时 |
| 修订版本 | 正整数，以十进制字符串编码；每个聚合内单调递增 |
| 凭证标识 | 稳定 ID、SHA-256、MIME 类型、字节数、采集时间、关联对象及授权获取引用 |

区分销售、采购及库存计量单位，并记录工作签发时使用的换算关系。PLT/LYR/SEC/PCS 是与产品有关的显示/搬运单位；缺失换算因子不能默认为 1。件数转面积等跨类别换算必须在 Odoo 中明确配置。历史凭证保留原始单位与换算快照。

库存快照须分别列出在手、预留、可用及在途数量，并包含库位范围和观测时间。预计到货库存或本地已打包数量不会自动成为可用库存。Odoo 应明确可承诺库存政策，适配层须保留其准确含义。

### 5.3 独立状态维度

分别使用 `commercialStatus`、`executionStatus` 和 `financialStatus`。按实际安装的 Odoo 流程标准化商业审批、开放、关闭及取消状态，同时保留原始 ERP 状态用于诊断。一张开放订单可能仅部分交付、部分开票。商业请求取消不能抹去实际发生的库存移动。

MBT 的 `executionStatus` 在集成报告中使用 `pending`、`ready`、`assigned`、`in_progress`、`completed`、`cancelled` 或 `attention`，并映射到应用现有状态。是否可执行由应用根据依赖、资源及暂停条件推导；入站 `ready` 提示不能跳过这些检查。

## 6. API 目录

### 6.1 拟开发的自定义接口

`ODOO_BASE_URL` 与 `APP_BASE_URL` 是经批准的 HTTPS 站点地址占位符。所有 JSON 使用 UTF-8；URL 中的 ID 必须进行 URL 编码。接口仅供系统服务使用，不接受浏览器用户令牌。

| 方法与路径 | 服务端 | 用途 |
| --- | --- | --- |
| `GET /api/mbbs/v1/capabilities` | Odoo | 返回支持的结构版本、命令、实体类型、限制及来源实例 |
| `GET /api/mbbs/v1/changes` | Odoo | 提供持久化、有序的变更流，用于重放与对账 |
| `GET /api/mbbs/v1/snapshots/{entityType}/{entityId}` | Odoo | 获取当前完整标准化聚合及来源修订版本 |
| `GET /api/mbbs/v1/entities/{entityType}` | Odoo | 有界搜索及首次全量枚举 |
| `GET /api/mbbs/v1/inventory` | Odoo | 产品/库位库存观测 |
| `GET /api/mbbs/v1/sales-history` | Odoo | SCM 使用的分页历史需求 |
| `GET /api/mbbs/v1/documents/{documentId}` | Odoo | 获取已授权的 PDF/附件字节流及完整性元数据 |
| `POST /api/mbbs/v1/commands` | Odoo | 持久化接收一条幂等业务命令 |
| `GET /api/mbbs/v1/commands/{commandId}` | Odoo | 查询命令状态、结果标识、错误及恢复状态 |
| `POST /api/integrations/odoo/v1/events` | 应用 | 持久化接收一条已签名的 Odoo 事件 |
| `GET /api/integrations/odoo/v1/events/{eventId}` | 应用 | 受限服务接口，查询应用处理结果 |
| `GET /api/integrations/odoo/v1/evidence/{evidenceId}` | 应用 | 获取受权限控制的凭证元数据或字节流 |

所有 Odoo 读取请求均须提供 `companyId`；实体和快照引用不得越出该公司范围。`entities` 接受 `limit`、不透明 `cursor`、精确 `reference`，或针对所支持客户/供应商/产品/订单类型的有界 `query`。初始游标固定筛选条件和范围，后续分页不得变更。默认每页 100 条，最多 500 条；若环境限制更低，由 capabilities 接口公布。

`inventory` 必须提供产品 ID 和库位 ID，每类每次最多 100 个，按行返回数量、单位及观测时间。`sales-history` 必须提供 `dateFrom`、`dateTo`，可附产品/库位筛选及游标/页大小；每次日期范围最多 366 天。须返回稳定订单行 ID、业务日期、产品、库位、数量、单位及取消/退货标记，避免 SCM 将冲销需求计为新销售。

`documents` 返回 `Content-Type`、`Content-Disposition`、字节长度及 `X-Content-SHA256`。若报表仍在生成，返回带 `Retry-After` 的 202，使用 JSON 提供生成状态，不发送不完整 PDF。文档访问须限定于请求集成身份及公司。

### 6.2 API 认证

自定义读取、命令及状态接口使用专用集成身份和 Bearer 凭证。不同环境、不同通信方向分别发放凭证。每个身份限定允许的来源实例、公司、资源类型及命令。模块内部须执行 Odoo ACL 和业务权限校验，不能开放任意 ORM 模型/方法调用或不受限制的 `sudo`。

桥接开发人员选择兼容目标 Odoo 版本的凭证实现，并记录在部署确认表中。对外契约保持 `Authorization: Bearer <service-credential>`。这是拟实现的自定义服务凭证，并不表示所有 Odoo 版本的原生 API 都接受这种方式。

### 6.3 命令信封与生命周期

请求头包括 `Authorization`、`Content-Type: application/json`、与 `commandId` 相同的 `Idempotency-Key`，以及与 `correlationId` 相同的 `X-Correlation-Id`。

必填信封字段为 `schemaVersion`（`mbbs.command.v1`）、UUID 格式的 `commandId`、`sourceInstance`、`companyId`、`commandType`、UUID 格式的 `correlationId`、`occurredAt`、`actor`、`target`、`expectedRevision` 及 `data`。`actor` 标识经过应用认证的操作者，用于审计；服务凭证仍是权限边界。仅在结构明确允许的创建或仅追加操作中，`target`/`expectedRevision` 才可为 null。

Odoo 收件箱须持久化命令后才返回 202。存储语义请求哈希与业务幂等键，并设置唯一约束。同一命令 ID、相同内容返回原有状态；同一 ID、不同内容返回 409。命令状态为 `accepted`、`running`、`succeeded`、`rejected` 和 `attention`。202 接收确认不等于库存过账成功。

命令标识按已认证的 `(sourceInstance, companyId, commandId)` 限定范围。同时对底层业务操作去重：创建使用源报价/建议 ID；库存操作使用本地完成 ID 加过账操作；MBT 事实使用执行/更正事件 ID。不能通过第二个命令 ID 绕过业务幂等键。同一业务键、相同操作意图返回原结果；不同意图返回 409。业务去重记录须与相关交易/凭证的保留生命周期一致，不能只按短期 Webhook 重放期限保留。

执行变更前检查预期来源修订版本和权限。业务结果、命令结果和发出的变更事件须一并提交。发生结果不明确的超时时，应用先查询同一命令 ID，必要时才重发相同信封；不能仅为重试而分配新 ID。永久拒绝后，需要修正内容、创建新命令，并以 `supersedesCommandId` 引用被拒绝命令。

成功结果必须标识所有受影响的 ERP 记录、作业行、数量、单位及结果修订版本。应用核对这些信息与提交操作一致后，才将 ERP 过账标记为完成。处于 `attention` 的多步结果必须说明已提交步骤和待恢复事项；只有确实完整回滚后，才能报告全部回滚。

### 6.4 命令类别

| 命令类型 | 最低业务数据及控制要求 |
| --- | --- |
| `sales_order.create` | 已批准的报价/建议 ID、客户、公司、地址、币种、行、价格/折扣、配送方式及要求日期；稳定来源键 |
| `purchase_order.create` | 已批准建议、供应商、目的地、订购行/单位、供应商编码、托盘行、费用及需求关联 |
| `transfer.create` / `transfer.update` | 来源/目标公司与库位、来源需求关联、准确行/单位、跨公司意图及审批凭证 |
| `order.approve` / `order.update` | 带类型目标、预期版本、已授权字段集合及审批人；禁止任意记录修改 |
| `special_order.adjust` / `special_order.close` | 关联 SO/PO、预期版本、数量/描述/折扣变更或关闭计划及原因 |
| `fulfillment.confirm` | 来源订单、选定库存作业及行、完成 ID、库位、实物数量、换算快照及凭证 |
| `receipt.confirm` | 来源 PO/TO 与作业行、收货库位、完成 ID、实收数量及凭证；费用观测独立记录 |
| `return.create` / `return.receive` | 原交易/行、原因、实际退货数量、库位、托盘区分及凭证 |
| `credit.create` | 已批准退货/贷项事项、原发票/行、币种及原因；Odoo 计算并验证财务结果 |
| `inventory.damage` | 原库位、损坏目的地/处置方式、已批准数量、单位、凭证及来源观测 |
| `inventory.adjust` | 明确批准的盘点/对账事项、预期库存观测及原因；禁止自动过账盲盘草稿 |
| `document.attach` | 目标、稳定凭证/文档标识、校验和及受控获取引用；不得抓取任意 URL |
| `operational.reference.upsert` | 登记类型、应用 ID、修订版本、启用标记及 Odoo 所需运营属性 |
| `mbt.assignment.report` | 订单/订单段/作业引用、分配版本、车辆、司机、所选箱体及计划时间窗口 |
| `mbt.execution.report` | 不可变作业事件、实际动作/时间、箱体/保管移动、测量值及凭证 |
| `mbt.execution.correct` | 原结果 ID、仅追加的更正 ID、原因、操作者及更正后的事实 |
| `mbt.exception.report` | 受影响订单/订单段/作业、观测异常、实物状态及恢复要求 |
| `mbt.amendment.request` | 请求 Odoo 修改工作定义及原因；不得在本地创建替代作业 |

capabilities 响应必须列出准确支持的命令类型。不支持的类型返回 422，不能返回笼统成功。应用发起 MBT 订单/订单段/作业创建命令不在接口范围内。开放命令时须保留现有 MBBS 角色限制及按功能配置的过账开关。

## 7. Webhook 事件与可靠同步

### 7.1 事件信封

每个事件包含 `schemaVersion`（`mbbs.event.v1`）、UUID 格式的 `eventId`、`sourceInstance`、`companyId`、`entityType`、`entityId`、`revision`、`eventType`、`occurredAt`、UUID 格式的 `correlationId`、可为 null 的 `causationId`、`origin` 和 `data`。`origin` 用于诊断事件发起系统/动作；已知时，`causationId` 为触发事件的命令或事件 ID。

Odoo 桥接模块在业务事务中分配修订版本。子行/子作业变更必须增加父聚合版本。不得根据 Webhook 到达时间、内容哈希排序或单独依赖 `write_date` 来确定先后，因为独立提交的变更可能具有相同时间戳。

每个可变聚合事件均携带完整标准化快照，包括有效子对象及明确取消/移除的子对象 ID。必填子对象数组缺失属于无效消息。省略字段不代表允许删除凭证。仅追加的执行/更正事件不得因合并更新而被丢弃。

| 实体类型 | 事件类型 | 消费方行为 |
| --- | --- | --- |
| `customer`、`vendor` | `customer.upserted`、`customer.deactivated`；供应商使用对应事件 | 更新主数据/投影，保留历史引用 |
| `product`、`uom`、`location`、`company` | `{entityType}.upserted`、`{entityType}.deactivated` | 应用映射后的定义；不兼容变更暂停受影响工作 |
| `inventory` | `inventory.observed` | 按范围、数量、单位及观测时间更新库存投影 |
| `sales_order`、`purchase_order`、`transfer_order` | `{entityType}.upserted`、`{entityType}.cancelled` | 更新 ERP 所属表头/行及派生可用状态 |
| `fulfillment`、`receipt` | `{entityType}.posted`、`{entityType}.reversed` | 对账实际移动及来源行进度 |
| `return`、`credit` | `{entityType}.updated` | 分别刷新实物/财务状态及引用 |
| `mbt_order` | `mbt_order.upserted`、`mbt_order.cancelled` | 导入完整自定义 BIN 订单、订单段、作业及依赖 |
| `mbt_billing` | `mbt_billing.updated` | 可选的只读计费结果，附服务及发票引用 |
| `command` | `command.completed`、`command.rejected`、`command.attention` | 通知应用出站命令的持久化结果 |

即使过账发生在应用之外，也必须发出对应履约/收货事件。通过集成命令保存的记录，必须发出与 UI 保存一致的标准化业务事件。接收方应应用结果，但不能据此再次发送相同出站命令。

### 7.2 Webhook 认证

必须提供请求头：`X-MBBS-Key-Id`、`X-MBBS-Event-Id`、`X-MBBS-Timestamp`（Unix 秒）、`X-MBBS-Signature` 以及 `Content-Type: application/json`。

待签名字节严格按以下方式拼接，以换行分隔，末尾不加换行：

```text
keyId + "\n" + unixTimestamp + "\n" + eventId + "\n" + rawRequestBody
signature = "sha256=" + hex(HMAC-SHA256(secret, signedBytes))
```

使用 UTF-8 和小写十六进制。必须在 JSON 标准化之前验证原始字节，并使用恒定时间比较验证签名。签名请求头中的事件 ID 必须等于 JSON 中的事件 ID。密钥 ID 绑定已配置来源实例和允许公司。拒绝未知密钥、无效签名，以及与接收服务器时间相差超过 300 秒的时间戳。服务器必须同步时钟。

重试时保留原事件 ID 和消息正文，重新生成传输时间戳与签名；`occurredAt` 保持原业务发生时间。合法延迟事件可以早于五分钟前。密钥轮换时允许当前与上一密钥短暂并存。Webhook 密钥不得放入 JSON 正文或 URL。

### 7.3 接收、应用与冲突规则

认证通过的事件须先写入持久化收件箱，再返回 202。按已认证的 `(sourceInstance, companyId, eventId)` 去重。完全相同的重复事件返回已有状态；相同事件身份但字节不同，返回 409 冲突。同一聚合的事件按串行方式处理。

对于可变快照，较低版本不得覆盖较高版本。同版本且标准化业务数据相同，视为未变化；同版本但数据不同，进入冲突处理。更高版本的完整快照可恢复缺失状态，但仍须在对账记录中保留版本缺口。不能因为收到较新父快照而跳过仅追加事件。

缺少主数据映射或前置作业时进入 `waiting_dependency`，不得编造 ID。获取已批准的缺失记录或等待其变更流事件后再重试。不支持的结构版本须保持拒绝且可见；发送方不能静默降级或丢弃字段。

受限状态接口公开的收件箱状态为 `accepted`、`processing`、`applied`、`unchanged`、`stale`、`waiting_dependency`、`conflict` 和 `failed`。响应包含 `eventId`、`status`、`entityType`、`entityId`、`receivedRevision`、可为 null 的 `appliedRevision`、`updatedAt` 以及可为 null、采用通用错误结构的 `error`。本地发件箱向集成运维报告永久应用失败。发送方投递成功和接收方处理成功必须分别监控。

### 7.4 重放、首次导入与对账

`GET /changes?companyId=...&cursor=...&limit=100` 返回 `events` 数组、`nextCursor`、`hasMore` 及 `highWatermark`。游标是不透明值，并绑定来源、公司及筛选范围。游标必须代表已发布、已提交的顺序，不能直接使用可能越过尚未提交较小事务的数据库序列。桥接模块必须串行发布变更日志，或提供同等的提交安全游标语义。

首次导入时，先记录变更流水位，再用稳定键集游标枚举所有必需实体（包括停用记录），然后从该水位重放变更。重复遇到的变更通过版本检查处理。缺失行不代表删除，删除含义须通过明确停用/取消事件表达。枚举期间发生变化的聚合须刷新。顺序为公司、库位、单位、产品、客户、供应商引用，再导入 MBBS 交易及 MBT 工作。

获取的一页事件必须先持久化到收件箱，才能推进恢复游标。各事件应用状态独立保留，避免受阻事件因后续游标推进而消失。快照读取必须返回完整、已提交的聚合及版本。变更流既用于恢复事件，也用于刷新状态；最新快照无法重建已丢失的仅追加凭证。

建议初始默认值：传输失败、429 或 5xx 后，按 1、5、30、120、300 秒间隔并加入随机抖动重试，之后每五分钟重试；遵守 `Retry-After`。投递失败或应用延迟持续五分钟后告警，持续 24 小时仍未解决的任务升级为人工处理，但不能删除。认证/配置错误应暂停自动重试，修复后恢复。可重放事件至少保留 30 天，未投递或未解决事项不得清理。每五分钟增量恢复一次，每晚对账活动工作。这些是待压测与批准的初始运营参数。

过期游标返回 410 `CURSOR_EXPIRED`，附重新开始指示；不能静默从最新事件继续。重新导入可变状态，并对账缺失的运营/财务事件 ID 后，才能关闭故障。

## 8. MBT 自定义 BIN 模型与流程

### 8.1 术语及与现有代码的关系

本外部契约中的 **BIN 订单**指租赁/服务行聚合，包含首次送箱（Delivery）、零到多次换箱（Exchange）以及最终收箱（Collection）。每项服务包含一个或多个可调度的**订单段（Leg）**，每个订单段包含取箱、送箱、卸料或归还等可执行的**作业（Job）**。这套术语用于区分现有数据库 `mbt_bin_orders` 流程行与完整租赁聚合。

```text
BIN 订单 / 租赁服务行
  首次送箱
    送箱段 -> 取空箱、送箱
  换箱 1 ... 换箱 N
    送箱段 -> 按需取空箱、送达替换箱
    收箱段 -> 取走旧箱、卸料、归还或关联送箱
  最终收箱
    收箱段 -> 取走当前箱、卸料、归还或关联送箱
```

Odoo 提供聚合、服务流程、订单段及作业 ID，以及依赖和要求时间窗口。应用将其映射到现有服务行、访问、执行部分及步骤。调度单位是订单段，而非整份租赁。同一可读编号下可以有多个动作，但每个作业 ID 始终稳定。

| 现有概念 | 集成表示 |
| --- | --- |
| 合同/服务行及租赁编号 | `mbt_order`、`commercialContractId`、`rentalReference` |
| 首次送箱、按序号换箱、最终收箱 | `services[]`，包含 `serviceId`、类型及换箱序号 |
| 可独立调度的送箱/收箱部分 | `legs[]`，包含 `legId` 及角色 |
| 访问步骤/必经停靠点 | `jobs[]`，包含 `jobId`、`actionCode`、顺序及地点 |
| 跨部分前置条件 | `dependencies[]`，准确引用前置及后续作业 ID |
| 实体箱体与箱型 | 已映射 `assetId`、`binTypeId`、保管状态观测及分配 |
| 冻结的司机指示 | 已签发快照哈希、订单版本、订单段/作业 ID 及分配版本 |

保留现有可读编号：首次送箱为 `BIN00001D`；第 1 次换箱为 `BIN00001X-1`；对应动作为 `BIN00001X-1D`、`BIN00001X-1C`、`BIN00001X-1DP`、`BIN00001X-1R`；最终收箱、卸料及归还为 `BIN00001C`、`BIN00001C-DP`、`BIN00001-R`。租赁编号必须由单一权威来源分配，并映射现有编号，不得重编历史工作编号。

### 8.2 BIN 聚合必需数据

| 层级 | 必需业务信息 |
| --- | --- |
| 订单 | 稳定 ID/版本/编号；公司、客户、商业合同、现场及地址快照；时区；商业状态；服务、订单段、作业及依赖 |
| 服务 | 稳定 ID；`delivery`、`exchange` 或 `collection`；适用时提供换箱序号；父级计费服务标识；换箱顺序及复用选择 |
| 订单段 | 稳定 ID 和服务 ID；送箱/收箱角色；时间窗口；箱型；指定箱体或明确由调度选择；来源/目的地；作业；指示状态 |
| 作业 | 稳定 ID；动作代码；段内顺序；实际地点/地址；必需凭证；适用时提供物料/卸料约束 |
| 依赖 | 准确的前置和后续作业 ID；完成条件；适用时提供同日规则的锚点 |
| 箱体引用 | 已映射的实体箱体标识；预期保管/来源观测；来源可为某个明确前置作业完成后的未来计划位置 |

`instructionState` 为 `draft` 或 `released`。最终收箱草稿可以尚未确定时间/箱体，仅用于展示上下文。发布前必须具备完整作业、时间窗口、地点及可解析箱体要求。应用不得编造缺失收箱作业，或静默选择卸料场，以使不完整订单进入调度。

动作代码沿用现有逻辑：`collect_empty_bin`、`deliver_bin`、`pickup_bin`、`dump_bin`、`return_bin`。已经在所分配车辆上的箱体，或通过关联复用到达的箱体，不得重复生成实体取箱作业。Odoo 与应用须在发布前确认此配置。

### 8.3 必须保留的规则

1. 每份租赁都有首次送箱和最终收箱；换箱包含可独立安排的送箱段与收箱段。
2. 同箱、先收后送：先取箱，再卸料，然后在同一多伦多日历日送回原现场。
3. 异箱、先收后送：确认已取走旧箱后，才可在同一本地日期送达替换箱；旧箱卸料及后续工作可以仍未完成。
4. 先送后收：必须使用不同替换箱。旧箱在替换箱送达后收回，可相隔数日；较早收箱任务尚未完成时，允许存在后续换箱。
5. 每个收箱任务始终关联原实体箱体。最终收箱针对当前箱体；更早的未完成义务继续保留，并阻止运营关闭。
6. 收箱包括取箱、卸料，然后归还批准堆场，或将同一实体箱体关联到另一个要求完全匹配箱型的送箱任务。两个流程共享的后续送箱只是一项实物动作。
7. 跨司机前置作业必须持久化完成，才允许执行依赖作业。拒绝循环复用/依赖和冲突的独占箱体占用。
8. 计划时检查保管关系、箱型、容量、预留、时间先后及同日承诺。实际完成逾期仍须记录并标记异常，不得丢弃凭证以使计划看似合规。
9. 更换车辆必须记录保管/交接。关联来源或目的地变化不得静默改派已分配或已签发工作。
10. 作业和订单段属于父服务的运营拆分。Odoo 按商业规则对服务计费，不能按订单段、停靠点、重试或共享移动重复收费。

### 8.4 变更、取消与离线作业

Odoo 可修订尚未签发的工作。对于已分配、已签发或已开始的指示，入站变更应形成变更冲突，除非应用通过明确的取消计划/召回/重新签发流程接受变更。审核期间保留原指示和实物凭证。应用通过 `mbt.exception.report` 向 Odoo 回报冲突，Odoo 也可查询事件状态。

签发前取消可将工作移出调度池。实物执行开始后，取消属于需要恢复决策的商业请求，不能抹去客户现场箱体、车载箱体或未完成卸料/收箱。任何已授权的恢复订单段/作业均由 Odoo 创建，再由应用执行。

司机结果包含已签发快照版本/哈希、设备事件 ID、本地序号、动作实际时间及服务器接收时间。离线重放使用原事件 ID。Odoo 订单变更不能使根据有效已签发指示完成的工作凭证失效。冲突结果进入审核，不得静默解释为新作业的执行结果。

## 9. 标准化字段映射

### 9.1 标准 Odoo 概念与自定义字段

以下模型名是需对照实际部署核实的参考目标，不表示自定义数据库已经具备所有必需字段。标准库存模型区分库存作业单、库存移动及详细移动行；与销售关联的移动保留商业行关系。参见 [Odoo 库存作业单源码](https://github.com/odoo/odoo/blob/19.0/addons/stock/models/stock_picking.py)及[销售与库存关联源码](https://github.com/odoo/odoo/blob/19.0/addons/sale_stock/models/stock.py)。

| 应用要求 | Odoo 参考映射 | 自定义内容/解释 |
| --- | --- | --- |
| 客户/供应商与地址 | `res.partner` 及子联系人 | 保留客户/供应商角色、地址 ID 及公司访问范围 |
| 子公司/公司 | `res.company` | 明确映射；不得将公司等同于仓库 |
| 产品与商业单位 | `product.product`、`product.template`、`uom.uom` | 变体是库存标识；保留搬运单位换算字段 |
| 堆场与库存库位 | `stock.warehouse`、`stock.location` | 一个堆场可映射库存、收货、在途、隔离及报废库位 |
| 销售单/报价 | `sale.order`、`sale.order.line` | 审批、自提/配送方式、日期及运营备注可能需要自定义字段 |
| 采购单 | `purchase.order`、`purchase.order.line` | 保留供应商产品编码、要求目的地及销售需求关联 |
| 履约出库/收货 | `stock.picking`、`stock.move`、`stock.move.line` | 使用作业类型、方向、商业行关联及实际完成数量 |
| 调拨单 | 内部库存作业单/移动及路线 | 多阶段和跨公司调拨可能需要多个关联单据；不存在统一的一对一 TO 模型 |
| 库存 | `stock.quant` 及支持的库存计算 | 标准化所有权/库位范围及可用量政策；禁止直接修改 quant |
| 套件 | 产品/BOM 及组件库存移动 | 确认套件/BOM 模块和组件政策；保留父项/组件关系 |
| 退货/贷项 | 逆向库存作业及 `account.move` 退款记录 | 实物接收与财务贷项分离；NetSuite RA 不一定对应单一 Odoo 原生对象 |
| 损坏及盘点调整 | 已配置的库存移动/调整业务方法 | 区分隔离转移与报废，保留审批 |
| 报表/附件 | 报表动作及 `ir.attachment` | 通过授权桥接接口和稳定 ID 提供访问 |
| BIN 订单/订单段/作业 | MBT 自定义模型 | 技术名称待确认；实现第 8 节业务契约 |

### 9.2 必须保留的应用特有字段

| 现有含义 | 当前来源示例 | 标准化字段 |
| --- | --- | --- |
| 配送或客户自提 | NetSuite `custbody3` 及配送方式投影 | `deliveryMethod` 枚举；不得按翻译后的显示标签匹配 |
| 运营配送备注 | `custbody7` | `deliveryInstructions` |
| 要求配送日期 | `custbody4`、`shipDate` | `requestedDeliveryDate`、`shipDate` |
| 搬运数量 | `custcol_plt`、`custcol_lyr`、`custcol_sec`、`custcol_pcs` | `handlingQuantities`，附明确换算因子及产品上下文 |
| 产品换算因子 | `custitem_toplt`、`custitem_tolyr`、`custitem_tosec`、`custitem_topcs` | `handlingConversions` |
| 准确来源行 | NetSuite 内部行键及 REST `orderLine` | 稳定 `lineId` 及作业行映射 |
| 行财务值及关闭状态 | `rate`、`amount`、关闭标记 | `unitPrice`、`lineAmount`、`closed` |
| 供需关系 | 原生来源关联及应用建议/依赖标记 | 带类型的 `sourceReferences`、稳定业务操作键 |
| 退货原因 | 来源行/原因 ID，包括 `custcol_atlas_rc_so` | 映射 `reasonCode`；不得将数字原因 ID 直接跨 ERP 复制 |

当前配置的堆场编码为 `3445`、`2967`、`12441` 和 `150`，源码中分别关联 NetSuite 库位 ID `1`、`28`、`15` 和 `26`。它们仅是旧系统参考值。部署时须将各堆场映射到正确的 Odoo 仓库、公司及库位；不得假定这些值就是 Odoo ID。

### 9.3 主数据与订单快照的最低要求

客户/供应商快照包含稳定标识、显示/法定名称、启用状态、币种、付款条件、税务/信用状态、允许公司，以及带稳定子 ID 的地址/联系人。本地现场档案及运营联系人独立保留。停用后不可再用于新工作，但历史仍可访问。

产品快照包含变体标识、SKU/显示名称、启用状态、库存/销售/采购单位、换算精度、搬运因子、是否允许履约、套件/组件关系，以及现有模块需要的分类/供应商信息。

MBBS 订单快照包含公司、客户/供应商、稳定编号、来源版本、独立状态维度、来源/目标库位、地址快照、配送方式、要求日期、备注、币种及完整来源行。每行包含稳定标识、产品、描述、适用的订购/取消/履约/收货/未完成数量、单位、库位、价格/金额、关闭标记、供应关联和作业行引用。非库存费用、托盘及服务行必须明确标注类型，不能因为出现在订单上就作为实物库存发送。

## 10. 消息载荷示例

本节所有 ID、域名、地址和数量均为虚构。JSON 示例对各自声明的完整消息或片段类型提供完整内容。以 `EXAMPLE_` 开头的描述字符串是待替换占位符，不是真实凭证或实测哈希。文档生成器检查每个 JSON 代码块能否正确解析。

### 10.1 销售单更新事件

本例包含使用同一产品的两条行：一条已全部交付，另一条尚未完成，说明产品 ID 不能用于唯一标识交易行。假定库位和主数据已事先完成映射。

```json
{
  "schemaVersion": "mbbs.event.v1",
  "eventId": "10000000-0000-4000-8000-000000000001",
  "sourceInstance": "odoo-dev-example",
  "companyId": "company-mbbs",
  "entityType": "sales_order",
  "entityId": "so-4101",
  "revision": "12",
  "eventType": "sales_order.upserted",
  "occurredAt": "2026-10-22T14:00:00.000Z",
  "correlationId": "20000000-0000-4000-8000-000000000001",
  "causationId": null,
  "origin": "odoo.ui",
  "data": {
    "reference": "SO-EXAMPLE-4101",
    "customerId": "customer-201",
    "commercialStatus": "open",
    "executionStatus": "in_progress",
    "financialStatus": "not_invoiced",
    "sourceStatus": "sale",
    "deliveryMethod": "delivery",
    "shipDate": "2026-10-23",
    "requestedDeliveryDate": "2026-10-23",
    "deliveryInstructions": "Use the marked unloading area.",
    "currency": "CAD",
    "shipTo": {
      "addressId": "address-501",
      "addressLine1": "100 Example Road",
      "city": "Toronto",
      "region": "ON",
      "countryCode": "CA"
    },
    "lines": [
      {
        "lineId": "so-line-8101",
        "productId": "product-301",
        "description": "Example paving product, first allocation",
        "lineType": "stock",
        "locationId": "yard-3445-stock",
        "orderedQuantity": "10.000000",
        "fulfilledQuantity": "10.000000",
        "cancelledQuantity": "0.000000",
        "openQuantity": "0.000000",
        "uomId": "uom-piece",
        "unitPrice": "12.50",
        "lineAmount": "125.00",
        "closed": false,
        "operationLineIds": ["move-9101"],
        "sourceReferences": []
      },
      {
        "lineId": "so-line-8102",
        "productId": "product-301",
        "description": "Example paving product, second allocation",
        "lineType": "stock",
        "locationId": "yard-3445-stock",
        "orderedQuantity": "5.000000",
        "fulfilledQuantity": "0.000000",
        "cancelledQuantity": "0.000000",
        "openQuantity": "5.000000",
        "uomId": "uom-piece",
        "unitPrice": "12.50",
        "lineAmount": "62.50",
        "closed": false,
        "operationLineIds": ["move-9102"],
        "sourceReferences": []
      }
    ],
    "removedLineIds": []
  }
}
```

应用持久化接收 Webhook 后返回 202。发送方可通过受限状态接口，区分消息已接收和已成功应用：

```json
{
  "eventId": "10000000-0000-4000-8000-000000000001",
  "status": "accepted",
  "duplicate": false,
  "correlationId": "20000000-0000-4000-8000-000000000001"
}
```

### 10.2 收货确认命令

应用先记录本地收货完成，再发送此命令。Odoo 必须核实采购行与作业行是否匹配，然后返回实际数量及任何剩余/欠交作业。采购单额外非库存费用单独返回，不计入实收库存。

```json
{
  "schemaVersion": "mbbs.command.v1",
  "commandId": "30000000-0000-4000-8000-000000000001",
  "sourceInstance": "operator-app-dev-example",
  "companyId": "company-mbbs",
  "commandType": "receipt.confirm",
  "correlationId": "20000000-0000-4000-8000-000000000002",
  "occurredAt": "2026-10-22T15:20:00.000Z",
  "actor": {"type": "operator", "id": "operator-example-7"},
  "target": {"entityType": "purchase_order", "entityId": "po-4201"},
  "expectedRevision": "8",
  "data": {
    "completionId": "receiving-completion-601",
    "operationId": "incoming-picking-7101",
    "receivingLocationId": "yard-3445-stock",
    "lines": [
      {
        "lineId": "po-line-8201",
        "operationLineId": "incoming-move-9201",
        "productId": "product-301",
        "quantity": "24.000000",
        "uomId": "uom-piece",
        "conversionSnapshot": {
          "enteredQuantity": "1.000000",
          "enteredUom": "PLT",
          "factorToTransactionUom": "24.000000"
        }
      }
    ],
    "evidenceIds": ["evidence-receipt-photo-601"]
  }
}
```

### 10.3 持久化接收确认与命令结果

202 接收确认示例：

```json
{
  "commandId": "30000000-0000-4000-8000-000000000001",
  "status": "accepted",
  "duplicate": false,
  "correlationId": "20000000-0000-4000-8000-000000000002"
}
```

随后查询 `GET /commands/{commandId}` 的结果：

```json
{
  "commandId": "30000000-0000-4000-8000-000000000001",
  "status": "succeeded",
  "result": {
    "entityType": "receipt",
    "entityId": "receipt-7301",
    "sourceOrderId": "po-4201",
    "sourceRevision": "9",
    "operationId": "incoming-picking-7101",
    "lines": [
      {
        "lineId": "po-line-8201",
        "operationLineId": "incoming-move-9201",
        "quantity": "24.000000",
        "uomId": "uom-piece"
      }
    ],
    "remainingOperationIds": ["incoming-picking-backorder-7102"],
    "additionalCharges": []
  },
  "error": null
}
```

### 10.4 BIN 首次送箱快照

以下是 `mbt_order.upserted` 事件的 `data` 内容。示例将必需的最终收箱作为草稿上下文纳入；Odoo 发布完整收箱定义前，不可调度该收箱工作。完整导入还须携带明确取消的子对象 ID；空数组表示没有取消项。

```json
{
  "rentalReference": "BIN00001",
  "commercialContractId": "contract-example-1",
  "customerId": "customer-201",
  "timezone": "America/Toronto",
  "commercialStatus": "open",
  "site": {
    "siteId": "site-501",
    "address": "100 Example Road, Toronto, ON, Canada"
  },
  "services": [
    {
      "serviceId": "service-1-delivery",
      "kind": "delivery",
      "reference": "BIN00001D",
      "billingServiceId": "billing-service-1-delivery"
    },
    {
      "serviceId": "service-1-collection",
      "kind": "collection",
      "reference": "BIN00001C",
      "billingServiceId": "billing-service-1-collection"
    }
  ],
  "legs": [
    {
      "legId": "leg-1-delivery",
      "serviceId": "service-1-delivery",
      "role": "delivery",
      "reference": "BIN00001D",
      "instructionState": "released",
      "binTypeId": "bin-type-20",
      "assetId": "bin-101",
      "window": {
        "startAt": "2026-10-23T12:00:00.000Z",
        "endAt": "2026-10-23T16:00:00.000Z"
      },
      "jobs": [
        {
          "jobId": "job-1-empty-pickup",
          "sequence": 1,
          "actionCode": "collect_empty_bin",
          "reference": "BIN00001D",
          "location": {
            "kind": "yard",
            "id": "yard-3445",
            "address": "200 Example Yard Road, Toronto, ON, Canada"
          },
          "evidenceRequired": ["bin_scan", "photo"]
        },
        {
          "jobId": "job-1-deliver",
          "sequence": 2,
          "actionCode": "deliver_bin",
          "reference": "BIN00001D",
          "location": {
            "kind": "customer_site",
            "id": "site-501",
            "address": "100 Example Road, Toronto, ON, Canada"
          },
          "evidenceRequired": ["bin_scan", "photo"]
        }
      ]
    },
    {
      "legId": "leg-1-final-collection",
      "serviceId": "service-1-collection",
      "role": "collection",
      "reference": "BIN00001C",
      "instructionState": "draft",
      "binTypeId": "bin-type-20",
      "assetId": null,
      "window": null,
      "jobs": []
    }
  ],
  "dependencies": [],
  "cancelledServiceIds": [],
  "cancelledLegIds": [],
  "cancelledJobIds": []
}
```

### 10.5 换箱配置与依赖片段

以下片段展示服务/依赖字段，不是独立的完整订单快照。完整事件必须包含被引用的订单段/作业及租赁聚合其余内容。段内顺序也必须确保先取箱、后卸料。

同箱、先收后送：两个订单段都引用 `bin-101`；送箱使用卸料后的同一箱体，不额外生成取空箱动作。

```json
{
  "serviceId": "service-1-exchange-1",
  "kind": "exchange",
  "exchangeNumber": 1,
  "reference": "BIN00001X-1",
  "sequence": "collection_first",
  "reuse": "same_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-101",
  "billingServiceId": "billing-service-1-exchange-1",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x1-dump",
      "dependentJobId": "job-x1-deliver",
      "sameDayAsJobId": "job-x1-pickup"
    }
  ]
}
```

异箱、先送后收：替换箱为 `bin-102`，旧箱收回任务仍绑定 `bin-101`；后续取旧箱没有同日要求。

```json
{
  "serviceId": "service-1-exchange-2",
  "kind": "exchange",
  "exchangeNumber": 2,
  "reference": "BIN00001X-2",
  "sequence": "delivery_first",
  "reuse": "different_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-102",
  "billingServiceId": "billing-service-1-exchange-2",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x2-deliver",
      "dependentJobId": "job-x2-pickup",
      "sameDayAsJobId": null
    }
  ]
}
```

异箱、先收后送：取旧箱既是送达替换箱的前置条件，也是同日规则的锚点。旧箱的卸料/归还仍为独立未完成义务：

```json
{
  "sequence": "collection_first",
  "reuse": "different_bin",
  "collectionAssetId": "bin-101",
  "deliveryAssetId": "bin-102",
  "dependencies": [
    {
      "prerequisiteJobId": "job-x3-pickup",
      "dependentJobId": "job-x3-deliver",
      "sameDayAsJobId": "job-x3-pickup"
    }
  ]
}
```

### 10.6 关联后续送箱的最终收箱

以下是已发布收箱段的片段。取箱、卸料后，衔接另一份租赁中已有的送箱作业。不能为共享目的地再创建一份归还/送箱作业。完整聚合须提供下方依赖；调度前必须已知或获取被引用的目标聚合。

```json
{
  "legId": "leg-1-final-collection",
  "serviceId": "service-1-collection",
  "role": "collection",
  "reference": "BIN00001C",
  "instructionState": "released",
  "assetId": "bin-102",
  "binTypeId": "bin-type-20",
  "window": {
    "startAt": "2026-10-26T12:00:00.000Z",
    "endAt": "2026-10-26T18:00:00.000Z"
  },
  "jobs": [
    {
      "jobId": "job-1-final-pickup",
      "sequence": 1,
      "actionCode": "pickup_bin",
      "reference": "BIN00001C",
      "location": {
        "kind": "customer_site",
        "id": "site-501",
        "address": "100 Example Road, Toronto, ON, Canada"
      },
      "evidenceRequired": ["bin_scan", "photo"]
    },
    {
      "jobId": "job-1-final-dump",
      "sequence": 2,
      "actionCode": "dump_bin",
      "reference": "BIN00001C-DP",
      "materialId": "material-example-1",
      "location": {
        "kind": "dump_site",
        "id": "dump-site-301",
        "address": "300 Example Dump Road, Toronto, ON, Canada"
      },
      "evidenceRequired": ["receipt", "photo"]
    }
  ],
  "linkedDestination": {
    "orderId": "bin-order-2",
    "legId": "leg-2-delivery",
    "jobId": "job-2-deliver",
    "reference": "BIN00002D"
  },
  "dependencies": [
    {
      "prerequisiteJobId": "job-1-final-dump",
      "dependentJobId": "job-2-deliver",
      "sameDayAsJobId": null
    }
  ]
}
```

如果目的地是堆场，则以第三个 `return_bin` 作业替换关联引用，目的地为批准堆场，编号为 `BIN00001-R`。最终收箱关闭前，必须完成其关联目的地作业以及所有更早的未完成收箱义务。

### 10.7 作为 Odoo 计费依据的 MBT 执行结果

以下仅追加报告描述一项已接受的卸料作业，回传测量事实和收据凭证，不进行价格计算。作业/订单段 ID 必须存在于所引用的已签发订单版本中。

```json
{
  "schemaVersion": "mbbs.command.v1",
  "commandId": "30000000-0000-4000-8000-000000000002",
  "sourceInstance": "operator-app-dev-example",
  "companyId": "company-mbt",
  "commandType": "mbt.execution.report",
  "correlationId": "20000000-0000-4000-8000-000000000003",
  "occurredAt": "2026-10-26T15:40:00.000Z",
  "actor": {"type": "driver", "id": "driver-example-4"},
  "target": {"entityType": "mbt_order", "entityId": "bin-order-1"},
  "expectedRevision": null,
  "data": {
    "executionEventId": "40000000-0000-4000-8000-000000000001",
    "legId": "leg-1-final-collection",
    "jobId": "job-1-final-dump",
    "actionCode": "dump_bin",
    "billingServiceId": "billing-service-1-collection",
    "issuedOrderRevision": "9",
    "issuedSnapshotHash": "EXAMPLE_SHA256_OF_ISSUED_INSTRUCTIONS",
    "assignmentRevision": "3",
    "clientSequence": 7,
    "acceptedAt": "2026-10-26T16:05:00.000Z",
    "truckId": "truck-example-2",
    "assetId": "bin-102",
    "executionStatus": "completed",
    "measurements": {
      "netWeight": {"value": "1.250000", "uom": "tonne"},
      "distance": {
        "value": "18.400000",
        "uom": "km",
        "basis": "reviewed_odometer_difference"
      }
    },
    "receiptId": "dump-receipt-example-51",
    "evidenceIds": ["evidence-dump-photo-51", "evidence-dump-receipt-51"],
    "exceptions": []
  }
}
```

### 10.8 异常与版本冲突示例

`mbt.exception.report` 的 `data` 示例，外层须使用标准命令信封：

```json
{
  "exceptionId": "exception-example-17",
  "orderId": "bin-order-1",
  "legId": "leg-x1-delivery",
  "jobId": "job-x1-deliver",
  "code": "SAME_DAY_PROMISE_MISSED",
  "actualOccurredAt": "2026-10-24T13:10:00.000Z",
  "prerequisiteOccurredAt": "2026-10-23T15:30:00.000Z",
  "assetId": "bin-101",
  "physicalState": "at_customer",
  "recoveryRequired": false,
  "evidenceIds": ["evidence-late-delivery-17"],
  "note": "Actual delivery retained; commercial review requested."
}
```

通用 409 响应结构如下；对于异步拒绝的命令，内部错误对象也通过 `error` 字段返回：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The source order changed before the requested operation.",
    "retryable": false,
    "correlationId": "20000000-0000-4000-8000-000000000002",
    "details": {"expectedRevision": "8", "actualRevision": "9"}
  }
}
```

## 11. 库存、会计与凭证保障

部分收货和部分交付须按已配置的 Odoo 欠交政策保留剩余需求，不得自动取消剩余数量。履约结果引用实际库存作业单/移动 ID 及完成数量，包括套件组件移动。适配层不能对同一次实物操作同时扣减套件父项库存与组件库存。

调拨须区分发出与接收，并保留在途阶段。本地 CO 移动不必然代表新增商业调拨；映射前应记录其现有库存影响。跨公司工作保留各公司独立的单据标识及审批。

退货须区分授权、实物接收、检验/处置和贷项。贷项不能证明货物已退回；收到退货也不代表已授权财务退款。托盘退货/收费保留独立的产品、原因及单位含义。会计分录由 Odoo 原生业务方法与已配置政策决定。

采购收货费用的来源行、金额、币种及财务记录须与实收库存分开报告。应用最终确认 ERP 过账状态前，须保留现有核验行为。

照片和收据元数据通过 JSON 传输，大型二进制内容不嵌入 JSON。保留现有存储与访问控制。Odoo 通过凭证接口，按稳定 ID 获取已授权凭证，或保存校验和已核实的授权附件副本。会过期的 URL 只是传输地址，不是持久凭证标识。接口可返回字节流或短期授权 URL，不提供长期公开链接。

采集凭证以应用为权威来源。分别保留报告发生时间、服务器接收时间、更正历史及来源。手机/Samsara GPS 可提供运营背景，但不能静默作为财务计费距离凭证。Odoo 接收计费决策所需的距离依据、已复核测量值、重量单位、原始卸料收据及异常信息。

## 12. 错误、安全与运行限制

| HTTP 状态 | 含义 | 调用方操作 |
| --- | --- | --- |
| 200 | 读取成功，或已知重复项/结果 | 检查业务处理状态 |
| 202 | 已持久化接收，等待处理 | 按 ID 跟踪结果；不得标记 ERP 工作完成 |
| 400 | 正文格式错误或缺少必填信封字段 | 修正请求，不得盲目重试 |
| 401 / 403 | 凭证/签名无效或访问范围被禁止 | 暂停受影响发送器，修复配置/授权 |
| 404 | 在授权范围内找不到实体、命令或凭证 | 修复映射；若先前接收结果不明确，按原 ID 重发同一命令 |
| 409 | ID/内容、来源版本或已签发指示冲突 | 获取当前状态，复核后再提交 |
| 410 | 重放游标过期或资源已明确退役 | 按明确恢复流程处理 |
| 413 / 422 | 载荷过大，或业务结构不支持/无效 | 修正载荷，或约定受支持的版本化扩展 |
| 429 | 触发速率限制 | 遵守 `Retry-After` |
| 500 / 502 / 503 / 504 | 临时处理/传输失败 | 适用时先查询结果，再用同一标识重试 |

使用 HTTPS、最小权限身份、公司范围权限，以及独立的开发/预发布/生产凭证。密钥保存在服务端配置中。日志隐藏凭证、个人数据及附件 URL，改为记录事件/命令/实体 ID、版本、耗时、尝试次数和结果。生产接口响应不得暴露原生堆栈信息。

建议初始限制：JSON 正文 1 MiB，每次请求一条事件或命令，每个聚合最多 500 条订单行或作业，每个集成最多同时发出四个请求，HTTP 请求超时 15 秒。在商定试点负载下，已持久化事件须在两秒内确认接收。实际限制通过 capabilities 公布。更大聚合须采用明确引入的版本化扩展，不得截断，或将原子 BIN 订单静默拆为互不关联事件。

Webhook 接收速率与工作进程并发数是独立限制。使用有界队列及带租约、支持崩溃恢复的工作进程。沿用现有应用处理 NetSuite 请求的优先级，优先处理操作员过账和新运营工作，再执行全历史补录。

监控投递/应用延迟、队列深度、重试次数、冲突、未映射 ID、命令结果、对账偏差及即将到期凭证。每个失败事项必须有可搜索关联 ID 和受控重试路径。Odoo 不可用不能导致已从司机接收的本地执行记录或凭证被删除。

## 13. 后续应用实施改动

本文尚未实现以下改动。应用团队应基于现有服务和队列建立 ERP 适配边界，而非大范围机械替换 NetSuite 名称。

- 增加明确的提供方/来源标识和映射表，保留现有本地记录 ID 及旧标识。审查客户、订单行、过账及退货代码中对数字 ID 的假设。
- 增加 Odoo 事件收件箱/命令发件箱、范围受控的服务认证、重放/对账工作进程及运营状态视图。应用快照时保留本地流程字段。
- 将标准化 Odoo 记录映射至现有订单/客户/库存投影及 SSE 刷新机制。切换 ERP 读取来源不应要求重写界面。
- 将已启用的 MBBS 业务写入经 Odoo 桥接模块处理，采用稳定操作 ID 及写后核验。保留堆场/功能开关和来源校验。
- 将 MBT 聚合导入现有 BIN 计划/执行模型。对于已迁移工作，商业定义设为只读，变更请求转交 Odoo；保留应用的调度、保管及凭证控制。
- 对 Odoo 所属工作，停用后续本地 MBT 报价、下单、费用计算及会计提交。保留历史合同、不可变账单版本及旧工作复核能力。
- MBT 执行/更正按事件仅发布一次，并附父服务引用。执行拆分或镜像 Odoo 确认不能触发第二次计费。

Odoo 团队负责桥接模块、标准化投影、业务命令处理器、可靠出站事件、范围权限、自定义 BIN 定义及基于凭证的计费。双方共同负责映射工作表、共享示例、契约验收测试和切换证据。

## 14. 迁移、切换与恢复

| 阶段 | 工作 | 完成依据 |
| --- | --- | --- |
| 1. 确认与映射 | 核实版本/版本类型/托管；映射公司、堆场、产品/单位、客户、行、BIN 定义及原生/自定义模型 | 已审核映射清单和 capabilities 响应 |
| 2. 只读首次导入 | 导入主数据及活动/未完成业务；捕获水位并重放变更；隔离 Odoo 影子投影 | 数量、状态、未映射及冲突记录已对账 |
| 3. 流程比较 | 使用虚构/测试工作比较来源记录与事件行为，验证现有 MBBS 和自定义 BIN 规则 | 验收用例通过；无生产双重过账 |
| 4. 受控试点 | 选定公司/堆场/流程及新 MBT 订单，为每项选中操作启用唯一 ERP 写入方 | 端到端验证运营、过账及计费凭证结果 |
| 5. 生产切换 | 清空或解决旧队列；记录切换水位与写入归属；按范围切换读写来源 | 无未解决的不确定过账；应用与 ERP 状态已对账 |
| 6. 稳定与退役 | 监控偏差、事件、重试及旧工作；剩余义务完成后停用过时 NetSuite 集成 | 完成支持交接、审计保留及约定的回退窗口关闭 |

切换归属按公司、流程及业务操作定义，不能只依赖一个全局环境开关。已签发司机快照和正在进行的 NetSuite 过账须有明确完成策略。旧过账结果不确定时，先对账，再授权对应 Odoo 操作。不能将旧 NetSuite 履约/收货命令盲目重放至 Odoo。

对尚未结束的 BIN 租赁，迁移当前实体箱体、未完成旧收箱、已发布/签发作业、保管/预留、已完成凭证及计费服务引用。Odoo 不得将历史送箱/换箱重新生成新任务。历史发票、押金及期初商业余额需要由 Odoo 团队主导的会计迁移；该独立财务转换不由本文 API 规范定义。

回退先停止受影响的新写入，并冻结相应队列。切回写入方之前，逐项核对 Odoo 已提交操作。代码回退或恢复旧数据库不会撤销 ERP 库存/会计活动。保留映射表、事件/命令日志及已完成凭证，必要时采用获批的业务补偿操作。

迁移演练或集成测试不得使用生产凭证或生产数据卷。在应用宿主机上，使用仓库的一次性测试运行器、`mbbs-tests.slice`、受限容器及无条件清理。[仓库宿主机政策](../AGENTS.md)适用，包括移除一次性容器、卷、网络及生成的测试产物。

## 15. 验收场景

以下是实施验收要求，并不表示 Odoo 集成已经通过测试。请使用虚构测试数据及实际安装的 Odoo 测试环境。

| ID | 场景 | 必须满足的结果 |
| --- | --- | --- |
| A01 | 客户/产品更新，随后停用 | 标准投影更新；本地现场备注/历史保留；停用记录不能发起新工作 |
| A02 | 两条商业行使用同一产品 | 每次收货/履约准确对应商业行与作业行 |
| A03 | PLT/LYR/SEC/PCS 与销售/采购/库存单位不同 | 按记录因子对账数量；缺失/无效换算阻止过账 |
| A04 | 部分收货或履约 | 仅过账实际数量；剩余需求及欠交关联正确 |
| A05 | 套件订单与组件移动 | 组件/父项关联正确；实物库存移动不重复 |
| A06 | 调拨已发出但未收货 | 在途状态正确；不能根据来源发出凭空生成目标收货 |
| A07 | 商品/托盘退货及贷项 | 实物移动与财务贷项分别授权且可追溯 |
| A08 | 收货存在额外非库存费用 | 费用不改变库存数量；费用来源及金额已核验 |
| A09 | 应用过账前来源数量/库位/审批变化 | 预期版本/来源校验阻止过时过账；操作员工作保留以供复核 |
| A10 | 重复事件或命令，包括并发重试 | 收件箱/业务结果只产生一次；同 ID 不同内容形成冲突 |
| A11 | 较旧版本或同版本冲突数据迟到 | 旧数据不能覆盖当前状态；同版本冲突进入审核 |
| A12 | Odoo 已提交命令，但响应丢失 | 按原 ID 查询找到原结果；不产生第二笔交易 |
| A13 | Webhook 遗漏、接收方停机或来源重启 | 已提交变更日志及游标恢复状态，不丢事件 |
| A14 | 缺少客户、箱体或父作业 | 可见地等待映射/依赖；不编造引用，不提前调度 |
| A15 | 无效签名、过时传输时间戳或错误公司 | 应用前拒绝；带新签名的合法延迟事件仍可处理 |
| A16 | MBT 首次送箱 | Odoo 定义的订单段/作业进入调度；准确执行箱体、来源及凭证要求 |
| A17 | 同箱、先收后送换箱 | 同一本地日先取箱、卸料、再送箱；不重复取空箱 |
| A18 | 异箱、先收后送换箱 | 先取旧箱，再送替换箱；旧箱未完成卸料/恢复义务保留 |
| A19 | 先送后收及重叠换箱 | 使用不同替换箱；后续收箱保留原箱体义务 |
| A20 | 最终收箱时仍有更早未完成工作 | 收回当前箱体；租赁不得提前关闭 |
| A21 | 收箱关联另一送箱 | 共享目的地只有一个实物作业及一组凭证；依赖与保管关系保留 |
| A22 | 两个调度员同时占用箱体或更换车辆 | 独占占用及交接记录防止冲突保管关系 |
| A23 | Odoo 修订/取消已签发或已开始作业 | 不静默改写指示；执行审核/恢复，获授权后明确重新签发 |
| A24 | 离线重复、迟到、跨设备或更正结果 | 仅一次移动；保留原发生时间及快照；更正只追加，不覆盖 |
| A25 | 多伦多夏令时边界或违反同日承诺 | 业务日期逻辑正确；保留逾期实际完成并标记异常 |
| A26 | 拆分订单段、关联工作及重试 MBT 凭证 | Odoo 仅接收一次事实并引用父计费服务；无重复收费 |
| A27 | 首次导入与更新/取消并发 | 水位重放及版本检查最终一致；不跳过较低但已提交事件 |
| A28 | 切换时存在旧队列及未结束 BIN 租赁 | 唯一过账方；保留旧标识、凭证和实物义务 |
| A29 | Field Sales、SCM 及特殊库存命令 | 客户/供应商、商业价格、供需关联及稳定建议标识正确 |
| A30 | PDF/凭证访问及凭证轮换 | 授权读取与校验和有效；旧凭证及跨公司越权访问失败 |

最低发布依据包括双方契约测试结果、已对账试点记录、故障/恢复演练、监控截图或简明审计记录，以及明确负责人的切换/回退检查清单。载荷语法通过并不能证明运营行为正确。

## 16. Odoo 版本与原生 API 说明

无论采用哪个 Odoo 版本，上述自定义接口都是集成边界。只有确认版本、权限及已安装模型后，才可在适配器内部或诊断中使用原生 API。

Odoo 在 19 版引入 JSON-2，使用 Bearer API key 调用 `/json/2/{model}/{method}`。模型/方法因数据库而异，数据库的 `/doc` 描述可用内容。每次调用都有独立事务，因此相互依赖的业务操作应封装在一个合适的方法内。Odoo 文档还说明外部 API 访问受商业套餐限制，须核实实际部署权益。参见[官方 JSON-2 API 文档](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html)。

以下原生 JSON-2 请求仅用于已核实支持该接口的 Odoo 19+ 环境示例，不属于本文自定义桥接接口：

```http
POST /json/2/res.partner/search_read
Authorization: Bearer <ODOO_NATIVE_API_KEY>
Content-Type: application/json
X-Odoo-Database: <APPROVED_DATABASE>
```

```json
{
  "domain": [["id", "=", 201]],
  "fields": ["id", "name", "active"],
  "limit": 1
}
```

不得假定较旧版本存在 JSON-2，也不能未经核对目标版本及生命周期，就将旧 XML-RPC/JSON-RPC 示例直接用于本契约。本文不假定确切弃用日期。

托管方式必须支持自定义模块：[Odoo Online 文档](https://www.odoo.com/documentation/19.0/administration/install/online.html)说明 Online 不兼容自定义模块；[Odoo.sh 文档](https://www.odoo.com/documentation/19.0/administration/odoo_sh/getting_started/create.html)介绍自定义模块部署。实施前必须确认实际环境支持桥接模块。

仅有前端访问权限时，管理员通常可在“设置 → 常规设置 → 关于”查看版本类型及版本。如果无法访问此区域，由 Odoo 开发人员提供构建版本和已安装模块清单即可；审核本文不需要用户具备命令行权限。

## 17. 部署确认清单

以下是与环境有关的事实及审批项目，不代表 MBT 业务归属尚未确定。不得填入猜测的生产标识。

| 项目 | 负责人 | 需确认内容 |
| --- | --- | --- |
| Odoo 版本、版本类型及托管 | Odoo 开发人员 | 准确版本/构建号、自定义模块支持、适用的外部 API 权益 |
| 环境与接口地址 | 双方团队 | 开发/预发布/生产 HTTPS 地址、来源实例 ID、路由及网络访问 |
| 公司与库位映射 | Odoo 团队及运营 | MBBS/MBT 公司、堆场、仓库/在途/损坏库位及跨公司路线 |
| 客户/产品/单位映射 | 数据迁移负责人 | 稳定 ID、变体、地址 ID、换算因子、精度及历史映射 |
| 自定义 BIN 模型映射 | Odoo 开发人员 | 技术模型/字段与现有订单/服务/订单段/作业逻辑的对应关系 |
| 现有 BIN 编号及实物状态 | 运营及双方团队 | 编号分配权威、当前箱体、已签发作业及未完成义务 |
| 过账与审批矩阵 | 业务负责人及应用团队 | 各流程/堆场触发器与开关、命令角色、切换时唯一写入方 |
| 计费与凭证政策 | Odoo 计费负责人 | 父服务去重、接受的测量、更正及交叉收费 |
| 认证与轮换 | 双方团队 | 凭证实现、公司范围、HMAC 密钥、轮换及到期流程 |
| 负载与恢复目标 | 运营及双方团队 | 峰值业务量、已验证限制、告警分派、重放保留及恢复目标 |
| 现有未完成交易 | 迁移负责人 | NetSuite 完成策略、未解决过账及来源至 Odoo 标识映射 |
| 切换与回退归属 | 业务/技术负责人 | 指定决策人、冻结窗口、对账及业务补偿流程 |

## 18. 依据与文档维护

### 18.1 已审阅的应用来源

下列链接均相对本仓库，标明 Odoo 适配层必须支持的现有行为。对于已迁移工作，本文新的 MBT 职责归属取代早期本地商业流程。

| 来源 | 使用依据 |
| --- | --- |
| [应用路由](../server/src/server.js) | 订单/客户/IF-IR Webhook、同步/管理控制、运营及商业接口 |
| [NetSuite 适配器](../server/src/netsuite.js) | ERP 读写清单、来源字段、订单与交易操作、PDF 获取 |
| [订单 Webhook 队列](../server/src/netsuite-order-webhook-queue-repository.js)及[策略](../server/src/netsuite-order-webhook-queue-policy.js) | 持久化收件箱、重复、修订版本、重试/租约行为 |
| [客户 Webhook](../server/src/netsuite-customer-webhook.js) | 标准客户导入、来源标识、停用/重复/冲突处理 |
| [过账适配器](../server/src/operator-netsuite-posting-netsuite-adapter.js)及[过账策略](../server/src/operator-netsuite-posting-policy.js) | IF/IR 核验、套件、库位与功能开关 |
| [收货费用](../server/src/operator-netsuite-receipt-charges.js)及[行标识](../server/src/netsuite-order-line.js) | 非库存费用与准确交易行映射 |
| [配送指示适配器](../server/src/delivery-instruction-netsuite.js) | 限定字段编辑、乐观比较、写后核验 |
| [SCM 采购载荷](../server/src/smart-scm-purchase-netsuite.js)及[调拨依赖适配器](../server/src/transfer-dependency-netsuite.js) | 采购建议、搬运数量及依赖 |
| [退货适配器](../server/src/return-netsuite.js)及[损坏适配器](../server/src/inventory-damage-netsuite.js) | 退货/贷项/实物移动分离及损坏操作 |
| [Field Sales 运行模块](../server/src/field-sales/runtime.js)及[数据仓储](../server/src/field-sales/repository.js) | 客户/目录读取及本地报价转销售单流程 |
| [BIN 流程规范](../server/test/bin-order-workflow-spec.md) | 现有编号、换箱/收箱规则、保管关系及离线验收要求 |
| [BIN 领域逻辑](../server/src/mbt/bin-order-workflow-domain.js)、[执行逻辑](../server/src/mbt/bin-order-workflow-execution.js)及[数据库结构](../server/migrations/297_bin_order_workflows.sql) | 执行部分/作业、依赖、同日行为、当前箱体及关闭义务 |
| [MBT 早期设计](mbt/phase-3-local-operations-shadow-billing.md) | 历史本地创建/计费职责；后续由已确认的 Odoo 归属替代 |
| [MBR 边界](../server/src/mbr/README.md) | 独立模块，不包含在 NetSuite 替换范围 |

### 18.2 维护与校验

先编辑本中文 Markdown 文件。使用仓库内仅依赖 Python 标准库的生成器，生成临时 DOCX，再转换为 PDF。在受限、一次性的文档构建环境中执行：

```sh
python3 docs/tools/build_odoo_integration_doc.py \
  --source docs/odoo-api-webhook-integration.zh-CN.md \
  --output "$MBBS_TEST_ARTIFACT_DIR/odoo-api-webhook-integration.zh-CN.docx" \
  --language zh-CN
libreoffice -env:UserInstallation="file://$MBBS_TEST_ARTIFACT_DIR/lo-profile" \
  --headless --convert-to pdf --outdir "$MBBS_TEST_ARTIFACT_DIR" \
  "$MBBS_TEST_ARTIFACT_DIR/odoo-api-webhook-integration.zh-CN.docx"
```

PDF 转换环境需安装 LibreOffice 及中文字体 Noto Sans CJK SC。校验并检查排版后，将生成的 PDF 复制为 `docs/odoo-api-webhook-integration.zh-CN.pdf`。`MBBS_TEST_ARTIFACT_DIR` 由仓库一次性运行器为每次运行单独提供。

生成器保留标题、表格、代码示例及链接，并在临时 DOCX 元数据中嵌入 Markdown 的 SHA-256。生成前检查 JSON 示例及本地源码链接；`--check` 配合相同来源、输出及语言参数，可检查现有 DOCX 包和文本一致性而不重写。PDF 另须检查中文字体、可提取文本、章节及示例内容。这些是文档检查，不是应用测试或真实 Odoo 集成测试；在此宿主机上执行检查时须遵守一次性受限运行政策。

保留中文 Markdown、PDF 交付件及可复现生成器。临时 DOCX、渲染预览、校验产物和日志均在完成后清理。目标 Odoo 版本确认后重新核对原生 API 引用；业务契约发生变化时更新文档版本。
