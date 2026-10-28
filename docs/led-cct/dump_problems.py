# -*- coding: utf-8 -*-
"""Dump raw paragraph XML for the paragraphs containing wrong derivations."""
from docx import Document
from pathlib import Path
from lxml import etree

src = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
d = Document(str(src))

targets = {17, 24, 25, 26, 29, 30}
out_dir = Path(r"C:\Users\34516\ZCodeProject\docs\led-cct\problem-paras")
out_dir.mkdir(parents=True, exist_ok=True)

for i, para in enumerate(d.paragraphs):
    if i in targets:
        xml = etree.tostring(para._p, pretty_print=True).decode("utf-8")
        (out_dir / f"p{i:03d}.xml").write_text(xml, encoding="utf-8")
        txt = "".join(n.text or "" for n in para._p.iter() if n.tag.endswith("}t"))
        print(f"--- P{i:03d}: {txt}")
print("done")
