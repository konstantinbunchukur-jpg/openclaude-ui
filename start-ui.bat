@echo off
rem ================================================
rem  OpenClaude UI — запуск двойным кликом
rem ================================================
setlocal
cd /d "%~dp0"
title OpenClaude UI

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [OpenClaude UI] Node.js не найден.
  echo  Установите его с https://nodejs.org/ ^(версия LTS или новее^)
  echo  и запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

set OPEN_BROWSER=1
node server.js

echo.
echo  Сервер остановлен.
pause
