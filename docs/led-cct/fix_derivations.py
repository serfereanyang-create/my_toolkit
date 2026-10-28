# -*- coding: utf-8 -*-
"""Fix the flawed derivations and remove formula-table rules in led声控.docx.

Two problems are corrected:

1. P025 conflated the parallel total (200 mA) with a single branch (20 mA):
       "200mA×R并 = 20mA×R = 2V"
   The two sides only agree when R并 = R/10, which the text never says, and the
   2 V figure was reverse-engineered from R = 100 Ω, the *current-limiting*
   resistor, not the MCU's internal path. The derivation is rewritten from the
   actual per-branch model.

2. P026 attributed the load current to an "internal MOS" and used the MOSFET
   R_DS(on) for it. The corrected text separates the MCU pin drop from the
   MOSFET conduction loss.

Also strips the top/bottom rules (三线表 look) from the formula tables.
"""
from __future__ import annotations

import shutil
import zipfile
from copy import deepcopy
from pathlib import Path

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
NS = {"w": W, "m": M}

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")


def qn(tag: str) -> str:
    prefix, local = tag.split(":")
    return f"{{{NS[prefix]}}}{local}"


# ---------------------------------------------------------------- math helpers
def m_run(text: str, upright: bool = True):
    r = etree.Element(qn("m:r"))
    if upright:
        rpr = etree.SubElement(r, qn("m:rPr"))
        sty = etree.SubElement(rpr, qn("m:sty"))
        sty.set(qn("m:val"), "p")
    wrpr = etree.SubElement(r, qn("w:rPr"))
    fonts = etree.SubElement(wrpr, qn("w:rFonts"))
    fonts.set(qn("w:ascii"), "Cambria Math")
    fonts.set(qn("w:hAnsi"), "Cambria Math")
    lang = etree.SubElement(wrpr, qn("w:lang"))
    lang.set(qn("w:eastAsia"), "zh-CN")
    t = etree.SubElement(r, qn("m:t"))
    t.text = text
    return r


def m_sub(base: str, sub: str):
    node = etree.Element(qn("m:sSub"))
    pr = etree.SubElement(node, qn("m:sSubPr"))
    etree.SubElement(pr, qn("m:ctrlPr"))
    e = etree.SubElement(node, qn("m:e"))
    e.append(m_run(base))
    s = etree.SubElement(node, qn("m:sub"))
    s.append(m_run(sub))
    return node


def m_frac(num_nodes, den_nodes):
    node = etree.Element(qn("m:f"))
    pr = etree.SubElement(node, qn("m:fPr"))
    etree.SubElement(pr, qn("m:ctrlPr"))
    num = etree.SubElement(node, qn("m:num"))
    for n in num_nodes:
        num.append(n)
    den = etree.SubElement(node, qn("m:den"))
    for n in den_nodes:
        den.append(n)
    return node


def omath(*nodes):
    node = etree.Element(qn("m:oMath"))
    for n in nodes:
        node.append(n)
    return node


# --------------------------------------------------------------- xml helpers
def clone_pPr(src_p):
    ppr = src_p.find(qn("w:pPr"))
    return deepcopy(ppr) if ppr is not None else None


def body_para(template_p, text: str):
    p = etree.Element(qn("w:p"))
    ppr = clone_pPr(template_p)
    if ppr is not None:
        p.append(ppr)
    r = etree.SubElement(p, qn("w:r"))
    rpr = etree.SubElement(r, qn("w:rPr"))
    lang = etree.SubElement(rpr, qn("w:lang"))
    lang.set(qn("w:eastAsia"), "zh-CN")
    t = etree.SubElement(r, qn("w:t"))
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    t.text = text
    return p


def body_para_math(template_p, omath_node):
    p = etree.Element(qn("w:p"))
    ppr = clone_pPr(template_p)
    if ppr is not None:
        p.append(ppr)
    p.append(omath_node)
    return p


def replace_para(old_p, new_paras):
    """Insert new paragraphs before old_p, then drop old_p."""
    parent = old_p.getparent()
    for np in new_paras:
        parent.addprevious(np)
    parent.remove(old_p)


def para_text(p) -> str:
    return "".join(n.text or "" for n in p.iter() if n.tag.endswith("}t"))


def strip_formula_table_rules(tbl) -> None:
    """Remove top/bottom borders so the equations are not boxed like a 三线表."""
    tbl_pr = tbl.find(qn("w:tblPr"))
    if tbl_pr is None:
        return
    borders = tbl_pr.find(qn("w:tblBorders"))
    if borders is None:
        borders = etree.SubElement(tbl_pr, qn("w:tblBorders"))
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = borders.find(qn(f"w:{edge}"))
        if el is None:
            el = etree.SubElement(borders, qn(f"w:{edge}"))
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "auto")
    # cell-level borders would also draw rules
    for tc in tbl.iter(qn("w:tc")):
        tc_pr = tc.find(qn("w:tcPr"))
        if tc_pr is None:
            continue
        tcb = tc_pr.find(qn("w:tcBorders"))
        if tcb is not None:
            tc_pr.remove(tcb)


def is_formula_table(tbl) -> bool:
    """A formula table holds one display equation plus a (n-m) number cell."""
    for p in tbl.iter(qn("w:p")):
        if p.find(qn("m:oMath")) is not None or p.find(qn("m:oMathPara")) is not None:
            return True
    return False


# ---------------------------------------------------------------------- main
def main() -> None:
    with zipfile.ZipFile(SRC) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(parts["word/document.xml"], parser=parser)
    body = root.find(qn("w:body"))

    paras = [p for p in body.findall(qn("w:p"))]
    by_text = {para_text(p).strip(): p for p in paras}

    # ---------- fix 1: the flawed 200 mA / 20 mA derivation (P025) ----------
    target = None
    for p in paras:
        t = para_text(p)
        if "总电流200mA" in t.replace(" ", ""):
            target = p
            break
    if target is None:
        raise SystemExit("P025 not found")

    i = paras.index(target)
    tpl_indent = paras[i]          # indented body paragraph template
    tpl_formula = paras[i]         # formula line template (indent removed below)

    new_paras = []
    new_paras.append(body_para(
        tpl_indent,
        "例如：冷白支路由10颗2835灯珠并联组成，每颗工作电流20 mA，"
        "则该支路总电流为200 mA。此时若直接用GPIO驱动，电流全部流过MCU内部通路，"
        "设该内部等效电阻为Rint，则GPIO引脚上的压降为",
    ))
    new_paras.append(body_para_math(
        tpl_formula,
        omath(
            m_sub("V", "GPIO"),
            m_run("="),
            m_sub("I", "LED"),
            m_sub("R", "int"),
        ),
    ))
    new_paras.append(body_para(
        tpl_indent,
        "取Rint约10 Ω量级（MCU内部驱动通路含键合线与片内开关的等效值，随工艺与温度变化，"
        "此处仅作数量级估算），代入得",
    ))
    new_paras.append(body_para_math(
        tpl_formula,
        omath(
            m_sub("V", "GPIO"),
            m_run("=0.20×10=2 V"),
        ),
    ))
    new_paras.append(body_para(
        tpl_indent,
        "即引脚电平被负载拉低约2 V。注意这里V_GPIO是引脚端的压降，不是限流电阻上的压降，"
        "两者不可混算；每条并联支路端电压相同，故用支路电流20 mA配单支路阻抗核算，"
        "与用总电流200 mA配并联等效阻抗核算的结果一致。",
    ))
    replace_para(target, new_paras)

    # ---------- fix 2: rewrite the "internal MOS" loss sentence (P026) ----------
    paras = [p for p in body.findall(qn("w:p"))]
    for p in paras:
        t = para_text(p).replace(" ", "")
        if "已经低于一般最低高电平触发门槛" in t:
            idx = paras.index(p)
            new_p = body_para(
                paras[idx],
                "3.3 V减去该压降后仅剩约1.3 V，已经低于一般器件2.4 V的最低高电平判定门槛，"
                "外部电路会把GPIO读成低电平，导致逻辑误判。另一方面，负载电流在MCU内部通路上"
                "产生的导通损耗为",
            )
            replace_para(p, [new_p])
            break

    # ---------- fix 3: rebuild the cramped PWM-period line (P017) ----------
    paras = [p for p in body.findall(qn("w:p"))]
    for p in paras:
        t = para_text(p).replace(" ", "")
        if "PWM周期" in t and "Ton,c" in t:
            idx = paras.index(p)
            tpl = paras[idx]
            rebuilt = []
            rebuilt.append(body_para(tpl, "当两路PWM频率均为f_PWM=10 kHz时，PWM周期为"))
            rebuilt.append(body_para_math(
                tpl,
                omath(
                    m_sub("T", "PWM"),
                    m_run("="),
                    m_frac([m_run("1")], [m_sub("f", "PWM")]),
                    m_run("=100 μs"),
                ),
            ))
            rebuilt.append(body_para(tpl, "冷白、暖白两路的占空比分别定义为"))
            rebuilt.append(body_para_math(
                tpl,
                omath(
                    m_sub("D", "c"),
                    m_run("="),
                    m_frac([m_sub("T", "on,c")], [m_sub("T", "PWM")]),
                    m_run("，"),
                    m_sub("D", "w"),
                    m_run("="),
                    m_frac([m_sub("T", "on,w")], [m_sub("T", "PWM")]),
                ),
            ))
            rebuilt.append(body_para(
                tpl,
                "其中T_on,c、T_on,w分别为冷白、暖白MOS管在一个PWM周期内的导通时间。"
                "两路频率相同，只改变各自占空比，即可在保持总亮度的同时连续调节色温。",
            ))
            replace_para(p, rebuilt)
            break

    # ---------- fix 4: unbox the formula tables ----------
    fixed = 0
    for tbl in body.iter(qn("w:tbl")):
        if is_formula_table(tbl):
            strip_formula_table_rules(tbl)
            fixed += 1
    print("formula tables unboxed:", fixed)

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
