# 当前发布准备（1.3，2026-11-05）

## 状态

用户于 2026-11-05 明确选择 **“上传源码并生成技术候选包”**。候选仅用于技术验收，仍为1.3，不能称为已通过许可审核的正式公开发布版。当前剩余许可问题保留在 [发布阻断记录](<../legal/RELEASE-BLOCKERS.md>)；默认正式构建仍阻断，只有显式 Candidate 模式允许生成标注“许可待确认”的 ZIP/Setup。先由负责人完成 Git 提交/推送，再构建候选，不自动创建 GitHub Release、不改变版本、安装 AppId 或历史安装。

旧 dist 是现有编译输出，不能仅凭存在就称为此次发布版。本次未运行应用、抓包组件、驱动、游戏或安装器，也不会结束用户进程。

## 构建改动

- [build.bat](<../build.bat>) 委托 [scripts/release.ps1](<../scripts/release.ps1>)，只从 `version.txt` 读取版本。默认无 pause，自动任务不挂起；可用 `RELEASE_INTERACTIVE=1` 显式选择交互暂停。
- 在任何清理前，解析实际绝对 `dist` 路径、拒绝目录联接/符号链接等 reparse point，核验 Wiki 已正常关闭。
- 完整旧 `dist` 先复制到 `D:/echoagent/old/MeowNyx Wiki-backups/` 中已批准的独立目录，逐文件比对数量、字节与 SHA256；任何失败停止，不删除旧输出。禁止覆盖已有 dist 备份。
- 验证 `rkpp/distribution-files.json` 全量 SHA256/字节/精确文件集合；仅允许清单本身和 `launch.py` 额外存在。复制完整便携 Python、依赖、公开 RKPP 对应源码、公开协议结构 SQLite 和原 LICENSE/NOTICE，绝不从本机原 RKPP 仓库、venv、AppData、运行缓存补内容。
- 发布范围只包括主 EXE、`index.html`、五个公共 `data` JSON、`assets`、`css`、`js`、`rkpp` 与 `legal`。拒绝玩家数据库/设置/账号日志、Key、PCAP、原包、开发测试和旧四份迁移 JSON。当前批准的 S5 业务资料与图片原样复制，不擅自清策略或改资料；发现非空出厂策略则中止。
- `GOPROXY=off`、`GOSUMDB=off`、`GOTOOLCHAIN=local` 离线编译，只使用已安装依赖；缺工具/依赖即失败，不自动下载安装。
- ZIP 创建后比对全部条目数量、字节和解压数据 SHA256；安装器只用既有 Inno Setup 6 编译，不执行。复制、ZIP、Go、ISCC 或产物校验任一步失败均返回非零，不假报完成。

## 许可处理

[第三方声明](<../legal/THIRD-PARTY-NOTICES.md>) 和 [RKPP 适配变更声明](<../legal/RKPP-MODIFICATIONS.md>) 保留原作者“花吹雪又一年”及原许可，不代替许可正文。当前不能声称所有第三方许可已完整汇集；也不为 Wiki 主体、游戏素材或用户图片推定新的许可。

## 已获用户授权的技术候选模式

在项目根的命令环境中，设置项目外的会话证据目录及已批准的外部备份目录，然后运行入口（不是运行生成的 EXE）：

```bat
set "RELEASE_REPORT_DIR=<会话工作区绝对路径>\release-publish-work"
set "RELEASE_BACKUP_DIR=D:\echoagent\old\MeowNyx Wiki-backups\release-packaging-20261105-221330"
set "RELEASE_CANDIDATE=1"
build.bat
```

只读预检（不备份/删除/编译/启动）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 -CheckOnly -Candidate
```

原文汇集和其它输入约束仍会接受严格校验；失败是保护，不应规避。阻断文件存在时默认正式构建拒绝执行。显式候选模式保留阻断声明，在包根放置 TECHNICAL-CANDIDATE.txt，并在外部 manifest 标记 candidate=true、许可待确认；只有技术完整性通过，不认证合规公开发布。

最小隔离守卫测试（不运行整个应用测试集，不启动 EXE/RKPP）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-checks.test.ps1
```

当前该测试已通过：脚本 AST 解析、公开/私人文件拒绝规则、文件精确集合、真实 SHA256 与隔离临时目录安全清理。当前运行时实际是展开的 Python 3.12 标准库及 `python312.dll`，没有 `python312.zip`；脚本按已审核清单保留原布局，不创建或下载替代 zip。

本次技术候选文件名（不覆盖同名正式版；EXE内仍1.3）：

- `dist/小黑猫Wiki-v1.3-Portable-Candidate-20261105.zip`
- `dist/小黑猫Wiki-Setup-v1.3-Candidate-20261105.exe`

安装器只通过 ISCC 的 /F 输出名参数加候选后缀，不修改既有安装脚本或 AppId。

逐文件包清单、EXE/ZIP/Setup/data SHA256 与完整旧输出备份证据只记录到会话 `release-publish-work`，不混入源码或个人 AppData。当前尚无新的产物 SHA256；不要引用旧包散列作为本次发布结果。
