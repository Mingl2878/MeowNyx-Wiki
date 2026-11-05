"""Local RKPP launcher. Parsing remains in the separately licensed RKPP source.
Capture is entered only when the Wiki explicitly starts this program.
Never copies personal keys, captures or interface settings into the distribution.
"""
from __future__ import annotations
import argparse
from datetime import datetime
import os
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-root', required=True, type=Path)
    parser.add_argument('--relay-port', type=int, default=18765)
    args = parser.parse_args()
    if not args.data_root.is_absolute() or args.relay_port != 18765:
        raise SystemExit('RKPP requires an absolute personal data directory and fixed local port.')
    if os.name == 'nt':
        driver = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'System32/drivers/npcap.sys'
        if not driver.is_file():
            raise SystemExit('Npcap驱动未安装。请用户自行安装；软件不会自动安装或提权。')
    source = ROOT / 'source'
    if not (source / 'rkpp_live_tools.py').is_file():
        raise SystemExit('RKPP随包源码缺失。')
    args.data_root.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(source))
    import rkpp_network
    import rkpp_io
    rkpp_network.DEFAULT_KEY_DIR = args.data_root / 'Key'
    rkpp_network.SETTINGS_PATH = args.data_root / 'rkpp_settings.json'
    rkpp_io.SCRIPT_DIR = args.data_root
    # Preserve numeric event counters; branding only clarifies service identity.
    from rkpp_relay import OpcodeRelayServer
    original_stats = OpcodeRelayServer.stats
    def local_stats(self):
        result = original_stats(self)
        result.update(ok=True, service='rkpp', relay_port=self.port, stream_path='/events')
        return result
    OpcodeRelayServer.stats = local_stats
    output = args.data_root / 'runs' / (datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()))
    os.chdir(args.data_root)
    sys.argv = [str(source / 'rkpp_live_tools.py'), 'opencode-server', '--port', '8195',
                '--relay-host', '127.0.0.1', '--relay-port', str(args.relay_port),
                '--server-mode', 'normal', '--out-dir', str(output)]
    # RKPP retains its saved local interface selection, otherwise Scapy default.
    # No installed-machine interface id, handshake key or capture is bundled.
    try:
        runpy.run_path(str(source / 'rkpp_live_tools.py'), run_name='__main__')
    except SystemExit as error:
        return error.code if isinstance(error.code, int) else int(bool(error.code))
    except KeyboardInterrupt:
        return 0
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
