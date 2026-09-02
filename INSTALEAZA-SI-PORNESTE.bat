@echo off
setlocal
title Instalare RaulTV BEE DOOM
set "SRC=%~dp0"
set "DST=%USERPROFILE%\RaulTV-BEE-DOOM"
echo Instalez RaulTV in "%DST%"...
if not exist "%DST%" mkdir "%DST%"

rem Salvam fisierele pe care le editeaza utilizatorul, ca sa nu le pierdem.
if exist "%DST%\canale.m3u" (
 copy /Y "%DST%\canale.m3u" "%DST%\canale.m3u.salvat" >nul
 echo   Am salvat canale.m3u ca -^> canale.m3u.salvat
)
if exist "%DST%\rating.json" (
 copy /Y "%DST%\rating.json" "%DST%\rating.json.salvat" >nul
 echo   Am salvat rating.json ca -^> rating.json.salvat
)

xcopy "%SRC%*" "%DST%\" /E /I /Y /Q >nul
if not exist "%DST%\package.json" (
 echo EROARE: package.json nu a putut fi copiat.
 pause
 exit /b 1
)
echo.
echo   Gata. Daca aveai servere proprii in canale.m3u, sunt in
echo   canale.m3u.salvat - copiaza-le inapoi dupa ce verifici ca merge.
echo.
cd /d "%DST%"
call "%DST%\PORNESTE-RAULTV.bat"
