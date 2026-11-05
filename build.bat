@echo off
rem 小黑猫 Wiki - 经清单、备份及许可检查的一键打包入口
rem 版本只读取 version.txt；产物文件名与安装 AppId 保持不变。
rem 设置 RELEASE_REPORT_DIR 为项目外的会话 release-publish-work 目录。
rem 设置 RELEASE_BACKUP_DIR 可指定已批准的项目外完整 dist 备份目录。
rem RELEASE_CANDIDATE=1 仅显式生成许可待确认的技术候选，不解除正式发布阻断。
rem 仅当需要交互暂停时设置 RELEASE_INTERACTIVE=1。
chcp 65001 >nul
setlocal
if not "%~1"=="" (
    echo 请修改 version.txt 设置统一版本，不接受版本参数。
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
    echo 打包失败，未认证为可发布版本。请检查上方明确错误。
) else (
    echo 技术打包及完整性校验完成，产物位于 dist，证据位于 RELEASE_REPORT_DIR。
    if "%RELEASE_CANDIDATE%"=="1" echo 仅技术候选包：许可待确认，不代表可合规公开发布。
)
if "%RELEASE_INTERACTIVE%"=="1" pause
exit /b %RESULT%
