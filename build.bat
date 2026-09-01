@echo off
rem ============================================
rem  小黑猫 Wiki - 一键打包脚本
rem  用法:
rem    build.bat            → 用默认版本 1.1.0 打包
rem    build.bat 1.2.0      → 用指定版本 1.2.0 打包
rem 产物(在 dist\ 目录):
rem    小黑猫Wiki-vXXX-Portable.zip  便携版
rem    小黑猫Wiki-Setup-vXXX.exe     安装包
rem ============================================
chcp 65001 >nul
setlocal

set VERSION=%~1
if "%VERSION%"=="" set VERSION=1.1.0
set APPNAME=小黑猫 Wiki
set DISTDIR=dist

echo 正在打包版本: %VERSION%
echo.

echo [1/4] 清理旧的编译产物...
if exist "%DISTDIR%" rmdir /s /q "%DISTDIR%"
mkdir "%DISTDIR%\app"

echo [2/4] 编译主程序...
go build -ldflags "-H=windowsgui" -o "%DISTDIR%\app\小黑猫 Wiki.exe" .
if errorlevel 1 (
    echo 编译失败！请检查 main.go 有无语法错误。
    pause
    exit /b 1
)

echo [3/4] 复制运行文件...
xcopy /e /i /y "data"    "%DISTDIR%\app\data"    >nul
xcopy /e /i /y "assets"  "%DISTDIR%\app\assets"  >nul
xcopy /e /i /y "css"     "%DISTDIR%\app\css"     >nul
xcopy /e /i /y "js"      "%DISTDIR%\app\js"      >nul
copy /y "index.html"     "%DISTDIR%\app\"        >nul

echo [4/4] 生成便携版压缩包...
powershell -Command "Compress-Archive -Path '%DISTDIR%\app\*' -DestinationPath '%DISTDIR%\小黑猫Wiki-v%VERSION%-Portable.zip' -Force"
echo     - %DISTDIR%\小黑猫Wiki-v%VERSION%-Portable.zip

rem ---- 安装包（需要安装 Inno Setup 6）----
set ISCC=
for %%i in ("C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "C:\Program Files\Inno Setup 6\ISCC.exe" "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe") do (
    if exist %%i set ISCC=%%~i
)
if defined ISCC (
    echo 生成安装包...
    "%ISCC%" /DMyAppVersion=%VERSION% "installer.iss"
    echo     - %DISTDIR%\小黑猫Wiki-Setup-v%VERSION%.exe
) else (
    echo [跳过安装包] 未找到 Inno Setup，请安装: https://jrsoftware.org/isdl.php
)

echo.
echo ============================================
echo  完成！产物在 dist\ 目录：
echo    - 小黑猫Wiki-v%VERSION%-Portable.zip  便携版
echo    - 小黑猫Wiki-Setup-v%VERSION%.exe     安装包
echo ============================================
pause
