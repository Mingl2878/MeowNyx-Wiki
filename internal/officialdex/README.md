# officialdex

纯 Go、无 I/O 的腾讯图鉴到 legacy 提案构建器。生产代码仅使用标准库，不依赖 `main`、浏览器、Node、HTTP 或磁盘。合成测试验证同仓 canonical 的 Import/Export 契约，另有显式启用的真实资料只读回环审计。

```go
proposal, err := officialdex.BuildProposal(officialdex.LegacyFiles{
    Monsters: monstersJSON,
    Moves: movesJSON,
    Types: typesJSON,
    Wiki: wikiJSON,
}, officialJSON)
```

## 调用方职责

- 读取、外部备份、版本锁、下载主源、预览确认、原子提交及失败回滚全部由调用方负责；构建提案不等于应用。
- `err != nil` 表示 JSON、整体 schema 或本地身份完整性失败；没有可用提案。
- `Issues` 必须展示。`blocking` 是真实冲突/非法身份或技能，`review` 是未证明映射、不可用学习面或旧机制需复核，`warning` 是来源信息不足等保护提示。未解决项不以空数据或零值替换。
- `Proposal.Files` 是四份完整 legacy JSON，输入字节不修改；`Types` 始终原样返回；其它文档语义未变时原字节返回。`Files` 不随提案 JSON 报告序列化。
- `Changes` 记录业务变化；学习关系的 before/after 含完整 `name/source` 顺序，不重复主技能描述。移出活跃集合的关系仍在 before 中；inherit 改 own 的 before 是任何父表纠正前的原有效学习面和原顺序，不是空的非活跃 Wiki 表。派生名称、描述、类别、属性刷新只累计 `Stats.RefreshedLearningRows`。
- `SourceSHA256` 对传入源字节求散列，不包含时间戳，重复输入结果确定。

## canonical v2 / Legacy 边界

- `catalog.Parse([]byte)` 是读取迁移入口：schema v1 只在内存里按旧父图建立一次本地成员快照，返回 schema v2；未知未来版本拒绝。`Validate/Marshal` 面向完整 v2，不自动补写缺失数组。
- `Monster.EvolutionMembers []int` / JSON `evolution_members` 是必须显式提供的逐条列表；`Monster.LeaderOfID int` / JSON `leader_of_id,omitempty` 是独立首领来源。成员不能重复/悬空，前置与首领不能自指或成环；普通前置必须属于自己的成员，普通与首领前置不能并存。MainFormID 不承担首领化。
- `ExportLegacy` 始终输出同名 `evolution_members` 数组和 `leader_of_id`（无值为 null，与普通前置一致）。`ImportLegacy` 保留显式数组含 `[]`；纯 v1 缺成员时一次旧图快照，混合手工新增缺成员时只补该条 `[self, explicit ordinary predecessor]` 最小默认，不重建其他 v2 关系。
- 浏览器/Node `CatalogData.upgrade(c)` 纯克隆并验证后返回 v2，`toLegacy(c)` 内部使用同一迁移入口。不修改传入对象，不按 v2 父链重建成员。

## 身份与 2026-10-30 已审核迁移

本地 monster ID 权威，源 `d` 键/`l.i` 仅在源内部使用。一般匹配需要完整规范名称、图鉴编号和明确形态同时通过；不用头像、数字 ID 或基础名合并形态。罗马数、宽字符、横杠、括号规范沿用现有规则；`Original` 仅对应“本来的样子”，**不全局把冬天等同本来**。

本次用户明确批准的狭窄记录见 [reviewed_identities.go](<reviewed_identities.go>)。每条同时核对源 ID、名称、dex、form，以及稳定本地 ID、dex、旧或新名称/形态完整组合和分类。缺失、混合状态、冲突或字段改变均拒绝，不按数字兜底，也不重建 ID：

| 源 ID / 正式身份 | 稳定本地 ID / 旧身份 |
| --- | --- |
| 43 雪绒鸟・本来的样子 / NO.018 | 40 雪绒鸟・冬天的样子 |
| 44 冬羽雀・本来的样子 / NO.019 | 44 冬羽雀・冬天的样子 |
| 48 岚鸟・本来的样子 / NO.020 | 48 岚鸟・冬天的样子 |
| 55 霜翼领主・本来的样子 / NO.020 | 49 霜翼领主・冬天的样子 |
| 366 香草甜甜・樱桃饰品 / NO.235 | 365 香草甜甜・Original |
| 369 圣代甜甜・樱桃巧克力口味 / NO.236 | 368 圣代甜甜・Original |
| 515 加油蟹・两只海葵的样子 / NO.361 | 512 加油蟹・Original |
| 572 黑化加尔・黑化的样子 / NO.417 | 569 黑化加尔・default |
| 601 新月鹭 / NO.446 | 615 新月鸷・default |
| 602 月辉鹭 / NO.447 | 606 月辉鸠・default |
| 603 月使鹭纳 / NO.448 | 604 月使鸷纳・default |
| 610 玳龟 / NO.455 | 610 斑鱼・default |

- 这些记录采用官方正式名称和明确形态；旧完整显示名、旧裸名、monster aliases、Wiki aliases 均保留。canonical 把别名投影在 Wiki 中，因此不在每轮重复制造 monster aliases 字段。
- 主形态改标签时，仅更新能按旧名称＋旧形态解析到该主形态的 `main_form_name`；ImportLegacy 后 `MainFormID` 保持原稳定值。不会批量替换其他冬季标签。
- 未迁移和已迁移输入都可重复使用；先完成所有身份映射，拒绝多源争用同一个本地 ID，再迁移及更新普通字段。
- `_source_ref` 只保存来源证据；即使源 ID 相同也不能省略名称/编号/形态核验。

### 仅三条新增复杂身份的特殊放行

| 已批准源身份 | 独立记录策略 |
| --- | --- |
| 344 烈焰狂战士・首领形态 / NO.218 | `is_leader_form=true`、阶段“首领形态”；有效 forms 支持单独 `leader_of_id=343`，不覆盖烈火守护 |
| 382 满月砣・上弦的样子 / NO.238 | 保留上弦 form，独立 own、无多形态、无 MainFormID |
| 383 满月砣・下弦的样子 / NO.238 | 保留下弦 form，独立 own、无多形态、无 MainFormID |

- 新本地 ID 从已有最大非保留 ID 加一，跳过 9001；当前 619 条输入产生 620、621、622。月亮砣 379/380 不被覆盖。
- 三条源 `s` 都为空：烈焰狂战士有明确首领 `f` 可用；满月砣上下弦已获用户独立确认，分别 `leader_of_id=379/380`、`is_leader_form=true`、阶段“首领形态”。不改其 MainFormID/图片/学习面；旧未确认说明仅在与旧固定说明完全相等时替换。后续源阶段缺失不能撤回已知首领身份。
- 仅精确白名单可绕过复杂 form 的拒绝门；仍要求资质、属性、特性、完整非空有效学习面及来源交叉证据。空字符串阶段的已审核例外不涵盖损坏/null 值。
- 一般完整、独立可证、明确 `f == ""` 且 `forms == []` 的普通新增仍遵循原规则；未知复杂形态不自动新增。同 dex/同 form 不同名称可能是改名，不能猜新身份。
- 既有 `season`、placeholder、等级、自定义扩展保留；冥古龙 619 未映射，保持测试占位，不借学习面。

## 官方学习面为准，传说仍是本地展示分类

见 [学习面实现](<moves.go>)、[学习面授权测试](<learning_authority_test.go>)。

1. 只有可靠映射、`sk.s/b/t` 三数组都完整有效、所有主技能均可唯一关联且集合非空，才核正学习面。空、缺组、损坏或冲突源不能清空，也不能以部分新增表覆盖完整旧面。
2. 默认/血脉/技能石保持三个独立来源。官方存在而本地没有则新增，官方明确没有的本地学习关系从活跃集合移出；不删除主技能。本地独有主技能仍保留并提示。
3. 同一技能的本地“传说”仅与官方 `sk.s` 等价，保留传说显示，不再加重复默认，也不再反复列 `legend_source_mapping` 待确认。官方根本没有该技能时，传说关系也按授权移出；不跨精灵传播分类。
4. 顺序采用官方 `s → b → t` 及各数组首次出现顺序。同一有效关系已有多个本地行时保留全部行及其相对顺序、扩展（包括已存在的默认＋传说行），不按技能名误去掉其他来源。重复官方证据不制造新的重复行。这是**保留已有有效重复，而非重复计入身份集合**。
5. 先核正每个可靠映射的 own 父表，再按继承依赖父优先比较有效集合（默认与传说等价，忽略重复次数/排序）。相同保留 inherit；真实不同只将该精灵改 own、移除 from_id、使用其完整官方表。不因孩子差异修改共同父表或兄弟。上游 own 修正后已相同的孩子不会无谓脱离继承。
6. 主技能更新与学习关系独立：普通基础威力、能耗、描述、类别和属性同步；已知特殊威力、公式、未知威力显示和规则字段保留。实质描述变化记录规则待审，不按描述猜公式。

## 普通字段与保护提示

- 六维、属性、特性只使用详情明确有效值，缺失/非法不变成零或空；属性引用本地 types，弱点/抵抗不从源列表重建。
- 旧特性描述若为“官方摘要首行＋本地多行补充”，仅在首行语义与官方一致时将余文保留为精灵独立 `_trait_notes`。已有 notes 不覆盖、不重复拼接；通过 Change/Issue 区分来源。
- 完整有效 `evo` 经完整来源→本地映射后，按原顺序替代该条 `evolution_members`，不要求自身、对称或拓扑顺序，不推闭包。显式 `[]` 合法并清除普通前置；仅自身同样清除普通前置。普通前置只保留成员允许的已有/单独确认边，不凭相邻、同 NO 或顺序造边。
- 缺失/null/非法/重复/身份冲突/任何成员未映射均没有可用源成员候选：`warning:source_relationship_unavailable`、`field=evolution_members`，保旧而不是清空或导入部分列表。forms 不可用对应 `field=leader_of_id`；独立人工确认成功的首领候选改发 `confirmed_leader_source_incomplete/forms` 信息提示，不禁掉该候选。
- 首领化先拆入 `leader_of_id` 并清除普通边，再做配套普通修正。详见 [关系登记](<relations.go>) 的14确认与4配套条目。6个确认首领及2满月需双端稳定ID/源ID/名称/NO/形态匹配，可独立于 forms 登记；烈焰首次及其他历史首领旧边另需正确角色、同 dex 和 forms 交叉支持。不遍历同 dex 猜其他首领。已有 leader_of 在源信息缺失时保留。
- 关系 Changes 正常包含 `evolution_members/evolves_from_id/leader_of_id/is_leader_form/evolution_stage`。循环（含新首领与旧反向普通边的反环）撤回相关关系候选，发 `source_relationship_cycle`。调用方部分选择后仍需 canonical 完整校验，不能同时保留普通前置和首领来源。
- 空 `s` 使用 `warning:stage_source_incomplete`，明确官方没有可用阶段，不需要选择空值；保留旧阶段。满月已确认首领阶段的缺源提示为 `confirmed_leader_stage_source_incomplete/source_stage`，说明候选来自用户已确认方案而非 raw `s`，不禁该候选或退回未确认。
- 不导入体重、身高、背景简介、地点、昵称、蛋组、性别、异色或学习/进化等级。

## 图片和不可信文本

- `Images` 仅是显式可信源 URL 候选，分 `monster/wiki/move/trait/type` 用途。ExistingPath 沿用既有值，新图保持空路径，不伪造同名文件。
- URL 只允许同 HTTPS CDN 对应 PNG 命名空间及受限版本查询；拒绝跨域、userinfo、片段、穿越和编码绕过。
- 调用方须下载、解码、验证尺寸和质量；不能把全身图盲目替换头像，不能仅因 URL 新就覆盖更清晰本地图。
- 源文本拒绝 HTML/属性敏感字符、可解码 HTML 实体和控制字符；不擅自清洗成另一份定义。正常中文引号、描述换行保留。仍需 UI 按上下文转义。

## 验证

```text
go test ./internal/officialdex
```

默认全部使用合成内存数据，不依赖真实资料或外部备份。覆盖窄白名单各坐标拒绝、三新增、未知形态拒绝、空/坏学习面保护、官方顺序/三来源/有效重复、父优先继承、旧裸名/别名/变体父引用、特殊规则及 canonical 二次幂等。

[真实只读审计测试](<real_catalog_test.go>) 可显式启用：

```powershell
$env:OFFICIALDEX_AUDIT_CATALOG = '<当前canonical的绝对路径>'
$env:OFFICIALDEX_AUDIT_SOURCE = '<授权官方快照的绝对路径>'
go test ./internal/officialdex -v
```

审计执行 `Parse → ExportLegacy → BuildProposal → ImportLegacy → ExportLegacy → BuildProposal`，支持授权619/622输入，检查最终622、稳定旧 ID/图片/同名形态父引用保留、三个独立首领身份、仅冥古龙未映射、每个已映射有效学习面符合官方，以及第二轮业务 Changes=0。日志分别给出源权威清除的旧普通边、独立首领、4普通链修正及14确认候选的最终处置。输入前后按字节核对，**不写真实 data、备份目录或 AppData**，只在测试日志输出摘要。此测试不把任何旧备份当作当前资料或编译 fixture。外部备份及正式应用仍由调用方管理。
