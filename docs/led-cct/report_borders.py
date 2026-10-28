# -*- coding: utf-8 -*-
"""Report which tables still carry visible top/bottom borders."""
import re
import zipfile
from html import unescape as html_unescape
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
with zipfile.ZipFile(p) as z:
    xml = z.read("word/document.xml").decode("utf-8")

for i, m in enumerate(re.finditer(r"<w:tbl>.*?</w:tbl>", xml, re.S)):
    frag = m.group(0)
    txt = "".join(html_unescape(t) for t in re.findall(r"<w:t[^>]*>(.*?)</w:t>", frag, re.S))
    n_top = frag.count('<w:top w:val="single"')
    n_bot = frag.count('<w:bottom w:val="single"')
    has_style = "<w:tblStyle" in frag
    print(f"T{i}: top={n_top} bottom={n_bot} style={has_style} | {txt[:60]!r}")


def html_unescape(s: str) -> str:
    import html
    return html.unescape(s)
