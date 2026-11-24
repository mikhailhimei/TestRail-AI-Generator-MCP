#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fail() { printf '\n%s\n' "$1" >&2; exit 1; }

printf '[1/3] Проверка Node.js…\n'
command -v node >/dev/null 2>&1 || fail 'Установите Node.js 22.12 или новее с https://nodejs.org/ и повторите запуск.'
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' || fail 'Требуется Node.js 22.12 или новее. Обновите Node.js и повторите запуск.'

printf '[2/3] Проверка подтверждения подключения…\n'
case "$(uname -s)" in
  Darwin) command -v osascript >/dev/null 2>&1 || fail 'Не найден osascript для показа окна подключения macOS.' ;;
  Linux)
    [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || fail 'Запустите установку в графическом сеансе Linux: для подключения расширения нужно окно подтверждения.'
    command -v zenity >/dev/null 2>&1 || fail 'Установите пакет zenity через менеджер пакетов вашей системы и повторите запуск.'
    ;;
  *) fail 'Этот установщик предназначен для macOS и Linux.' ;;
esac

printf '[3/3] Установка Codex CLI и плагина TestRail AI Generator…\n'
node "$script_directory/install.mjs" "$@" || fail 'Не удалось установить плагин. Причина указана выше.'
printf '\nВ расширении нажмите «Подключить Codex» и подтвердите доступ.\nСервер уже работает в фоне и запускается при входе в систему.\nДля генерации из Chrome открывать проект, консоль или чат не требуется.\nДля команд из чата откройте новый чат с плагином TestRail AI Generator.\n'
