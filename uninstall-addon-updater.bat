@echo off
REM Removes the scheduled task installed by install-addon-updater.bat, so
REM GuildRosterLogger stops auto-updating. The addon itself is left in
REM place - this only stops the background update checks.

set TASK_NAME=GuildRosterAddonUpdater

echo Removing scheduled task "%TASK_NAME%"...
schtasks /delete /tn "%TASK_NAME%" /f
if errorlevel 1 (
    echo   (No task named "%TASK_NAME%" was found - nothing to remove there.)
)

echo.
echo Done. GuildRosterLogger will stay as-is but won't auto-update anymore.
pause
