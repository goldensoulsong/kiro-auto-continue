@echo off
chcp 65001 >nul
setlocal EnableExtensions
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
  echo [提示] config.json 不存在，正在自动生成...
  if not exist "config.example.json" (
    echo [错误] 找不到 config.example.json
    pause
    exit /b 1
  )
  copy /Y "config.example.json" "config.json" >nul
  rem 用 Node 生成两个随机 key 替换占位符（一行 inline，避免 cmd 转义噩梦）
  node -e "var fs=require('fs'),c=require('crypto'),p='config.json';var t=fs.readFileSync(p,'utf-8');t=t.replace(/sk-kiro-rs-CHANGE-ME-RANDOM-STRING/,'sk-kiro-rs-'+c.randomBytes(24).toString('hex')).replace(/sk-admin-CHANGE-ME-RANDOM-STRING/,'sk-admin-'+c.randomBytes(24).toString('hex'));fs.writeFileSync(p,t);"
  if errorlevel 1 (
    echo [错误] 自动生成 key 失败，请手动编辑 config.json
    notepad config.json
    pause
    exit /b 1
  )
  echo        已生成 config.json 并自动填入随机 apiKey / adminApiKey
  echo.
)

rem 4. 检查 credentials.json，没有就生成空数组让 kiro-rs 能起来
rem    用户启动后通过管理面板的"快捷导入"添加凭据
if not exist "credentials.json" (
  echo [提示] credentials.json 不存在，正在生成空文件
  echo        启动后请打开管理面板（http://127.0.0.1:8993）使用"快捷导入"添加凭据
  echo [] > "credentials.json"
  echo.
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
echo ------------------------------------------------------------
echo 客户端（酒馆/Cline等）接入信息：
echo   API URL: http://127.0.0.1:8992
for /f "delims=" %%K in ('node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf-8')).apiKey)"') do echo   API Key: %%K
echo ------------------------------------------------------------
echo.

node tools\auto-continue\auto-continue.js
echo.
echo [服务已退出]
pause
