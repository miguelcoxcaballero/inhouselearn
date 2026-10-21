#!/usr/bin/env python3
"""Open the built Inhouse Learn APK on an emulator and prove it really works.

Checks, in order: the APK installs; the launcher opens the hosted page (its own
text, not the offline page); the Google sign-in return link reaches the running
app without a crash; the shared updater's provider is registered with its own
class; the updater settings (UpdateActivity) render the bundled updater for
this app. Screenshots, UI dumps and logcat are kept for the workflow artifact.
"""
import re
import subprocess
import sys
import time
from pathlib import Path
from xml.etree import ElementTree

PACKAGE = 'com.inhouse.learn'
OUT = Path('android-evidence')


def adb(*args, check=True):
    return subprocess.run(['adb', *args], check=check, capture_output=True, text=True)


def screen(name):
    """Screenshot plus the visible text from uiautomator (WebView text included)."""
    adb('shell', 'screencap', '-p', f'/sdcard/{name}.png')
    adb('pull', f'/sdcard/{name}.png', str(OUT / f'{name}.png'))
    for _ in range(4):
        adb('shell', 'rm', '-f', '/sdcard/ui.xml', check=False)
        adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/ui.xml', check=False)
        if adb('pull', '/sdcard/ui.xml', str(OUT / f'{name}.xml'), check=False).returncode == 0:
            try:
                root = ElementTree.parse(OUT / f'{name}.xml').getroot()
            except ElementTree.ParseError:
                continue
            text = ' '.join(node.get('text', '') + ' ' + node.get('content-desc', '') for node in root.iter('node'))
            # Text inside a button with its own accessible name (the updater's
            # check status) is not in the UI dump: add OCR of the screenshot.
            ocr = subprocess.run(['tesseract', str(OUT / f'{name}.png'), '-'], capture_output=True, text=True)
            text += ' ' + ' '.join(ocr.stdout.split())
            (OUT / f'{name}.txt').write_text(text, encoding='utf-8')
            return text
        time.sleep(3)
    return ''


def wait_for(name, pattern, seconds=90):
    deadline = time.time() + seconds
    text = ''
    while time.time() < deadline:
        text = screen(name)
        if re.search(pattern, text, re.I):
            return text
        time.sleep(4)
    raise SystemExit(f'{name}: expected {pattern!r} on screen, saw: {text[:600]!r}')


def tap(dump, label):
    for node in ElementTree.parse(dump).getroot().iter('node'):
        if label in (node.get('text', ''), node.get('content-desc', '')):
            x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds', '')))
            adb('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))
            return
    raise SystemExit(f'{label!r} is not on screen')


def wait_for_network(seconds=90):
    # Right after boot the emulator can still be without internet: wait until
    # Android has a validated network before opening the app.
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = adb('shell', 'dumpsys', 'connectivity', check=False).stdout
        if re.search(r'NetworkAgentInfo.*VALIDATED', state) or 'everValidated{true}' in state or 'everValidated=true' in state:
            return True
        time.sleep(3)
    print('warning: no validated network after', seconds, 's; continuing')
    return False


def open_hosted_page():
    # The offline page has its own "Reintentar": use it while the network settles.
    for attempt in range(6):
        text = screen('1-launch')
        if re.search(r'inhouse learn', text, re.I) and 'Sin conexión' not in text and 'Sin conexion' not in text:
            return text
        if 'Reintentar' in text:
            print('offline page shown (attempt', attempt + 1, '); tapping Reintentar')
            tap(OUT / '1-launch.xml', 'Reintentar')
        time.sleep(8)
    return wait_for('1-launch', r'inhouse learn')


def alive():
    return adb('shell', 'pidof', PACKAGE, check=False).stdout.strip() != ''


def main(apk):
    OUT.mkdir(exist_ok=True)
    adb('logcat', '-c', check=False)
    adb('install', '-r', apk)
    wait_for_network()
    adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.MainActivity')
    # The hosted page, drawn by its own script: brand plus sign-in or chat.
    text = open_hosted_page()
    if 'Sin conexión' in text or 'Sin conexion' in text:
        raise SystemExit('The app showed its offline page instead of the hosted web app')

    # A stale sign-in return must be ignored by the page, never crash the app.
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
        # adb runs this through the device shell: quote the & of the query.
        '-d', "'inhouselearn://auth?state=ci-unknown&access_token=ci'", PACKAGE)
    time.sleep(5)
    if not alive():
        raise SystemExit('The app died on the sign-in return link')
    wait_for('2-after-auth-link', r'inhouse learn', 30)

    packages = adb('shell', 'dumpsys', 'package', PACKAGE).stdout
    (OUT / 'dumpsys-package.txt').write_text(packages, encoding='utf-8')
    # FROZEN installer rule: .update-provider has the updater's own class.
    if not re.search(r'com\.inhouse\.services\.updater\.UpdateFileProvider', packages) \
            or f'{PACKAGE}.update-provider' not in packages:
        raise SystemExit('The update provider is not registered with UpdateFileProvider')
    if 'android.permission.REQUEST_INSTALL_PACKAGES' not in packages:
        raise SystemExit('REQUEST_INSTALL_PACKAGES is missing')

    # The updater settings are not exported; the emulator's root shell opens them
    # the way the profile menu's "Actualizaciones" does.
    adb('root', check=False)
    time.sleep(3)
    adb('wait-for-device')
    adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/com.inhouse.services.updater.UpdateActivity',
        '--ez', 'settings', 'true')
    wait_for('3-updater-settings', r'Check for updates', 60)
    text = wait_for('3-updater-settings', r'Inhouse Learn', 30)
    if not re.search(r'Version B', text):
        raise SystemExit('The updater settings do not show the A/B channels')
    # A manual check reads this repository's channel catalog (B by default).
    tap(OUT / '3-updater-settings.xml', 'Check for updates')
    text = wait_for('4-updater-checked', r'No releases on version|up to date|newer than version|Update available|Could not check', 60)
    if 'Could not check' in text:
        raise SystemExit('The updater could not read updates/B.json from this repository')
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    time.sleep(2)

    log = adb('logcat', '-d').stdout
    (OUT / 'logcat.txt').write_text(log, encoding='utf-8')
    crashes = [line for line in log.splitlines() if 'FATAL EXCEPTION' in line or f'Process: {PACKAGE}' in line]
    if crashes:
        raise SystemExit('The app crashed: ' + ' | '.join(crashes[:5]))
    if not alive():
        raise SystemExit('The app is no longer running')
    print('Android smoke test passed')


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    finally:
        OUT.mkdir(exist_ok=True)
        log = adb('logcat', '-d', check=False).stdout
        (OUT / 'logcat.txt').write_text(log, encoding='utf-8')
