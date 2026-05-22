@echo off
chcp 65001 >nul
title kiro-rs Auto-Continue
cd /d "%~dp0"

echo.
echo ============================================================
echo   kiro-rs Auto-Continue  一键启动
echo ============================================================
echo.

rem 1. 检查 Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo        请先安装 Node.js 18+ : https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem 2. 检查 kiro-rs.exe
if not exist "kiro-rs.exe" (
  echo [错误] 当前目录找不到 kiro-rs.exe
  pause
  exit /b 1
)

rem 3. 检查 config.json
if not exist "config.json" (
  echo [提示] config.json 不存在，正在从 config.example.json 复制
  if exist "config.example.json" (
    copy /Y "config.example.json" "config.json" >nul
    echo        已生成 config.json，请打开它修改 apiKey 和 adminApiKey 后重新运行
    notepad config.json
    pause
    exit /b 0
  ) else (
    echo [错误] 找不到 config.example.json
    pause
    exit /b 1
  )
)

rem 4. 检查 credentials.json
if not exist "credentials.json" (
  echo [错误] 当前目录找不到 credentials.json
  echo        请参考 credentials.example.social.json / credentials.example.idc.json
  echo        填好你的 refreshToken 后保存为 credentials.json
  echo.
  pause
  exit /b 1
)

rem 5. 检查端口冲突
for %%P in (8991 8992 8993) do (
  netstat -ano | findstr ":%%P " | findstr "LISTENING" >nul && (
    echo [警告] 端口 %%P 已被占用，可能启动失败
    echo        请关闭占用该端口的程序后再启动
    echo.
    pause
  )
)

rem 6. 5 秒后自动打开管理面板
start /min cmd /c "timeout /t 5 /nobreak >nul && start http://127.0.0.1:8993"

echo 启动中... 5 秒后将自动打开管理面板
echo 关闭本窗口可同时停止所有服务
echo.

node tools\auto-continue\auto-continue.js
echo.
echo [服务已退出]
pause
