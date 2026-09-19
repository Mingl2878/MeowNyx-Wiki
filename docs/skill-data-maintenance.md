# 精灵技能数据维护

## 本次问题

旧数据使用 `权杖_Ⅱ`、`权杖_V`、`圣剑_X` 保存完整技能，主精灵表使用 `权杖-Ⅱ`、`权杖-V`、`圣剑-X`。后续立绘更新新增了同名的另一种拼写和空技能列表，技能更新又把“拖拉机”写入新条目。直接按显示名读取时，空条目或仅含新增技能的条目遮蔽了旧数据。

本次修复合并已有内容，不从网络抓取、不推测游戏技能。修复时基线：权杖两只各 51 条，圣剑-X 共 53 条（含“拖拉机”）。数量是本次检查结果，不是不可变的游戏规则。

## 存储约定

```json
{
  "圣剑-X": {
    "image": "assets/monster/images/wiki/圣剑_X.png",
    "skills": [],
    "monster_id": 434,
    "aliases": ["圣剑_X"]
  }
}
```

示意中的空数组仅展示字段结构，不能用它覆盖真实技能。

- `monster_id` 关联 `monsters.json` 的稳定 ID；JSON 外层键是当前显示名。
- `aliases` 保存历史拼写/改名前名称，便于导入兼容。
- 图片路径不随名称迁移而擅自重命名。
- 旧版冬季形态的基础名回退仍保留，不把其他季节或地区形态混为一只精灵。
- 已明确配置 `learnset_mode: own` 的精灵保持独立技能。只有 `inherit` 才使用指定 ID；编辑继承者的技能会建立当前精灵独立学习面，不修改上游精灵。

## Node 更新入口

```js
const path = require('path');
const { readWiki, writeWiki } = require('./lib/wiki-data');
const root = path.resolve(__dirname, '..');
const wiki = readWiki(root);
// 在 canonical 名称对应的条目上更新；保留 ID、aliases、已有技能与来源。
writeWiki(root, wiki);
```

`readWiki` 使用与浏览器一致的身份解析。`writeWiki` 再次规范化和校验，遇到别名冲突、未知技能、意外清空或部分旧技能丢失时停止，写入前备份。确实要删除/重命名技能或调整来源时，须将审核过的技能名显式传入 `allowRemovedSkills`；整只精灵清空须通过 `allowEmpty` 指定规范精灵名，不能全局跳过检查。新增精灵/技能的脚本应先确认主数据已包含对应 ID 和技能，再写入 Wiki。

备份位置固定约定在项目外：`D:/echoagent/old/MeowNyx Wiki-backups/`；自动数据备份位于该目录下的 `data-updates/`。即使针对 `dist/app` 执行修复，也不会在项目内创建备份目录。历史快照仅用于恢复，不能作为当前数据或编译输入。

不要在新脚本中绕过这个入口直接 `fs.writeFileSync` 覆盖 Wiki JSON。手工写文件或外部 AI 不经过这些入口时，运行时兼容只能修复可识别别名，不能恢复真正被删除的内容；必须保留备份。

## 本地检查

- `node --test tests/monster-identity.test.js tests/skill-editor-save.test.js scripts/tests/wiki-data.test.js`
- `node scripts/audit_skill_sources.js`
- `go test ./...`
- `node scripts/repair_monster_identity.js`：仅预览；加 `--write` 才迁移。

这些检查没有接入发布流水线，也不会生成安装包。

## 仅编译 EXE 检查版

在项目根目录执行：

```bat
go build -ldflags "-H=windowsgui" -o "dist/app/小黑猫 Wiki.exe" .
```

同步修改过的 `index.html`、`js` 和 `data` 文件到 `dist/app`，保留其他资源及用户设置。EXE 依赖旁边的资源目录，不是单文件程序。不要运行 `build.bat`：该脚本会清理 dist 并生成发布包。
