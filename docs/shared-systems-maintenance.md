# 公共界面系统维护约定

## 技能快捷选择

- 普通技能与过山车技能都只展示物攻、魔攻。
- 过山车先通过 `RKData.isAttackMove` 检查主技能类别，再通过 `getMoveCategoryZh` 获取中文类型。状态、防御、条件攻击、能量、未知或已删除的技能均不进入快捷攻击卡片。
- 不改变精灵技能数据、过山车来源规则、机幕方舟覆盖规则或伤害公式。

## 字体、主题和缩放

- 字体继续使用 `--app-font-family` 与 `applyAppFont`，图表仅适配画布字体。
- `--control-positive`、`--control-negative`、`--control-on-color`、`--chart-grid` 与全局文本/背景变量共同控制夜间显示。
- 不新增针对所有控件的 `!important` 夜间覆盖，否则会遮掉选中和警告状态。
- 主题变化发出 `appthemechange`，画布更新文字、网格、背景及提示框颜色，不修改曲线配置。
- 缩放统一通过 `window.AppPreferences.setMaxZoom(ratio)` 更新，比例范围为0.5～2。
- `getMaxZoom()` 返回最大化缩放记忆，`getZoom()` 返回当前实际比例；窗口化固定100%，重新最大化恢复记忆。
- `--page-zoom`、`__getPageZoom()` 保留为布局/定位适配入口；改变缩放发出 `appzoomchange`。

## 设置保存

- 设置页编辑缩放和默认页面时仅修改草稿。
- 后端明确成功后才提交 localStorage，并通过公共入口应用缩放。HTTP失败、业务失败、无效JSON均不得提前改变缓存。
- 字体仍可预览；失败或离开设置页时恢复已保存字体。
- 同一请求使用提交时的快照，防止等待网络时用户的新草稿混入缓存。

## 组件生命周期与弹层

- `CommonUI.createSearchBox` 返回幂等 `destroy()`。
- 路由替换页面前调用 `CommonUI.destroyWithin(container)`；MutationObserver 对局部重绘移除的组件提供清理兜底。
- 公共弹层使用 `positionAnchoredLayer` 和 `bindAnchoredLayer`，统一缩放坐标、边界限制、滚动关闭、窗口变化关闭、Escape、外部点击和卸载清理。
- 不再给每个新搜索框永久注册 window.scroll 监听。
- 曲线使用公共滚动容器，小窗口可滚动到全部控件，并保留自己的滚动位置和对比配置。

## 属性面板与样式

- 伤害页的攻守卡片声明 `data-stat-policy="free"`，保留自由模拟，不显示组队限制的灰色提示。
- 不修改组队页的性格/个体数量规则。
- 真正公共的搜索框、字体和滚动条只保留一套定义；攻守卡片的紧凑搜索宽度不得影响组队页。
- 计算器/数据编辑表单的布局样式限定在 `.calc-root`；不要再添加全局 reset 或第二组全局滚动条规则。
- 不再定义全局 `.card`、`.card:hover`、`.card.selected`；现有卡片只使用 `.calc-root .card` 的完整基础样式。左列两个 `.ext-module` 明确使用12px圆角。
- 攻守属性区保持紧凑的两列三行；标签和数值的宽度、对齐使用公共 `.final-stat-item` 定义，不再用计算器通用 `.stat-label` / `.stat-value` 强制40px宽度。仅保留原有计算器数值字号1.05em。
- 技能设置只保留 `.skill-card .input-row` / `.input-group` 一套完整布局：flex、15px间距、三项同行、不换行、最小宽度0。不保留通用 `.calc-root .input-row` / `.input-group` 布局，也不靠提高优先级覆盖错误规则。
- 数据编辑页仍需要换行和120px最小宽度，其布局仅写在 `updatedata.js` 的 `PAGE_STYLE` 中，并限定到 `#ud-tab-content`；不得重新放回共用样式。共用样式仅保留标签和输入框等外观。
- 删除无引用/弃用的布局规则，不把它们注释保存在活动样式文件里。回归测试既检查最终显示，也检查所有匹配规则，避免被覆盖的错误定义残留。
- 最终威力输入标签保留用户确认的现有共用标签外观（block、0.95em、次要文字色），手动状态保留红色警告；不要恢复已失效的flex/0.85em专用定义。输入框直接复用共用文本框样式。
- 合并同值重复规则，删除无模板引用的旧卡片网格/标题样式；不要把合理的组件差异当成重复而删除。相同声明之间若夹有其他命中规则，删除后置声明可能改变级联结果，必须对照最终计算样式。
- 单选组只定义一次 `gap: var(--radio-group-gap, 15px)`；伤害页 `.stats-title-row .stat-mode-group` 只设置 `--radio-group-gap: 10px`，与公共gap不是同一属性，不受二者先后顺序影响。删除旧的无效 `.stat-mode-group { gap: 10px }`，不再追加权重补丁。技能类型组和其他页面的模式组保持现有15px。
- 双属性标题栏必须验证模式切换、重置与两个属性标签同行、不重叠、不溢出。保留外层原有换行策略，不通过强制nowrap掩盖真正的小窗口容量限制。
- 收藏仍为左键攻方、右键守方、中键收藏，没有双击收藏。

## 回归验证

```text
node --test tests/*.test.js scripts/tests/*.test.js
node scripts/audit_skill_sources.js
go test ./...
```

独立临时浏览器内，使用只读本地服务：

```text
playwright-cli run-code --filename=tests/shared-systems.browser.js
playwright-cli run-code --filename=tests/damage-chart.browser.js
playwright-cli run-code --filename=tests/card-layout.browser.js
playwright-cli run-code --filename=tests/dual-type-header.browser.js
```

布局对照测试还需只读服务提供 `/__layout/original.css`（布局退化前的样式）和 `/__layout/before.css`（本次恢复前的样式）。引用仅用于比较CSS，不得把备份中的数据或旧应用代码作为当前运行/编译输入。测试覆盖同一数据、字体下的1920×1080与1280×900窗口，以及100%/80%缩放，分别对照原布局和用户确认要保留的标签/标题样式。

`dual-type-header.browser.js` 使用智辉章脑（光／水）作为攻守双方，覆盖系统字体和微软雅黑、80%/100%/125%/150%缩放、明暗主题、属性值/种族值模式及换行临界宽度。其 `/__layout/before.css` 需提供本次标题栏修复前的15px退化样式：测试必须先复现旧版换行，再验证同一窗口的新版本同行，不能只验证最终样式。

对照CSS通过文本注入 `<style>` 时要剥离开头BOM，模拟浏览器加载外链CSS的解码方式；否则首段`:root`可能不匹配，主题变量失效、边框消失，测出的几何尺寸不是真实页面。双属性测试另断言实际卡片1px边框和主题变量有效。

浏览器测试仅在独立配置中运行，会设置该临时浏览器的测试偏好，并拦截设置保存请求；不得使用用户日常浏览器配置。
