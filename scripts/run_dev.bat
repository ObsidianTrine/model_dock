@echo off
REM ModelDock dev gateway + auto-open Web console (Windows; see run_dev.sh for macOS/Linux)
REM Usage: scripts\run_dev.bat [port]   (default 8890, user dev port; 8687 is the production port - never use it for dev)
REM The gateway runs in its own window (tsx watch): edit anything under src\ and it auto-restarts.
REM SANDBOX: the dev instance is fully isolated in %USERPROFILE%\.modeldock-dev - config, logs and
REM          client-file writes stay there; production (8687 + real client files) is never touched.
REM          First run copies the production service config into the sandbox; afterwards they are independent.
REM Stop the gateway by closing that window or pressing Ctrl+C inside it.
setlocal
REM This script lives in scripts\; the repo root is its parent - all relative paths below
REM (scripts\dev-instance-probe.mjs, src\cli.ts, package.json) are anchored to the repo root.
cd /d "%~dp0.."

set "PORT=%~1"
if not defined PORT set "PORT=8890"

set "MODELRDOCK_DEV_SANDBOX=1"
if not defined MODELRDOCK_FAKE_HOME set "MODELRDOCK_FAKE_HOME=%USERPROFILE%\.modeldock-dev"
if not exist "%MODELRDOCK_FAKE_HOME%\.modeldock" mkdir "%MODELRDOCK_FAKE_HOME%\.modeldock"
REM First run: copy the production service config into the sandbox, minus client-attachment
REM registrations ([harness.*]) - those carry real client-file paths and would make the sandbox
REM think a client is attached/pinned (delete guard false-positives; see scripts\dev-seed.mjs). Idempotent.
if not exist "%MODELRDOCK_FAKE_HOME%\.modeldock\config.toml" if exist "%USERPROFILE%\.modeldock\config.toml" (
  node scripts\dev-seed.mjs
  echo [dev] Copied production config into the sandbox ^(client attachments stripped^); the two are independent.
)

REM Sandbox already has a live instance? One sandbox hosts ONE gateway instance - a second
REM "gateway start" would be silently refused by the single-instance guard (its hint goes to
REM the gateway window only) while the browser still opens on %PORT% and fails. Surface it here.
REM Probe output: one line "port pid started_at token" (see scripts\dev-instance-probe.mjs).
set "OLD_PORT="
for /f "usebackq tokens=1-4" %%A in (`node scripts\dev-instance-probe.mjs "%MODELRDOCK_FAKE_HOME%\.modeldock\gateway.json" 2^>nul`) do (
  set "OLD_PORT=%%A"
  set "OLD_PID=%%B"
  set "OLD_STARTED=%%C"
  set "OLD_TOKEN=%%D"
)
if defined OLD_PORT (
  if "%OLD_PORT%"=="%PORT%" (
    echo [dev] Sandbox already has a dev instance on port %PORT% - reuse it, no restart needed:
    echo [dev]   http://127.0.0.1:%PORT%/_modeldock/ui?token=%OLD_TOKEN%
    start "" "http://127.0.0.1:%PORT%/_modeldock/ui?token=%OLD_TOKEN%"
    pause
    exit /b 0
  )
  echo [dev] Sandbox %MODELRDOCK_FAKE_HOME% already has another ModelDock instance on port %OLD_PORT%, pid %OLD_PID%, started %OLD_STARTED%.
  echo [dev] Starting another one in the same sandbox would be silently refused; the browser would open on %PORT% and fail.
  echo [dev] Existing instance console: http://127.0.0.1:%OLD_PORT%/_modeldock/ui?token=%OLD_TOKEN%
  echo [dev] Pick one:
  echo [dev]   1. Reuse the existing instance via the URL above
  echo [dev]   2. Stop it first, then rerun:  MODELRDOCK_FAKE_HOME=%MODELRDOCK_FAKE_HOME% npx tsx src/cli.ts gateway stop
  echo [dev]   3. Use a separate sandbox: set MODELRDOCK_FAKE_HOME=%USERPROFILE%\modeldock-test , then rerun: scripts\run_dev.bat %PORT%
  pause
  exit /b 1
)

REM Refuse to start when the port already serves a gateway (incl. production on 8687)
curl -sf "http://127.0.0.1:%PORT%/_modeldock/health" >nul 2>&1
if not errorlevel 1 (
  echo [dev] Port %PORT% already has a running gateway - dev gateway must not share it.
  echo [dev] Pick another port, e.g.: scripts\run_dev.bat 18990
  pause
  exit /b 1
)

echo.
echo [dev] Starting dev gateway on port %PORT% (tsx watch, auto-reload on src changes; sandbox: %MODELRDOCK_FAKE_HOME%) ...
start "ModelDock dev gateway (port %PORT%)" cmd /k npx tsx watch src/cli.ts gateway start --port %PORT%

REM Poll the health endpoint, then open the console
set /a TRIES=0
:waitloop
curl -sf "http://127.0.0.1:%PORT%/_modeldock/health" >nul 2>&1
if not errorlevel 1 goto ready
ping -n 2 127.0.0.1 >nul
set /a TRIES+=1
if %TRIES% lss 40 goto waitloop
echo [dev] Gateway did not become ready in 40s - check the gateway window for errors.
pause
exit /b 1

:ready
echo [dev] Opening console: http://127.0.0.1:%PORT%/_modeldock/ui (with admin token)
REM Management plane requires the admin token; read it from the SANDBOX gateway state file
set "TOKEN="
for /f "usebackq delims=" %%T in (`node -p "JSON.parse(require('fs').readFileSync(require('path').join(process.env.MODELRDOCK_FAKE_HOME,'.modeldock','gateway.json'),'utf8')).admin_token"`) do set "TOKEN=%%T"
if defined TOKEN (start "" "http://127.0.0.1:%PORT%/_modeldock/ui?token=%TOKEN%") else start "" "http://127.0.0.1:%PORT%/_modeldock/ui"
echo [dev] Tip: refresh the browser after code changes; close the gateway window to stop.
pause
