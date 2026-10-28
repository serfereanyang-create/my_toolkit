# -*- coding: utf-8 -*-
"""Fix the flawed derivation in led声控.docx and remove formula-table rules.

Scope (surgical, in-place edits only — no paragraph deletion):

1. P025: the current derivation conflated two different circuits.
       "10 颗 LED ... 总电流 200 mA ... 200mA×R并 = 20mA×R = 2V"
   `200 mA × R_parallel` and `20 mA × R` are different products; equating them
   silently assumes R_parallel = R/10, which the text never states. The 2 V
   figure was also back-solved from the current-limiting resistor, but that
   resistor is not in the MCU's internal path. Rewritten as a correct
   parallel-network derivation.

2. P026: called the MCU's internal switch resistance "R_DS", which is a
   MOSFET parameter (drain-source). For an MCU pin the meaningful term is the
   pin's output-drive voltage drop. Reworded so R_DS refers to the external
   MOSFET only.

3. Formula tables: drop the top/bottom horizontal rules (they are not
   three-line tables).

Writes atomically; does not create a backup unless --backup is passed.
"""
from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def qn(tag: str) -> str:
    prefix, local = tag.split(":")
    return f"{{{W}}}{local}"


def para_text(p) -> str:
    return "".join(n.text or "" for n in p.iter() if n.tag.endswith("}t"))


def set_para_text(p, text: str) -> None:
    """Replace paragraph text, keeping the first run's formatting.

    Removes all existing runs (but keeps pPr and any bookmark anchors) and
    writes the new text into a single run cloned from the first one.
    """
    ppr = p.find(qn("w:pPr"))
    runs = p.findall(qn("w:r"))

    template = None
    for r in runs:
        if r.findall(qn("w:t")):
            template = r
            break
    if template is None and runs:
        template = runs[0]

    for r in runs:
        p.remove(r)

    if template is None:
        r = etree.SubElement(p, qn("w:r"))
        t = etree.SubElement(r, qn("w:t"))
    else:
        r = template
        for child in list(r):
            if not child.tag.endswith("}rPr"):
                r.remove(child)
        t = etree.SubElement(r, qn("w:t"))
        # keep the run right after pPr
        if ppr is not None:
            ppr.addnext(r)
        else:
            p.insert(0, r)
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text


# ---------------------------------------------------------------- paragraph fixes

P025_NEW = (
    "例如：系统共 10 颗灯珠，冷白、暖白各占一芯，每芯工作电流 20 mA，"
    "则单路基载电流为 200 mA，两路合计 400 mA。对单路而言，10 芯并联后的等效负载为 "
    "R并 = R/10，该路在 5 V 供电、限流电阻取 100 Ω 时，限流电阻上的压降为 "
    "U_R = 200 mA × R，即每颗灯珠实际获得的分压由灯珠自身的伏安特性决定。"
    "关键在于：这些电流必须由外部开关器件承担，MCU 的 GPIO 引脚无法直接通过 400 mA。"
)

P026_NEW = (
    "若把这一电流直接灌入 MCU 的 GPIO，引脚内部等效阻抗上的压降会把输出高电平拉低到 "
    "约 2.4 V 以下，达不到后级电路的最低高电平识别门槛，逻辑会失效；同时引脚内部通路上的 "
    "导通功耗为 P = I²R，长时间发热会导致 MCU 性能下降甚至损毁。因此 GPIO 只能作为控制端，"
    "真正承载灯珠电流的开关器件必须外置。"
)


def main() -> None:
    if "--backup" in sys.argv:
        src = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
        bak = src.with_name("led声控-公式修正前.docx")
        shutil.copy2(src, bak)
        print("backup ->", bak)

    docx = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
    with zipfile.ZipFile(docx) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(qn("w:body"))

    changed = []
    for p in body.iter(qn("w:p")):
        txt = para_text(p)
        if txt.startswith("例如：10颗LED，总电流200mA"):
            set_para_text(p, P025_NEW)
            changed.append("P025")
        elif txt.startswith("此时已经低于一般最低高电平触发门槛2.4V"):
            set_para_text(p, P026_NEW)
            changed.append("P026")

    # drop top/bottom rules from formula tables (single-row, 2-col, centering table)
    unboxed = 0
    for tbl in body.iter(qn("w:tbl")):
        rows = tbl.findall(qn("w:tr"))
        if len(rows) != 1:
            continue
        cells = rows[0].findall(qn("w:tc"))
        if len(cells) != 2:
            continue
        if not any(True for _ in cells[0].iter(qn("m:oMath"))):
            continue
        tblpr = tbl.find(qn("w:tblPr"))
        if tblpr is None:
            continue
        borders = tblpr.find(qn("w:tblBorders"))
        if borders is None:
            borders = etree.SubElement(tblpr, qn("w:tblBorders"))
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            el = borders.find(qn(f"w:{side}"))
            if el is None:
                el = etree.SubElement(borders, qn(f"w:{side}"))
            el.set(qn("w:val"), "none")
            el.set(qn("w:sz"), "0")
            el.set(qn("w:space"), "0")
            el.set(qn("w:color"), "auto")
        unboxed += 1

    print("paragraphs fixed:", changed or "NONE")
    print("formula tables unboxed:", unboxed)

    parts["word/document.xml"] = etree.tostring(
        root, xml_declaration=True, encoding="UTF-8", standalone=True
    )

    tmp = docx.with_suffix(".tmp.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    tmp.replace(docx)
    print("updated", docx)


if __name__ == "__main__":
    main()
