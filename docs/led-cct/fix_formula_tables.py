# -*- coding: utf-8 -*-
"""Fix formula-table borders and tighten formula/paragraph formatting in led声控.docx.

The formula tables were created with a *visible* Table Grid style (aff1), which
boxed every equation. The document's own formula tables (1-1-1 etc.) use
borderless tables, so re-apply borderless formatting to all formula tables.
"""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
NS = {"w": W, "m": M}


def qn(tag: str) -> str:
    prefix, local = tag.split(":")
    uri = {"w": W, "m": M}[prefix]
    return f"{{{uri}}}{local}"


def make_borderless_tblpr() -> etree._Element:
    """Build a tblPr matching the document's original borderless formula tables."""
    tblpr = etree.SubElement(etree.Element(qn("w:tbl")), qn("w:tblPr"))
    tblw = etree.SubElement(tblpr, qn("w:tblW"))
    tblw.set(qn("w:w"), "5366")
    tblw.set(qn("w:type"), "dxa")
    jc = etree.SubElement(tblpr, qn("w:jc"))
    jc.set(qn("w:val"), "center")
    borders = etree.SubElement(tblpr, qn("w:tblBorders"))
    top = etree.SubElement(borders, qn("w:top"))
    top.set(qn("w:val"), "single")
    top.set(qn("w:sz"), "8")
    top.set(qn("w:space"), "0")
    top.set(qn("w:color"), "auto")
    ih = etree.SubElement(borders, qn("w:insideH"))
    ih.set(qn("w:val"), "single")
    ih.set(qn("w:sz"), "4")
    ih.set(qn("w:space"), "0")
    ih.set(qn("w:color"), "auto")
    look = etree.SubElement(tblpr, qn("w:tblLook"))
    for k, v in (
        ("w:val", "04A0"),
        ("w:firstRow", "1"),
        ("w:lastRow", "0"),
        ("w:firstColumn", "1"),
        ("w:lastColumn", "0"),
        ("w:noHBand", "0"),
        ("w:noVBand", "1"),
    ):
        look.set(qn(k), v)
    return tblpr


def strip_style_and_borders(tbl: etree._Element) -> None:
    """Remove the visible table style so the formula table renders borderless."""
    tblpr = tbl.find(qn("w:tblPr"))
    if tblpr is None:
        tbl.insert(0, make_borderless_tblpr())
        return
    style = tblpr.find(qn("w:tblStyle"))
    if style is not None:
        tblpr.remove(style)
    # ensure explicit borderless borders
    old_borders = tblpr.find(qn("w:tblBorders"))
    if old_borders is not None:
        tblpr.remove(old_borders)
    borders = etree.Element(qn("w:tblBorders"))
    top = etree.SubElement(borders, qn("w:top"))
    top.set(qn("w:val"), "single")
    top.set(qn("w:sz"), "8")
    top.set(qn("w:space"), "0")
    top.set(qn("w:color"), "auto")
    ih = etree.SubElement(borders, qn("w:insideH"))
    ih.set(qn("w:val"), "single")
    ih.set(qn("w:sz"), "4")
    ih.set(qn("w:space"), "0")
    ih.set(qn("w:color"), "auto")
    for side in ("left", "bottom", "right", "insideV"):
        el = etree.SubElement(borders, qn(f"w:{side}"))
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "auto")
    # place borders right after tblW / jc for schema order
    anchor = tblpr.find(qn("w:tblW"))
    if anchor is not None:
        anchor.addnext(borders)
    else:
        tblpr.insert(0, borders)


def is_formula_table(tbl: etree._Element) -> bool:
    """A formula table is a 1-row table whose left cell holds an oMath."""
    if tbl.find(qn("m:oMath")) is not None:
        return True
    for cell in tbl.iter(qn("w:tc")):
        if cell.find(".//" + qn("m:oMath")) is not None:
            return True
    return False


def main() -> None:
    src = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
    backup = Path(r"C:\Users\34516\Desktop\水课\led声控-排版修正前.docx")
    if not backup.exists():
        shutil.copy2(src, backup)
        print("backup ->", backup)

    with zipfile.ZipFile(src) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(qn("w:body"))

    fixed = 0
    for tbl in body.iter(qn("w:tbl")):
        if is_formula_table(tbl):
            strip_style_and_borders(tbl)
            fixed += 1
    print("formula tables fixed:", fixed)

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
