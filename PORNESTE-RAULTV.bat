@echo off
setlocal EnableExtensions
title RaulTV BEE DOOM
cd /d "%~dp0"

set "HERE=%CD%"
set "TARGET=%USERPROFILE%\RaulTV-BEE-DOOM"
set "LOG=%USERPROFILE%\RaulTV-BEE-DOOM\RaulTV-START.log"

echo.
echo ================================================
echo   RAULTV BEE DOOM
echo ================================================

rem Daca este pornit din WinRAR/Temp, copiem automat proiectul intr-un folder permanent.
echo %HERE% | findstr /I /C:"\AppData\Local\Temp\" >nul
if not errorlevel 1 goto :AUTOCOPY
if not exist "%HERE%\package.json" goto :AUTOCOPY
goto :RUNHERE

:AUTOCOPY
echo Detectat WinRAR/Temp sau lipseste package.json.
echo Instalez automat in:
echo %TARGET%
if not exist "%TARGET%" mkdir "%TARGET%" >nul 2>&1
if exist "%TARGET%\canale.m3u" copy /Y "%TARGET%\canale.m3u" "%TARGET%\canale.m3u.salvat" >nul
if exist "%TARGET%\rating.json" copy /Y "%TARGET%\rating.json" "%TARGET%\rating.json.salvat" >nul
xcopy "%~dp0*" "%TARGET%\" /E /I /Y /Q >nul
if not exist "%TARGET%\package.json" (
  echo.
  echo [EROARE] WinRAR a extras doar BAT-ul, nu si restul proiectului.
  echo Apasa butonul Extract To din WinRAR o singura data.
  echo Fereastra ramane deschisa.
  pause
  exit /b 1
)
cd /d "%TARGET%"
goto :START

:RUNHERE
set "TARGET=%HERE%"
set "LOG=%HERE%\RaulTV-START.log"

:START
echo ================================================== > "%LOG%"
echo RaulTV BEE DOOM - %date% %time% >> "%LOG%"
echo Folder: %CD% >> "%LOG%"
echo ================================================== >> "%LOG%"

where node >> "%LOG%" 2>&1
if errorlevel 1 (
 echo [EROARE] Node.js nu este instalat sau nu este in PATH.
 goto :FAIL
)

echo [1/3] Folder OK: %CD%
echo [2/3] Verific dependentele...
if not exist "node_modules\stremio-addon-sdk" (
 call npm install
 if errorlevel 1 goto :FAIL
)

echo [3/3] Verific codul...
call npm run check
if errorlevel 1 goto :FAIL

echo.
echo PORNESC RAULTV...
echo Adresele exacte apar mai jos, dupa pornire.
echo.
call npm start
echo.
echo Serverul s-a oprit.
goto :FAIL

:FAIL
echo.
echo ================================================
echo FEREASTRA RAMANE DESCHISA.
echo Folder curent: %CD%
echo Verifica eroarea de mai sus.
echo ================================================
pause
endlocal
