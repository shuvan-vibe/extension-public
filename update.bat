@echo off
echo ==============================================
echo      FoxiGrow Extension Updater
echo ==============================================
echo.
echo Downloading latest version from GitHub...

:: Download the zip
powershell -Command "Invoke-WebRequest -Uri 'https://github.com/shuvan-vibe/extension-public/archive/refs/heads/main.zip' -OutFile 'update.zip'"

:: Extract the zip
echo Extracting files...
powershell -Command "Expand-Archive -Path 'update.zip' -DestinationPath 'temp_update' -Force"

:: Move files from the extracted folder to the current directory
echo Updating files...
xcopy /s /y /q "temp_update\extension-public-main\*" "."

:: Clean up
echo Cleaning up...
rd /s /q "temp_update"
del update.zip

echo.
echo Update complete! 
echo Please go to chrome://extensions and click the 'Refresh' button on the FoxiGrow card.
echo.
pause
