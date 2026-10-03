@echo off
rem Drop .ogg files onto this file to send them as voice messages via your bot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0send-voice.ps1" %*
