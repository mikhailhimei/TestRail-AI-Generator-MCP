"""Build the CLI plugin archives from the checked-out source."""
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

source = Path(__file__).resolve().parents[1]
plugin = source / "testrail-chat"
destination = Path(sys.argv[1]).resolve()
destination.mkdir(parents=True, exist_ok=True)

guides = {
    "gemini": """# TestRail для Gemini CLI

Windows, macOS и Linux. Запустите установщик своей ОС.
Для установки CLI нужен Node.js 22.12+; при скачивании также нужны npm и curl.
Авторизуйтесь в Gemini CLI и подключите MCP:

    gemini mcp add --scope user testrail-extension node "/полный/путь/testrail-chat/server.mjs"

Откройте Gemini в доверенной папке, выберите Gemini MCP в расширении Chrome и подтвердите подключение.
""",
    "copilot": """# TestRail для GitHub Copilot

Windows, macOS и Linux. Для запуска генерации и АТ из Chrome запустите установщик своей ОС.
Для установки CLI нужен Node.js 22.12+; при скачивании также нужны npm и curl.
Выполните вход в Copilot CLI.

Для работы из чата VS Code добавьте сервер в объект mcpServers в
~/.copilot/mcp-config.json или .mcp.json проекта:

    "testrail-extension": { "type": "stdio", "command": "node", "args": ["/полный/путь/testrail-chat/server.mjs"] }

Запустите сервер из чата и выберите Copilot MCP в расширении Chrome.
""",
}


def add_file(archive, name, data):
    entry = ZipInfo("testrail-chat/" + name)
    executable = name.endswith((".sh", ".command"))
    entry.external_attr = (0o100755 if executable else 0o100644) << 16
    if name.endswith(".cmd"):
        data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    elif executable:
        data = data.replace(b"\r\n", b"\n")
    archive.writestr(entry, data, compress_type=ZIP_DEFLATED)


common = ["server.mjs", "bridge-client.mjs", "install-cli.mjs", "JSON-MOCKS.md"]
common += [file.relative_to(plugin).as_posix() for file in sorted((plugin / "runtime").glob("*.mjs"))]
for agent in ("codex", "gemini", "copilot", "setup"):
    archive_name = "testrail-chat-setup.zip" if agent == "setup" else f"testrail-chat-plugin-{agent}.zip"
    archive_path = destination / archive_name
    with ZipFile(archive_path, "w") as archive:
        for name in common:
            add_file(archive, name, (plugin / name).read_bytes())
        if agent in ("codex", "setup"):
            for file in sorted(plugin.iterdir()):
                if file.is_file() and file.name not in common:
                    if agent == "setup" and file.name in {"Install Windows.cmd", "Install Linux.sh", "Install macOS.command"}:
                        continue
                    add_file(archive, file.name, file.read_bytes())
        if agent == "setup":
            menu = source / "installers" / "menu"
            for name in ("setup.mjs", "Install Windows.cmd", "Install Linux.sh"):
                add_file(archive, name, (menu / name).read_bytes())
            add_file(archive, "Install macOS.command", (menu / "Install Linux.sh").read_bytes())
        elif agent != "codex":
            launchers = source / "installers"
            add_file(archive, "Install Windows.cmd", (launchers / "Install Windows.cmd").read_bytes())
            unix = (launchers / "Install Linux.sh").read_bytes()
            add_file(archive, "Install Linux.sh", unix)
            add_file(archive, "Install macOS.command", unix)
            add_file(archive, "README.md", guides[agent].encode())
            add_file(archive, "provider.txt", (agent + "\n").encode())
    with ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise ValueError(f"Invalid ZIP: {archive_path}")
    print(f"{archive_path.name}: {archive_path.stat().st_size:,} bytes")

if len(sys.argv) > 2:
    extension = Path(sys.argv[2]).resolve()
    if not (extension / "manifest.json").is_file():
        raise ValueError("Extension build must contain manifest.json")
    extension_archive = destination / "testrail-chrome-extension.zip"
    with ZipFile(extension_archive, "w", ZIP_DEFLATED) as archive:
        for file in sorted(extension.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(extension).as_posix())
    with ZipFile(extension_archive) as archive:
        if archive.testzip() is not None:
            raise ValueError("Invalid extension ZIP")
    print(f"{extension_archive.name}: {extension_archive.stat().st_size:,} bytes")
