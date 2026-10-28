# -*- coding: utf-8 -*-
"""Locate and print the P_loss formula (1-1-1) in the document."""
import re
import zipfile
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
with zipfile.ZipFile(p) as z:
    xml = z.read("word/document.xml").decode("utf-8")

# find every oMath and report its text plus nearby paragraph text
for i, m in enumerate(re.finditer(r"<m:oMath\b.*?</m:oMath>", xml, re.S)):
    frag = m.group(0)
    mt = re.findall(r"<m:t[^>]*>(.*?)</m:t>", frag, re.S)
    kinds = []
    if "<m:f>" in frag:
        kinds.append("FRAC")
    if "<m:sSup>" in frag:
        kinds.append("SUP")
    if "<m:sSub>" in frag:
        kinds.append("SUB")
    if "<m:rad>" in frag:
        kinds.append("RAD")
    print(f"#{i:02d} [{'/'.join(kinds) or 'plain'}] {''.join(mt)!r}")
