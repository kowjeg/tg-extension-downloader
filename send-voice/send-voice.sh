#!/usr/bin/env bash
# Отправляет аудиофайлы как голосовые через Telegram-бота (Bot API sendVoice).
# Запуск: ./send-voice.sh файл.ogg [файл2.ogg ...]. Настройки — в config.txt рядом.
set -u

dir="$(cd "$(dirname "$0")" && pwd)"
config="$dir/config.txt"

if [ ! -f "$config" ]; then
  printf 'TOKEN=\nCHAT_ID=\n' > "$config"
  echo "Создан $config"
  echo "Впиши туда токен бота и chat_id, потом запусти ещё раз."
  exit 1
fi

# config.txt мог быть создан на Windows: убираем BOM, \r и пробелы по краям
TOKEN=""
CHAT_ID=""
while IFS='=' read -r key value || [ -n "$key" ]; do
  key="$(printf '%s' "$key" | tr -d '\r\357\273\277 \t')"
  value="$(printf '%s' "$value" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$key" in
    TOKEN) TOKEN="$value" ;;
    CHAT_ID) CHAT_ID="$value" ;;
  esac
done < "$config"

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "Заполни TOKEN и CHAT_ID в $config"
  exit 1
fi
if [ $# -eq 0 ]; then
  echo "Использование: $0 файл.ogg [файл2.ogg ...]"
  exit 1
fi

failed=0
for f in "$@"; do
  name="$(basename "$f")"
  if [ ! -f "$f" ]; then
    echo "ОШИБКА  $name : файл не найден"
    failed=$((failed + 1))
    continue
  fi

  # Имя файла для Telegram неважно — латиница, чтобы не было проблем с кодировкой
  resp="$(curl -sS -F "chat_id=$CHAT_ID" -F "voice=@\"$f\";type=audio/ogg;filename=voice.ogg" \
    "https://api.telegram.org/bot$TOKEN/sendVoice" 2>&1)"

  case "$resp" in
    *'"ok":true'*) echo "OK      $name" ;;
    *)
      desc="$(printf '%s' "$resp" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p')"
      echo "ОШИБКА  $name : ${desc:-$resp}"
      failed=$((failed + 1))
      ;;
  esac
done

echo
echo "Отправлено: $(($# - failed)) из $#"
[ "$failed" -eq 0 ]
