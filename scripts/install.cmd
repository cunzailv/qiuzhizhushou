@echo off
REM 智能求职助手 · 外部 AI 接入一条龙（Windows）
REM 用法：scripts\install.cmd  [--port 18790] [--force] [--skip-build]

setlocal EnableDelayedExpansion
set "REPO=https://github.com/cunzailv/qiuzhizhushou.git"
set "ARGS="

:parse
if "%~1"=="" goto :run
if /I "%~1"=="--repo" (
  set "REPO=%~2"
  shift & shift
  goto :parse
)
set "ARGS=!ARGS! %~1"
shift
goto :parse

:run
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 Node.js，请先安装 Node.js 18+ : https://nodejs.org
  exit /b 1
)

set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%..\bridge\bin\cli.mjs" (
  pushd "%SCRIPT_DIR%.."
) else (
  set "PROJECT_DIR=%USERPROFILE%\qiuzhizhushou"
  if not exist "!PROJECT_DIR!\bridge\bin\cli.mjs" (
    echo - 下载项目到 !PROJECT_DIR! ...
    git clone --depth 1 %REPO% "!PROJECT_DIR!" || ( echo [X] 下载失败，可用 --repo 指定镜像 & exit /b 1 )
  )
  pushd "!PROJECT_DIR!"
)

echo.
node bridge\bin\cli.mjs setup !ARGS!
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
