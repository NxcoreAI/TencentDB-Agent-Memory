@echo off
rem ══════════════════════════════════════════════════════════════
rem TencentDB-Agent-Memory 一键启动（源码版，无 Docker）
rem 弹出一个 Windows Terminal 窗口，5 个标签页各跑一个服务：
rem   Core :8420 / Knowledge :8421 / Panel :8123 / PanelWeb :5173 / Proxy :8096
rem 日志实时看，关掉某个标签页 = 停那个服务；关掉整个窗口 = 全停
rem 前置（一次性）：
rem   MemoryCore\tdai-gateway.yaml + MemoryCore\.env
rem   MemoryKnowledge\.env
rem   MemoryPanel\.env + MemoryPanel\config\metadata-instances.json
rem   MemoryProxy\config.yaml
rem ══════════════════════════════════════════════════════════════
setlocal
set ROOT=%~dp0

start "" wt.exe -w tencentdb-mem new-tab --title "Core :8420"      -d "%ROOT%MemoryCore"        cmd /k node --env-file=.env --import tsx src/gateway/server.ts
start "" wt.exe -w tencentdb-mem new-tab --title "Knowledge :8421" -d "%ROOT%MemoryKnowledge"   cmd /k pnpm dev
start "" wt.exe -w tencentdb-mem new-tab --title "Panel :8123"     -d "%ROOT%MemoryPanel"       cmd /k pnpm dev
start "" wt.exe -w tencentdb-mem new-tab --title "PanelWeb :5173"  -d "%ROOT%MemoryPanel\web"   cmd /k npm run dev
start "" wt.exe -w tencentdb-mem new-tab --title "Proxy :8096"     -d "%ROOT%MemoryProxy"       cmd /k npm run start:config

echo.
echo   已在 Windows Terminal 打开 5 个服务标签页（窗口名 tencentdb-mem）
echo   面板:  http://127.0.0.1:5173
echo   接入:  ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
echo.
echo   全部停止: 直接关掉那个终端窗口
endlocal
