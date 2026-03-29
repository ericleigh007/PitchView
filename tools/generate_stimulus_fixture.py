from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.stimulus_notation import parse_stimulus_notation, write_stimulus_fixture


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a WAV stimulus fixture from ABC-inspired notation.")
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("name", type=str)
    parser.add_argument("--notation-file", type=Path)
    parser.add_argument("--notation", type=str)
    args = parser.parse_args()

    if not args.notation_file and not args.notation:
        raise SystemExit("Provide either --notation-file or --notation.")

    notation = args.notation_file.read_text(encoding="utf-8") if args.notation_file else args.notation or ""
    fixture = write_stimulus_fixture(args.output_dir, args.name, parse_stimulus_notation(notation))
    print(json.dumps(fixture, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())