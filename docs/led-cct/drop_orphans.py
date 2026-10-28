"""Remove the two orphaned inline math runs at the end of P026."""
import shutil
import zipfile
from pathlib import Path

from lxml import etree

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def m(tag):
    return f"{{{M}}}{tag}"


def main():
    with zipfile.ZipFile(SRC) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(f"{{{W}}}body")

    removed = 0
    for para in body.iter(f"{{{W}}}p"):
        # Only touch the paragraph that has the repaired wording
        txt = "".join(t.text or "" for t in para.iter() if t.tag.endswith("}t"))
        if "引脚内部等效阻抗上的压降" not in txt:
            continue
        for omath in list(para):
            if omath.tag == m("oMath"):
                # drop trailing orphaned formula runs
                after = "".join(
                    t.text or "" for t in omath.iter() if t.tag.endswith("}t")
                )
                if after.strip() in {"Ploss", "RDS"}:
                    para.remove(omath)
                    removed += 1

    print("orphan math runs removed:", removed)
    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    tmp = SRC.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.write_bytes = None  # placeholder
    # rewrite properly
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    tmp.replace(SRC)
    print("updated", SRC)


if __name__ == "__main__":
    main()
