@echo off
REM Double-click this ONCE to install GuildRosterLogger and keep it updated
REM automatically. No Node.js, no git, nothing else to install.
REM
REM What it does:
REM   1. Asks (once) where your WoW AddOns folder is.
REM   2. Downloads the addon there right now.
REM   3. Registers a Windows Task Scheduler task so it silently re-checks
REM      for updates every time you log into Windows - no visible window,
REM      nothing to remember to run.
REM
REM You may need to right-click this file and "Run as administrator" - if
REM you see "Access is denied" below, that's why.
REM
REM Run uninstall-addon-updater.bat to remove the scheduled task again.

setlocal
set TASK_NAME=GuildRosterAddonUpdater
cd /d "%~dp0"

echo.
echo Setting up GuildRosterLogger...
echo.

cscript //nologo update-addon.vbs
if errorlevel 1 goto :error

echo.
echo Registering scheduled task "%TASK_NAME%" (checks for updates at every logon)...
schtasks /create /tn "%TASK_NAME%" /tr "wscript.exe \"%~dp0update-addon.vbs\"" /sc onlogon /rl limited /f
if errorlevel 1 goto :error

echo.
echo ============================================================
echo  Installed. GuildRosterLogger is in your AddOns folder now,
echo  and will silently check for updates every time you log in.
echo.
echo  Enable it in-game: character select -^> AddOns -^> check
echo  GuildRosterLogger (if it's not already on).
echo.
echo  To remove it later: run uninstall-addon-updater.bat
echo ============================================================
echo.
pause
exit /b 0

:error
echo.
echo Something failed above - scroll up for the error.
pause
exit /b 1
