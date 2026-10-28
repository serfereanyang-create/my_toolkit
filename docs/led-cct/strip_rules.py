# -*- coding: utf-8 -*-
"""Remove the top rule line from the five formula tables.

The formula tables (2-column: equation + number) still carry a single top
border, which renders as a line across the page. A formula is not a
three-line table, so that rule should not be there.

Only tables whose content is a single math object are touched; the control
table (T0) and the BOM table (T6) keep their formatting.
"""
from __future__ import annotations

import re
import shutil
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def q(tag: str) -> str:
    prefix, local = tag.split(":")
    ns = {"w": W, "m": M}[prefix]
    return f"{{{ns}}}{local}"


def is_formula_table(tbl: etree._Element) -> bool:
    """A formula table holds one math object and almost no running text."""
    if len(tbl.findall(q("w:tr"))) != 1:
        return False
    maths = tbl.findall(f".//{q('m:oMath')}")
    if len(maths) != 1:
        return False
    text = "".join(t.text or "" for t in tbl.iter(q("w:t")))
    # the trailing "(1-1-x)" label is the only expected plain text
    return len(re.sub(r"\(\d+-\d+-\d+\)", "", text).strip()) <= 2


def strip_rule(tbl: etree._Element) -> bool:
    """Drop the table-level top/left/right/inside borders, keep the bottom."""
    pr = tbl.find(q("w:tblPr"))
    if pr is None:
        return False
    borders = pr.find(q("w:tblBorders"))
    if borders is None:
        return False
    changed = False
    for child in list(borders):
        tag = etree.QName(child).localname
        if tag in {"top", "left", "right", "insideH", "insideV"}:
            borders.remove(child)
            changed = True
    # also clear any cell-level top/bottom rules
    for cell_borders in tbl.iter(q("w:tcBorders")):
        for child in list(cell_borders):
            if etree.QName(child).localname in {"top", "bottom"}:
                cell_borders.remove(child)
                changed = True
    if not list(borders):
        pr.remove(borders)
    return changed


def main() -> None:
    src = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
    with zipfile.ZipFile(src) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(q("w:body"))

    fixed = 0
    for tbl in body.iter(q("w:tbl")):
        if is_formula_table(tbl) and strip_rule(tbl):
            fixed += 1

    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    tmp = src.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    shutil.move(str(tmp), str(src))
    print("formula tables unruled:", fixed)
    print("updated", src)


if __name__ == "__main__":
    main()
