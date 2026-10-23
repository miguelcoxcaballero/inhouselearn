#!/usr/bin/env python3
"""Aviso de APK publicada (Inhouse Learn).

Lee el canal A (updates/A.json: lo que el updater de los móviles ofrece de
verdad) y, si hay una versión nueva sin avisar, abre el issue
«APK <versión> publicada». GitHub manda los issues nuevos por correo, así que
el aviso llega sin que nadie esté mirando.

Solo lee: no publica, no toca A/B y no firma nada. La publicación sigue siendo
el run manual de android.yml con publish=true (UPDATER.md).

Uso: GH_TOKEN=... GH_REPO=owner/name python3 .github/scripts/apk_published.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

CATALOG = Path('updates/A.json')
REPO = os.environ.get('GH_REPO') or os.environ.get('GITHUB_REPOSITORY') or ''
MIN_CODE = int(os.environ.get('MIN_VERSION_CODE') or '0')


def gh(*args):
    """Runs gh once; never raises (a missing gh is a clear message, not a traceback)."""
    return subprocess.run(['gh', *args], check=False, capture_output=True, text=True)


def already_announced(title):
    listed = gh('issue', 'list', '--state', 'all', '--search', 'in:title "' + title + '"',
                '--json', 'title', '--jq', '.[].title')
    if listed.returncode != 0:
        print('No se pudo consultar los issues: ' + (listed.stderr or '').strip())
        return False
    return title in [line.strip() for line in listed.stdout.splitlines()]


def main():
    if not REPO:
        print('Falta GH_REPO/GITHUB_REPOSITORY: no hay repositorio donde avisar.')
        return 1
    latest = json.loads(CATALOG.read_text()).get('latest') or {}
    version = str(latest.get('version') or '')
    code = int(latest.get('versionCode') or 0)
    if not version or code < MIN_CODE:
        print('Canal A sin versiones nuevas (ultima: ' + (version or 'ninguna') +
              ', minimo avisado: ' + str(MIN_CODE) + '). Nada que avisar.')
        return 0

    title = 'APK ' + version + ' publicada'
    if already_announced(title):
        print('Ya avisado antes: ' + title)
        return 0

    body = '\n'.join([
        'El updater de los moviles ya ofrece **inhouse learn ' + version + '** (versionCode ' +
        str(code) + ') en el canal A.',
        '',
        '| Dato | Valor |',
        '| --- | --- |',
        '| Version | ' + version + ' (' + str(code) + ') |',
        '| Publicada | ' + str(latest.get('releasedAt') or '-') + ' |',
        '| APK | ' + str(latest.get('apkUrl') or '-') + ' |',
        '| SHA-256 | `' + str(latest.get('apkSha256') or '-') + '` |',
        '| Tamano | ' + str(latest.get('apkSizeBytes') or '-') + ' bytes |',
        '| Changelog | ' + str(latest.get('changelog') or '-') + ' |',
        '',
        'Sale en los ajustes de actualizaciones de la app (o en el aviso que ella misma ' +
        'ensena). Si no la quieres, cierra este issue: no volvere a avisar de esta version.',
    ])
    created = gh('issue', 'create', '--title', title, '--body', body)
    if created.returncode != 0:
        print('No se pudo abrir el issue: ' + (created.stderr or '').strip())
        return 1
    print(created.stdout.strip())
    print('Aviso abierto: ' + title)
    return 0


if __name__ == '__main__':
    sys.exit(main())
