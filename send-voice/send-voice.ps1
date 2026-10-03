# Отправляет аудиофайлы как голосовые через Telegram-бота (Bot API sendVoice).
# Запуск: перетащить .ogg файлы на send-voice.bat. Настройки — в config.txt рядом.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$configPath = Join-Path $PSScriptRoot 'config.txt'

function Finish($code) {
  Write-Host ''
  Read-Host 'Нажми Enter, чтобы закрыть' | Out-Null
  exit $code
}

if (-not (Test-Path -LiteralPath $configPath)) {
  Set-Content -LiteralPath $configPath -Encoding UTF8 -Value @('TOKEN=', 'CHAT_ID=')
  Write-Host "Создан $configPath"
  Write-Host 'Впиши туда токен бота и chat_id, потом перетащи файлы ещё раз.'
  Finish 1
}

$cfg = @{}
Get-Content -LiteralPath $configPath -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*(\w+)\s*=\s*(.*?)\s*$') { $cfg[$matches[1]] = $matches[2] }
}
if (-not $cfg.TOKEN -or -not $cfg.CHAT_ID) {
  Write-Host "Заполни TOKEN и CHAT_ID в $configPath"
  Finish 1
}
if (-not $Files) {
  Write-Host 'Перетащи .ogg файлы на send-voice.bat'
  Finish 1
}

Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
$url = "https://api.telegram.org/bot$($cfg.TOKEN)/sendVoice"
$failed = 0

foreach ($path in $Files) {
  $name = [IO.Path]::GetFileName($path)
  try {
    $file = [System.Net.Http.ByteArrayContent]::new([IO.File]::ReadAllBytes($path))
    $file.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('audio/ogg')
    $form = [System.Net.Http.MultipartFormDataContent]::new()
    $form.Add([System.Net.Http.StringContent]::new($cfg.CHAT_ID), 'chat_id')
    # Имя файла для Telegram неважно — латиница, чтобы не было проблем с кодировкой
    $form.Add($file, 'voice', 'voice.ogg')

    $resp = $client.PostAsync($url, $form).Result
    $body = $resp.Content.ReadAsStringAsync().Result
    if ($resp.IsSuccessStatusCode) {
      Write-Host "OK      $name"
    } else {
      $desc = try { ($body | ConvertFrom-Json).description } catch { $body }
      Write-Host "ОШИБКА  $name : $($resp.StatusCode) $desc"
      $failed++
    }
  } catch {
    Write-Host "ОШИБКА  $name : $($_.Exception.GetBaseException().Message)"
    $failed++
  }
}

Write-Host ''
Write-Host "Отправлено: $($Files.Count - $failed) из $($Files.Count)"
Finish ([int]($failed -gt 0))
