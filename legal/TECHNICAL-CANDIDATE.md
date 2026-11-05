# 技术候选包 — 许可待确认

本包为用户于 2026-11-05 明确选择生成的 **技术候选包**，软件版本仍为 1.3。它仅用于技术验收，**不是已通过许可审核的正式公开发布版**。

当前仍需核实 RKPP（AGPL-3.0-only）与同进程 Scapy（审计发现 GPL-2.0-only）的许可兼容性、RKPP 中两份 RocoMITMServer 移植模块上游许可/署名资料，以及主体与素材公开再分发权利边界。Chart.js/html2canvas 的现有完整 JS 原版权注释已原样保留并单独提取；本机未发现可核验的这两库完整独立 MIT LICENSE 文件，不据此假称许可审计完成。

已保留 RKPP 原作者“花吹雪又一年”、原 LICENSE/NOTICE、公开对应源码；补入已缓存 Go 模块/SDK/标准库原许可及从 Python LICENSE 提取的 Apache-2.0 原条款。详见包内 legal/RELEASE-BLOCKERS.md、legal/THIRD-PARTY-NOTICES.md 与 legal/license-sources.json。

ZIP/Setup 文件名含 Candidate-20261105，ZIP 文件哈希与逐文件完整性校验不等于法律合规结论。未自动上传 GitHub Release。测试/打包不运行应用、抓包组件、驱动、游戏或安装器；用户如自行启动，应自行确认环境及法律/服务条款要求。
