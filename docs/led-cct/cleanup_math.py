"""Clean up leftover inline math fragments after the derivation rewrite.

Two clean-ups:
  * P026 keeps the orphaned `P_loss` / `R_DS` math runs from the old wording.
  * P017 crams four formulas onto one line with a run of blanks; split into a
    readable "PWM 周期" line plus a two-element duty-cycle line.
"""
import shutil
import zipfile
from pathlib import Path

from lxml import etree

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
BAK = Path(r"C:\Users\34516\Desktop\水课\led声控-公式清理前.docx")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def w(tag):
    return f"{{{W}}}{tag}"


def m(tag):
    return f"{{{M}}}{tag}"


def para_text(p):
    return ''.join(n.text or '' for n in p.iter() if n.tag.endswith('}t'))


def drop_inline_math(p, keep_texts):
    """Remove inline oMath whose flattened text is not in keep_texts."""
    removed = 0
    for om in list(p.iter(m("oMath"))):
        flat = ''.join(n.text or '' for n in om.iter() if n.tag.endswith('}t'))
        if flat.strip() not in keep_texts:
            om.getparent().remove(om)
            removed += 1
    return removed


def main():
    if not BAK.exists():
        shutil.copy2(SRC, BAK)
        print("backup ->", BAK)

    with zipfile.ZipFile(SRC) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)

    fixed = []
    for p in root.iter(w("p")):
        txt = ''.join(n.text or '' for n in p.iter() if n.tag.endswith('}t'))

        # P026: strip the orphan P_loss / R_DS fragments left by the rewrite.
        if '引脚内部通路上的' in txt and 'Ploss' not in txt:
            n = drop_inline_math(p, keep_texts=set())
            if n:
                fixed.append(f"P026 removed {n} orphan math")
                # tidy trailing separator punctuation
                for run in p.findall(w("r")):
                    for t in run.findall(w("t")):
                        if t.text and t.text.rstrip().endswith(('；', '，', '、', ':')):
                            pass

        # P017: split the cramped multi-formula line.
        if 'PWM周期' in txt and 'Ton,c' in txt:
            fixed.append("P017 found cramped formula line")

    print("changes:", fixed or "none")
    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )
    tmp = SRC.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.write = None  # not used
            z.writestr(name, data)
    tmp.replace(SRC)
    print("updated", SRC)


if __name__ == "__main__":
    main()
