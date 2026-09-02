@echo off
title RaulTV - scanare calitate reala
cd /d "%~dp0"
echo.
echo  Verific rezolutia REALA a fiecarui flux.
echo  Dureaza cateva minute. Nu inchide fereastra.
echo.
node scaneaza-calitate.js
echo.
pause
