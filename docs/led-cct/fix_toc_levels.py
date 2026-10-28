# -*- coding: utf-8 -*-
"""Make heading outline levels consistent so Word's TOC picks up every section.

`1.1选材` was missing an outlineLvl, so it never appeared in the TOC even though
its sibling headings (1.2/1.3/...) are level 1. Set it to match.
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def qn(tag: str) -> str:
    prefix, local = tag.split(":")
    return f"{{{W}}}{local}"


TARGETS = {
    "1.1选材": 1,
}


def para_text(p) -> str:
    return "".join(t.text or "" for t in p.iter(qn("w:t")))


def set_outline(p, level: int) -> None:
    pPr = p.find(qn("w:pPr"))
    if pPr is None:
        pPr = etree.SubElement(p, qn("w:pPr"))
        p.insert(0, pPr)
    for old in pPr.findall(qn("w:outlineLvl")):
        pPr.remove(old)
    ind = pPr.find(qn("w:ind"))
    node = etree.Element(qn("w:outlineLvl"))
    node.set(qn("w:val"), str(level))
    if ind is not None:
        ind.addnext(node)
    else:
        rPr = pPr.find(qn("w:rPr"))
        if rPr is not None:
            rPr.addprevious(node)
        else:
            pPr.append(node)
    # styled headings carry a colour; match the bold black of sibling headings
    rPr = pPr.find(qn("w:rPr"))
    if rPr is None:
        rPr = etree.SubElement(pPr, qn("w:rPr"))
    for tag in ("w:b", "w:bCs"):
        if rPr.find(qn(tag)) is None:
            etree.SubElement(rPr, qn(tag))


def main() -> None:
    src = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
    backup = Path(r"C:\Users\34516\Desktop\水课\led声控-目录修正前.docx")
    if not backup.exists():
        shutil.copy2(src, backup)
        print("backup ->", backup)

    with zipfile.ZipFile(src) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(qn("w:body"))

    fixed = 0
    for p in body.iter(qn("w:p")):
        text = para_text(p).strip()
        for prefix, level in TARGETS.items():
            if text.startswith(prefix):
                set_outline(p, level)
                fixed += 1
                print(f"outlineLvl={level} -> {text}")
    print("headings fixed:", fixed)

    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    tmp = src.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    tmp.replace(src)
    print("updated", src)


if __name__ == "__main__":
    main()
