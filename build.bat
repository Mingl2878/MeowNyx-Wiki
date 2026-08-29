@echo off
rem ============================================
rem  小黑猫 Wiki - 打包脚本
rem  用法:
rem    build.bat           编译 + 生成便携版 ZIP + 安装包
rem    build.bat portable  只编译 + 生成便携版 ZIP
rem ============================================
chcp 65001 >nul
setlocal

set VERSION=1.0.0
set APPNAME=小黑猫 Wiki
set DISTDIR=dist

echo [1/4] 清理旧的编译产物...
if exist "%DISTDIR%" rmdir /s /q "%DISTDIR%"
mkdir "%DISTDIR%\app"

echo [2/4] 编译主程序...
go build -ldflags "-H=windowsgui" -o "%DISTDIR%\app\小黑猫 Wiki.exe" .
if errorlevel 1 (
    echo 编译失败！
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
where iscc >nul 2>nul
if %errorlevel%==0 (
    echo 生成安装包...
    iscc "installer.iss"
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
