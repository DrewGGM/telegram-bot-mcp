@echo off
REM Supervisor loop for the telegram-bot-mcp daemon.
REM Used by the Startup-folder installation path (no admin rights required):
REM if the daemon exits for any reason, wait and restart it. This reproduces the
REM "restart on failure" behaviour a Scheduled Task would give us.
setlocal
cd /d "%~dp0.."
:loop
node "dist\main.js" >> "data\daemon.log" 2>&1
REM Exit code 0 means we shut down deliberately (SIGINT/SIGTERM) - stop looping.
if "%ERRORLEVEL%"=="0" goto :eof
timeout /t 10 /nobreak >nul
goto loop
