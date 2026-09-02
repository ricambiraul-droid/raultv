@echo off
title RaulTV - pornit pentru TV si telefon
cd /d "%~dp0"
set HOST=0.0.0.0
echo.
echo  Pornesc RaulTV vizibil in reteaua locala.
echo  Daca Windows cere permisiune, apasa "Permite accesul".
echo.
node server.js
pause
