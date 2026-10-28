"""Dump raw XML of P017 and P026 to see exact structure."""
import re
import zipfile
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
with zipfile.ZipFile(p) as z:
    xml = z.read("word/ ... [truncated 922 chars]