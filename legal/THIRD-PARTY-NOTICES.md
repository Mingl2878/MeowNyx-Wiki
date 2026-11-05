# 第三方组件、署名与许可位置

本文件只说明第三方组件来源与现有许可位置，不为小黑猫 Wiki 主体、用户提供图片或游戏资料授予新的许可，也不代表全部发布条件已经满足。**当前存在发布阻断，详见 RELEASE-BLOCKERS.md；不要将本工作区或旧 dist 产物称为已通过许可审核的发布版。**

## RKPP

- 原项目：洛克王国协议解析器 / Rock Kingdom Protocol Parser-Ver2.2(Notgedrungen)。
- 原作者：花吹雪又一年。Copyright (c) 2026 花吹雪又一年。
- 原许可：GNU Affero General Public License v3.0 only（AGPL-3.0-only）。
- 包内原文：`rkpp/source/LICENSE`、`rkpp/source/NOTICE`，均保留不修改。
- 对应源代码、公开协议结构数据库：`rkpp/source/`。`rkpp/source/rkpp_data.sqlite` 是公开协议结构数据，不是玩家战报库。
- Wiki 启动适配代码：`rkpp/launch.py`；变更声明：`legal/RKPP-MODIFICATIONS.md`。
- 不分发本机密钥、网卡标识、采集日志、PCAP、个人配置、账号归档或玩家战报数据库，不分发或自动安装 Npcap 驱动。

## 便携 Python 与 Python 依赖

下列现有原许可文件随整个经 SHA256 核验的 RKPP 清单原样分发，不用简短概述替代许可正文。

| 组件 | 当前随包版本 | 原许可位置 |
| --- | --- | --- |
| Python 3.12 便携运行时 | 3.12 系列；以实际运行时文件为准 | `rkpp/python/LICENSE.txt`（含 Python 及捆绑组件许可） |
| Scapy | 2.8.0 | `rkpp/python/Lib/site-packages/scapy-2.8.0.dist-info/licenses/LICENSE` |
| PyCryptodome | 3.24.1 | `rkpp/python/Lib/site-packages/pycryptodome-3.24.1.dist-info/LICENSE.rst` |
| protobuf | 6.33.6 | `rkpp/python/Lib/site-packages/protobuf-6.33.6.dist-info/LICENSE` |
| msgpack | 1.2.4 | `rkpp/python/Lib/site-packages/msgpack-1.2.4.dist-info/licenses/COPYING` |

Scapy 与 RKPP 的许可兼容性尚待解决。msgpack 的 COPYING 只含 Apache-2.0 声明和网址；已从现有 Python LICENSE 原样提取第1–9条 Apache-2.0 条款至 `legal/Apache-2.0.txt`（原文无 Appendix，不编造附录），原 Python LICENSE 仍完整随包。

## 前端库

- Chart.js 4.4.0：Copyright (c) 2023 Chart.js Contributors；现有 `js/chart.umd.min.js` 头部声明 MIT。
- html2canvas 1.4.1：Copyright (c) 2022 Niklas von Hertzen；现有 `js/html2canvas.min.js` 头部声明 MIT，并含 Microsoft 辅助代码的原许可声明。
- Chart.js 还包含 @kurkle/color 0.3.2 的原声明：Copyright (c) 2023 Jukka Kurkela、MIT。
- 上述完整 JS 与原注释均不修改，版权注释另原样提取到 `legal/licenses/frontend/`。本机未找到可核验的这两库完整独立 MIT LICENSE 文件；此缺口保留，不用其它组件作者的 MIT 许可冒充，也不据简短头部伪称审计完成。

## Go 依赖

以仓库 `go.mod` 锁定的12个模块版本为准，包含 go-webview2、go-winloader、modernc.org/sqlite 及其间接依赖。已经从本机既有对应模块缓存原样复制24份 LICENSE / 附属声明 / AUTHORS（包括 go-webview2 WebView2 SDK、modernc sqlite/libc/memory/mathutil 附属声明），并复制已安装 Go 运行时/标准库 LICENSE。原文位于 `legal/licenses/go/`、`legal/licenses/go-runtime/`，逐项组件版本、原相对位置、字节和 SHA256 位于 `legal/license-sources.json`。未下载安装工具，不以通用 MIT 文本替代原作者声明。

以上原文汇集不解除 RKPP 组合及其它剩余许可/素材疑问；本次用户只授权技术候选。

## 软件主体、游戏资料及图片

当前未发现可以据以为整个 Wiki 主体授予统一开源许可的根许可文件；本次不新增 MIT 或其它推定许可。用户提供图片与游戏相关图像/文字不因被用于本工具而变成项目所有；相关权利归各自权利人，公开再分发范围须由项目负责人核实。本说明不是权利授权或法律意见。
