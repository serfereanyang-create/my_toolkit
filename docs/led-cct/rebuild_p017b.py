import copy
import shutil
import zipfile
from pathlib import Path

from lxml import etree

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"


def w(t):
    return f"{{{W}}}{t}"


def m(t):
    return f"{{{M}}}{t}"


def txt_of(el):
    return "".join(n.text or "" for n in el.iter() if n.tag.endswith("}t"))


def make_run(text):
    r = etree.SubElement(etree.Element("tmp"), w("r"))
    t = etree.SubElement(r, w("t"))
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    rpr = etree.Element(w("rPr"))
    fonts = etree.SubElement(rpr, w("rFonts"))
    fonts.set(w("cs"), "Times New Roman")
    lang = etree.SubElement(rpr, w("lang"))
    lang.set(w("eastAsia"), "zh-CN")
    r.insert(0, rpr)
    return r


def clean_para(template, keep=()):
    """Clone template paragraph, keeping pPr and only the listed child kinds."""
    new = etree.Element(w("p"))
    ppr = template.find(w("pPr"))
    if ppr is not None:
        new.append(copy.deepcopy(ppr))
    return new


def main():
    bak = SRC.with_name("led声控-公式排版前.docx")
    if not bak.exists():
        shutil.copy2(SRC, bak)
        print("backup ->", bak)

    with zipfile.ZipFile(SRC) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(w("body"))

    paras = [p for p in body.iter(w("p"))]
    target = None
    for p in paras:
        if "PWM周期" in txt_of(p) and "冷暖光通道占比" in txt_of(p):
            target = p
            break

    if target is None:
        print("P017 not found")
        return

    print("found target para")

    # Collect the existing math elements to reuse (keeps Cambria Math formatting)
    maths = [el for el in target.iter(m("oMath"))]

    parent = target.getparent()
    idx = list(parent).index(target)

    ppr_src = target.find(w("pPr"))

    def build(children):
        p = etree.Element(w("p"))
        if ppr_src is not None:
            p.append(copy.deepcopy(ppr_src))
        for c in children:
            p.append(c)
        return p

    def clone_math(i):
        return copy.deepcopy(maths[i])

    def clone_run_like(ref_run_text):
        for r in target.findall(w("r")):
            if txt_of(r).strip() == ref_run_text:
                return copy.deepcopy(r)
        return make_run(ref_run_text)

    new_paras = []

    # 1) PWM周期： <math TPWM=1/fPWM=100us>
    p1 = build([clone_run_like("PWM周期："), clone_math(0)])
    new_paras.append(p1)

    # 2) 冷暖光通道占比：  <math Dc>  <math Dw>
    # the "=" run between them is dropped; keep the two formulas clean
    p2 = build([clone_run_like("冷暖光通道占比："), clone_math(1)])
    new_paras.append(p2)

    p3 = build([make_run("冷白通道占空比 D_c = T_on,c / T_PWM，暖白通道占空比 D_w = T_on,w / T_PWM，其中 T_on,c、T_on,w 分别对应 MOS 管在一个 PWM 周期内的导通时间。")])
    new_paras.append(p3)

    for offset, np_ in enumerate(new_paras):
        parent.insert(idx + offset, np_)
    parent.remove(target)

    print("paragraphs inserted:", len(new_paras))

    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    tmp = SRC.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    tmp.replace(SRC)
    print("updated", SRC)


if __name__ == "__main__":
    main()
