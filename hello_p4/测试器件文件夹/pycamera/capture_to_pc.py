import os
import sys
import time
from pathlib import Path

import requests

try:
    import serial
except Exception:
    serial = None


# Change these before running if needed.
CAPTURE_URL = "http://192.168.4.1/capture"
SAVE_COUNT = 50
SAVE_INTERVAL_SECONDS = 2.0
SERIAL_PORT = "COM9"
SERIAL_BAUD = 115200
SERIAL_ENABLED = False
REQUEST_TIMEOUT_SECONDS = 8


SCRIPT_DIR = Path(__file__).resolve().parent
SAVE_DIR = SCRIPT_DIR / "captured_images"
SAVE_DIR.mkdir(exist_ok=True)


def open_serial():
    if not SERIAL_ENABLED:
        return None
    if serial is None:
        print("pyserial not installed, serial progress disabled.")
        return None
    try:
        ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=1)
        time.sleep(1.0)
        return ser
    except Exception as exc:
        print(f"Open serial failed: {exc}")
        return None


def send_progress(ser, current, total, status):
    if ser is None:
        return
    line = f"SAVE,{current},{total},{status}\n"
    ser.write(line.encode("ascii", errors="ignore"))


def save_one_image(index):
    response = requests.get(CAPTURE_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()

    content_type = response.headers.get("Content-Type", "")
    if "jpeg" not in content_type.lower() and "jpg" not in content_type.lower():
        print(f"Warning: content-type is {content_type}")

    file_path = SAVE_DIR / f"img_{index:04d}.jpg"
    file_path.write_bytes(response.content)
    return file_path, len(response.content)


def main():
    print(f"Capture URL: {CAPTURE_URL}")
    print(f"Save dir: {SAVE_DIR}")
    print(f"Target count: {SAVE_COUNT}")

    ser = open_serial()
    send_progress(ser, 0, SAVE_COUNT, "START")

    success_count = 0
    try:
      for index in range(1, SAVE_COUNT + 1):
          print(f"[{index}/{SAVE_COUNT}] capture...")
          try:
              file_path, size_bytes = save_one_image(index)
              success_count += 1
              print(f"saved -> {file_path.name} ({size_bytes} bytes)")
              send_progress(ser, index, SAVE_COUNT, "OK")
          except Exception as exc:
              print(f"capture failed: {exc}")
              send_progress(ser, index, SAVE_COUNT, "FAIL")
              break

          if index < SAVE_COUNT:
              time.sleep(SAVE_INTERVAL_SECONDS)
    finally:
      if success_count >= SAVE_COUNT:
          send_progress(ser, SAVE_COUNT, SAVE_COUNT, "DONE")
      elif success_count > 0:
          send_progress(ser, success_count, SAVE_COUNT, "STOP")

      if ser is not None:
          ser.close()

    print(f"Finished. Saved {success_count} image(s).")


if __name__ == "__main__":
    sys.exit(main())
