@echo off
cd /d "%~dp0"
title Neko Music - 调试模式

rem ============================================================
rem  调试启动：故意保留黑窗口，把运行日志显示出来。
rem  平时请双击 启动播放器.vbs（那个没有黑窗口）。
rem  软件出问题时，双击本文件，把这里的报错截图给我。
rem ============================================================

set "EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%EXE%" goto NODEP

rem 打开调试开关，让程序把网页里的日志也打出来
set NEKO_DEBUG=1

echo.
echo   ==========================================
echo      Neko Music 调试模式
echo   ==========================================
echo.
echo   下面会显示运行日志。软件窗口关掉后，本窗口会自动结束。
echo.

"%EXE%" "%~dp0."

echo.
echo   （程序已退出，上面的内容就是这次的运行日志）
echo.
pause
exit /b

:NODEP
echo.
echo   ==========================================
echo      运行依赖还没装好
echo   ==========================================
echo.
echo   1. 先安装 Node.js :  https://nodejs.org
echo   2. 在项目文件夹里打开终端，运行：
echo.
echo           npm install
echo.
echo   3. 然后再双击 启动播放器.vbs
echo.
pause
exit /b
