"""Strip top/bottom rule lines from the five formula tables in led声控.docx."""
import re
import shutil
import zipfile
from pathlib import Path

from lxml import etree

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M_OMATH = "{http://schemas.openxmlformats.org/officeDocument/2006/math}oMath"


def w(tag):
    return f"{{{W}}}{tag}"


def is_formula_table(tbl):
    """Two-column table whose first cell holds an oMathPara equation."""
    grid = tbl.find(w("tblGrid"))
    if grid is None or len(grid.findall(w("gridCol"))) != 2:
        return False
    return any(tbl.iter(M_OMATH))


def nuke_borders(tbl):
    """Replace tblBorders with an all-none block so no rule renders."""
    pr = tbl.find(w("tblPr"))
    if pr is None:
        return False
    old = pr.find(w("tblBorders"))
    if old is not None:
        pr.remove(old)
    borders = etree.SubElement(pr, w("tblBorders"))
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = etree.SubElement(borders, w(edge))
        e.set(w("val"), "none")
        e.set(w("sz"), "0")
        e.set(w("space"), "0")
        e.set(w("color"), "auto")
    return True


def strip_cell_borders(tbl):
    n = 0
    for cb in tbl.iter(w("tcBorders")):
        for child in list(cb):
            if etree.QName(child).localname in {"top", "bottom"}:
                cb.remove(child)
                n += 1
    return n


def main():
    with zipfile.ZipFile(SRC) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(w("body"))

    fixed = cell_fixed = 0
    for tbl in body.iter(w("tbl")):
        if is_formula_table(tbl):
            nuke_borders(tbl)
            cell_fixed += strip_cell_borders(tbl)
            fixed += 1

    print("formula tables unruled:", fixed, "cell rules removed:", cell_fixed)
    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    tmp = SRC.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    shutil.move(str(tmp), str(SRC))
    print("updated", SRC)


if __name__ == "__main__":
    main()
