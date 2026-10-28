# -*- coding: utf-8 -*-
"""Complete the component-selection sections in led声控.docx."""
from __future__ import annotations

import shutil
import zipfile
from copy import deepcopy
from pathlib import Path

from lxml import etree

SRC = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
BACKUP = Path(r"C:\Users\34516\Desktop\水课\led声控-改前备份.docx")
UNPACKED = Path(r"C:\Users\34516\ZCodeProject\docs\led-cct\unpacked")
DOC_XML = UNPACKED / "word" / "document.xml"

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
XML = "http://www.w3.org/XML/1998/namespace"
NSMAP_WM = {"w": W, "m": M}


def q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def el(ns: str, tag: str, parent=None, **attrs):
    node = etree.Element(q(ns, tag))
    for key, val in attrs.items():
        if key == "xml_space":
            node.set(q(XML, "space"), val)
            continue
        if key.startswith("xml_"):
            node.set(q(XML, key[4:]), str(val))
            continue
        node.set(q(ns, key), str(val))
    if parent is not None:
        parent.append(node)
    return node


def rpr_body(parent, east="宋体", ascii_font="Times New Roman", bold=False, sz=None, hint=None):
    rpr = el(W, "rPr", parent)
    fonts = el(W, "rFonts", rpr, ascii=ascii_font, eastAsia=east, hAnsi=ascii_font)
    if hint:
        fonts.set(q(W, "hint"), hint)
    if bold:
        el(W, "b", rpr)
        el(W, "bCs", rpr)
    if sz is not None:
        el(W, "sz", rpr, val=str(sz))
        el(W, "szCs", rpr, val=str(sz))
    el(W, "lang", rpr, eastAsia="zh-CN")
    return rpr


def w_r(text: str, *, bold=False, east="宋体", ascii_font="Times New Roman", sz=None, hint=None):
    r = el(W, "r")
    rpr_body(r, east=east, ascii_font=ascii_font, bold=bold, sz=sz, hint=hint)
    t = el(W, "t", r)
    if text[:1].isspace() or text[-1:].isspace():
        t.set(q(XML, "space"), "preserve")
    t.text = text
    return r


def clear_runs(p):
    for child in list(p):
        if child.tag != q(W, "pPr"):
            p.remove(child)


def set_text(p, text: str, *, heading=False, outline=None, bold=None):
    ppr = p.find(q(W, "pPr"))
    if ppr is None:
        ppr = el(W, "pPr")
        p.insert(0, ppr)
    ol = ppr.find(q(W, "outlineLvl"))
    if outline is None:
        if ol is not None:
            ppr.remove(ol)
    else:
        if ol is None:
            ol = el(W, "outlineLvl", val=str(outline))
            ppr.append(ol)
        else:
            ol.set(q(W, "val"), str(outline))
    is_heading = heading or outline is not None
    if bold is None:
        bold = is_heading
    east = "黑体" if is_heading else "宋体"
    ascii_font = "黑体" if is_heading else "Times New Roman"
    spacing = ppr.find(q(W, "spacing"))
    if spacing is None:
        spacing = el(W, "spacing", ppr, before="120", after="80", line="300" if is_heading else "360", lineRule="auto")
    else:
        spacing.set(q(W, "line"), "300" if is_heading else "360")
    if is_heading:
        ind = ppr.find(q(W, "ind"))
        if ind is not None:
            ppr.remove(ind)
        jc = ppr.find(q(W, "jc"))
        if jc is not None:
            ppr.remove(jc)
    else:
        if ppr.find(q(W, "ind")) is None:
            el(W, "ind", ppr, firstLineChars="200", firstLine="420")
        if ppr.find(q(W, "jc")) is None:
            el(W, "jc", ppr, val="both")
    rpr = ppr.find(q(W, "rPr"))
    if rpr is not None:
        ppr.remove(rpr)
    rpr_body(ppr, east=east, ascii_font=ascii_font, bold=bold)
    clear_runs(p)
    p.append(w_r(text, bold=bold, east=east, ascii_font=ascii_font, hint="eastAsia" if is_heading else None))


def body_p(text: str):
    p = el(W, "p")
    ppr = el(W, "pPr", p)
    el(W, "spacing", ppr, before="120", after="80", line="360", lineRule="auto")
    el(W, "ind", ppr, firstLineChars="200", firstLine="420")
    el(W, "jc", ppr, val="both")
    rpr_body(ppr)
    p.append(w_r(text, hint="eastAsia"))
    return p


def heading_p(text: str, outline: int):
    p = el(W, "p")
    ppr = el(W, "pPr", p)
    el(W, "spacing", ppr, before="120", after="80", line="300", lineRule="auto")
    el(W, "outlineLvl", ppr, val=str(outline))
    rpr_body(ppr, east="黑体", ascii_font="黑体", bold=True)
    p.append(w_r(text, bold=True, east="黑体", ascii_font="黑体", hint="eastAsia"))
    return p


def caption_p(text: str):
    p = el(W, "p")
    ppr = el(W, "pPr", p)
    el(W, "keepNext", ppr)
    el(W, "spacing", ppr, before="160", after="80", line="300", lineRule="auto")
    el(W, "jc", ppr, val="center")
    rpr_body(ppr, sz=21)
    p.append(w_r(text, sz=21, hint="eastAsia"))
    return p


def m_r(text: str, sty="p"):
    r = el(M, "r")
    rpr = el(M, "rPr", r)
    el(M, "sty", rpr, val=sty)
    wrpr = el(W, "rPr", r)
    el(W, "rFonts", wrpr, ascii="Cambria Math", hAnsi="Cambria Math")
    el(W, "lang", wrpr, eastAsia="zh-CN")
    t = el(M, "t", r)
    if text[:1].isspace() or text[-1:].isspace():
        t.set(q(XML, "space"), "preserve")
    t.text = text
    return r


def m_sub(base: str, sub: str):
    node = el(M, "sSub")
    el(M, "sSubPr", node)
    e = el(M, "e", node)
    e.append(m_r(base))
    sb = el(M, "sub", node)
    sb.append(m_r(sub))
    return node


def m_sup(inner, sup: str):
    node = el(M, "sSup")
    el(M, "sSupPr", node)
    e = el(M, "e", node)
    e.append(inner)
    s = el(M, "sup", node)
    s.append(m_r(sup))
    return node


def m_frac(num_nodes, den_nodes):
    node = el(M, "f")
    el(M, "fPr", node)
    num = el(M, "num", node)
    den = el(M, "den", node)
    for n in num_nodes:
        num.append(n)
    for n in den_nodes:
        den.append(n)
    return node


def omath(*children):
    math = el(M, "oMath")
    for c in children:
        math.append(c)
    return math


def formula_table(math_node, number: str):
    tbl = el(W, "tbl")
    tblpr = el(W, "tblPr", tbl)
    el(W, "tblStyle", tblpr, val="aff1")
    el(W, "tblW", tblpr, w="8528", type="dxa")
    el(W, "jc", tblpr, val="center")
    borders = el(W, "tblBorders", tblpr)
    for edge in ("top", "left", "bottom", "right", "insideV"):
        el(W, edge, borders, val="none", sz="0", space="0", color="auto")
    el(W, "tblLook", tblpr, val="04A0", firstRow="1", lastRow="0", firstColumn="1", lastColumn="0", noHBand="0", noVBand="1")
    grid = el(W, "tblGrid", tbl)
    el(W, "gridCol", grid, w="6912")
    el(W, "gridCol", grid, w="1616")
    tr = el(W, "tr", tbl)
    tc1 = el(W, "tc", tr)
    tcpr1 = el(W, "tcPr", tc1)
    el(W, "tcW", tcpr1, w="6912", type="dxa")
    p1 = el(W, "p", tc1)
    ppr1 = el(W, "pPr", p1)
    el(W, "spacing", ppr1, before="120", after="80", line="300", lineRule="auto")
    el(W, "jc", ppr1, val="center")
    rpr_body(ppr1)
    omp = el(M, "oMathPara", p1)
    omp.append(math_node)
    tc2 = el(W, "tc", tr)
    tcpr2 = el(W, "tcPr", tc2)
    el(W, "tcW", tcpr2, w="1616", type="dxa")
    p2 = el(W, "p", tc2)
    ppr2 = el(W, "pPr", p2)
    el(W, "spacing", ppr2, before="120", after="80", line="300", lineRule="auto")
    el(W, "jc", ppr2, val="right")
    rpr_body(ppr2)
    p2.append(w_r(f"（{number}）", hint="eastAsia"))
    return tbl


def three_line_table(headers, rows, col_widths):
    total = sum(col_widths)
    tbl = el(W, "tbl")
    tblpr = el(W, "tblPr", tbl)
    el(W, "tblW", tblpr, w=str(total), type="dxa")
    el(W, "jc", tblpr, val="center")
    borders = el(W, "tblBorders", tblpr)
    el(W, "top", borders, val="single", sz="8", space="0", color="auto")
    el(W, "insideH", borders, val="single", sz="4", space="0", color="auto")
    el(W, "tblLook", tblpr, val="04A0", firstRow="1", lastRow="0", firstColumn="1", lastColumn="0", noHBand="0", noVBand="1")
    grid = el(W, "tblGrid", tbl)
    for wdt in col_widths:
        el(W, "gridCol", grid, w=str(wdt))

    def add_row(values, header=False, last=False):
        tr = el(W, "tr", tbl)
        trpr = el(W, "trPr", tr)
        el(W, "trHeight", trpr, val="320")
        el(W, "cantSplit", trpr)
        el(W, "jc", trpr, val="center")
        if header:
            el(W, "tblHeader", trpr)
        for val, wdt in zip(values, col_widths):
            tc = el(W, "tc", tr)
            tcpr = el(W, "tcPr", tc)
            el(W, "tcW", tcpr, w=str(wdt), type="dxa")
            tcb = el(W, "tcBorders", tcpr)
            if header:
                el(W, "top", tcb, val="single", sz="12", space="0", color="auto")
                el(W, "bottom", tcb, val="single", sz="6", space="0", color="auto")
            elif last:
                el(W, "bottom", tcb, val="single", sz="12", space="0", color="auto")
            el(W, "vAlign", tcpr, val="center")
            p = el(W, "p", tc)
            ppr = el(W, "pPr", p)
            el(W, "spacing", ppr, after="0", line="240", lineRule="auto")
            el(W, "jc", ppr, val="center")
            rpr_body(ppr, bold=header, sz=18)
            p.append(w_r(val, bold=header, sz=18, hint="eastAsia"))

    add_row(headers, header=True)
    for i, row in enumerate(rows):
        add_row(row, last=(i == len(rows) - 1))
    return tbl


def para_text(p) -> str:
    return "".join(n.text or "" for n in p.iter() if n.tag == q(W, "t"))


def find_para(body, needle: str):
    for child in body:
        if child.tag == q(W, "p") and needle in para_text(child):
            return child
    raise SystemExit(f"paragraph not found: {needle}")


def insert_after(body, anchor, nodes):
    idx = list(body).index(anchor)
    for i, node in enumerate(nodes, start=1):
        body.insert(idx + i, node)


def pack_docx(src_dir: Path, dest: Path):
    tmp = dest.with_suffix(".tmp.docx")
    if tmp.exists():
        tmp.unlink()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(src_dir.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(src_dir).as_posix())
    tmp.replace(dest)


def main():
    if not BACKUP.exists():
        shutil.copy2(SRC, BACKUP)

    tree = etree.parse(str(DOC_XML))
    root = tree.getroot()
    body = root.find(q(W, "body"))

    p_led = find_para(body, "常见的CCT-LED")
    set_text(
        p_led,
        "常见的CCT双色温灯珠选用2835封装。本系统LED供电轨定为5 V，而不是ESP32-C3的3.3 V。单芯工作点取正向电压约3.1 V、工作电流20 mA，每芯功耗约0.062 W。3.3 V轨相对3.1 V几乎没有限流压降余量，亮度会失控，因此冷白、暖白两路均由5 V经限流电阻供电，由AO3400低端开关接地。",
    )

    p_ao = find_para(body, "28mΩ")
    set_text(
        p_ao,
        "AO3400为N沟道逻辑电平MOSFET，封装SOT-23。漏源耐压30 V，连续漏极电流约5.8 A。开启门槛电压VGS(th)典型约0.65～1.45 V，小于MCU的3.3 V栅极驱动。数据手册给出RDS(on)约33 mΩ（VGS=4.5 V）和约48 mΩ（VGS=2.5 V）。本设计栅极电压为3.3 V，取RDS(on)=50 mΩ进行损耗核算，不能直接套用10 V或4.5 V条件下的28～32 mΩ。",
    )

    p_path = find_para(body, "供电电源到ESP32C3之间")
    set_text(
        p_path,
        "供电采用Type-C标准5 V。电源路径分为两路：5 V经保险丝后，一路直接供给冷白、暖白LED支路；另一路经LDO降至3.3 V，仅供给ESP32-C3、语音模块和MOS栅极偏置。AO3400的漏极接LED阴极侧，源极接地，栅极由3.3 V PWM驱动。LED大电流不经过LDO。",
    )

    p_vin = find_para(body, "输入电压需要低于耐压")
    set_text(
        p_vin,
        "输入电压须低于LDO最高耐压，且高于3.3 V输出与压差之和。Type-C标称5 V，AMS1117-3.3最高输入约15 V，满足Vin≤Vmax。",
    )

    p_vout = find_para(body, "输出电压Vout可调")
    set_text(
        p_vout,
        "MCU与语音模块均为3.3 V逻辑，输出电压取固定3.3 V即可，不必使用可调版本。选用AMS1117-3.3。",
    )

    p_vd = find_para(body, "压差VD")
    set_text(
        p_vd,
        "USB 5 V相对3.3 V的压差为1.7 V。AMS1117-3.3在百毫安级的压差约1.1 V，小于1.7 V，可以稳定输出。若坚持压差不大于500 mV，可改用ME6211C33等低压差器件，但SOT-23封装散热较差，课程板优先选用SOT-223封装的AMS1117-3.3。",
    )

    p_iout = find_para(body, "输出电流Iout")
    set_text(
        p_iout,
        "LDO输出电流只计算3.3 V负载：Iout=IMCU+IASR。ESP32-C3在蓝牙工作下按150 mA估算，ASRPRO识别峰值按150 mA估算，合计约300 mA。AMS1117-3.3额定1 A，余量足够。LED电流走5 V轨，不得计入Iout。",
    )

    p_iq = find_para(body, "输入电流Iuse")
    set_text(
        p_iq,
        "AMS1117静态电流约5～10 mA，与课程板“待机电流尽量小”的要求相符。输入侧并联10 μF、输出侧并联22 μF电解或钽电容以满足其稳定性要求，并在芯片引脚旁放置100 nF去耦电容。",
    )

    p13 = find_para(body, "1.3 选材（声音识别）")
    # Remove empty trailing paragraphs after 1.3 until sectPr.
    dead = []
    take = False
    for child in list(body):
        if child is p13:
            take = True
            continue
        if not take:
            continue
        if child.tag == q(W, "sectPr"):
            break
        if child.tag == q(W, "p") and not para_text(child).strip():
            dead.append(child)
        else:
            break
    for node in dead:
        body.remove(node)

    extra = []

    extra.append(
        body_p(
            "语音识别模块选用天问Block ASRPRO离线命令词模组。该模组自带麦克风接口和本地识别引擎，无需联网，输出TTL UART，逻辑电平3.3 V，可直接与ESP32-C3的UART1相连。工作电压支持5 V输入（模组内含稳压），识别时峰值电流约70～150 mA，因此其5 V供电从保险丝后的5 V总线引出，3.3 V UART仍与MCU共地。"
        )
    )
    extra.append(
        body_p(
            "命令词按台灯场景预置：开灯、关灯、亮一点、暗一点、最亮、最暗、冷光、暖光、中性光。模组识别成功后通过UART发送固定帧，由ESP32-C3解析并更新亮度B与色温偏向k，再换算为两路PWM占空比。串口建议9600 bps或115200 bps，8N1。接线为：ESP32-C3的GPIO4（U1TXD）接ASRPRO的RX，GPIO5（U1RXD）接ASRPRO的TX，避免占用GPIO20/GPIO21下载串口。"
        )
    )

    extra.append(heading_p("1.4 选材（主控ESP32-C3）", 1))
    extra.append(
        body_p(
            "主控选用ESP32-C3-WROOM-02-N4模组。该模组集成ESP32-C3、4 MB Flash、晶振和板载天线，支持BLE 5.0，满足手机命令端无线控制。内核为32位RISC-V，工作电压3.0～3.6 V，由AMS1117-3.3供电。LEDC外设可同时输出两路10 kHz PWM，分别接到GPIO1（冷白）和GPIO2（暖白）。"
        )
    )
    extra.append(
        body_p(
            "模组典型工作电流在蓝牙广播/连接时约80～150 mA，Wi-Fi不是本项目必需功能，固件中关闭Wi-Fi以降低LDO功耗。EN脚经10 kΩ上拉到3.3 V，并经100 nF到地构成上电复位；IO2、IO8、IO9按模组手册处理启动配置，不作为普通IO。USB接口仅用于下载与调试，台灯正常工作时由Type-C 5 V供电。"
        )
    )

    extra.append(heading_p("1.5 选材（限流电阻、保险丝与配套阻容）", 1))
    extra.append(
        body_p(
            "每颗2835双色温灯珠内部有冷白、暖白两芯，两芯各自串联一只限流电阻后再接到对应MOSFET漏极。灯珠数量取10颗，即冷白、暖白各10芯并联。单芯电流20 mA，单路满载200 mA，两路同时满载400 mA。限流电阻按5 V轨计算："
        )
    )
    extra.append(
        formula_table(
            omath(
                m_r("R="),
                m_frac([m_sub("V", "bus"), m_r("−"), m_sub("V", "F")], [m_sub("I", "F")]),
                m_r("="),
                m_frac([m_r("5−3.1")], [m_r("0.02")]),
                m_r("=95 Ω"),
            ),
            "1-1-3",
        )
    )
    extra.append(
        body_p(
            "实取E24系列100 Ω。电阻功耗为"
        )
    )
    extra.append(
        formula_table(
            omath(
                m_sub("P", "R"),
                m_r("="),
                m_sup(m_sub("I", "F"), "2"),
                m_r("R="),
                m_sup(m_r("0.02"), "2"),
                m_r("×100=0.04 W"),
            ),
            "1-1-4",
        )
    )
    extra.append(
        body_p(
            "0805封装1/8 W电阻即可。冷白、暖白合计20只100 Ω。栅极串联100 Ω抑制振铃，栅极对地10 kΩ下拉，保证上电MOS截止。输入保险丝选用1206封装1 A自恢复PPTC，Type-C插座选用6针母座，CC1、CC2各接5.1 kΩ到地以声明为设备端。5 V与3.3 V总线各放置100 nF与10 μF去耦。"
        )
    )
    extra.append(
        body_p(
            "外置AO3400在VGS=3.3 V、单路200 mA时的导通损耗为"
        )
    )
    extra.append(
        formula_table(
            omath(
                m_sub("P", "mos"),
                m_r("="),
                m_sup(m_sub("I", "LED"), "2"),
                m_sub("R", "DS(on)"),
                m_r("="),
                m_sup(m_r("0.20"), "2"),
                m_r("×0.050=2.0 mW"),
            ),
            "1-1-2",
        )
    )
    extra.append(
        body_p(
            "两路合计约4 mW，无需散热。LDO功耗按3.3 V侧最大电流估算："
        )
    )
    extra.append(
        formula_table(
            omath(
                m_sub("P", "LDO"),
                m_r("="),
                m_r("("),
                m_sub("V", "in"),
                m_r("−"),
                m_sub("V", "out"),
                m_r(")"),
                m_sub("I", "3V3"),
                m_r("=(5−3.3)×0.30=0.51 W"),
            ),
            "1-2-1",
        )
    )
    extra.append(
        body_p(
            "SOT-223封装可将0.51 W热耗散到铜皮，课程板在AMS1117焊盘下铺地铜并打过孔。公式（1-1-1）用于说明若把200 mA直接灌进MCU内部开关，损耗可达数十毫瓦并引起发热；外置AO3400后，MCU GPIO只驱动纳秒级栅极电容，该问题被消除。"
        )
    )

    extra.append(heading_p("1.6 器件选型汇总", 1))
    extra.append(
        body_p(
            "综合电流、电压、封装与采购便利性，本设计主要器件如表2所示。除LED与功率电阻走5 V外，其余逻辑器件统一3.3 V。"
        )
    )
    extra.append(caption_p("表2  主要器件选型清单"))
    extra.append(
        three_line_table(
            ["序号", "名称", "型号规格", "封装", "数量", "选用理由"],
            [
                ["1", "主控模组", "ESP32-C3-WROOM-02-N4", "模组", "1", "BLE+双路LEDC，3.3 V"],
                ["2", "语音模组", "ASRPRO（天问Block）", "模组", "1", "离线命令词，UART 3.3 V"],
                ["3", "双色温LED", "2835 2700 K/6500 K，20 mA", "2835", "10", "冷暖两芯共封装"],
                ["4", "N-MOSFET", "AO3400，VDS=30 V", "SOT-23", "2", "VGS(th)低，3.3 V可驱动"],
                ["5", "LDO", "AMS1117-3.3，1 A", "SOT-223", "1", "5 V转3.3 V，散热好"],
                ["6", "限流电阻", "100 Ω，1/8 W", "0805", "20", "5 V轨单芯20 mA"],
                ["7", "栅极电阻", "100 Ω", "0805", "2", "抑制PWM振铃"],
                ["8", "栅极下拉", "10 kΩ", "0805", "2", "上电MOS截止"],
                ["9", "CC电阻", "5.1 kΩ", "0805", "2", "Type-C设备端识别"],
                ["10", "保险丝", "PPTC 1 A", "1206", "1", "5 V输入过流保护"],
                ["11", "Type-C座", "6P母座", "贴片", "1", "5 V供电/调试"],
                ["12", "输出电容", "22 μF/16 V", "电解或钽", "1", "AMS1117稳定"],
                ["13", "去耦电容", "10 μF、100 nF", "0805", "若干", "5 V/3.3 V去耦"],
            ],
            [700, 1200, 2200, 1100, 700, 2128],
        )
    )
    extra.append(
        body_p(
            "GPIO分配固定为：GPIO1驱动冷白MOS栅极，GPIO2驱动暖白MOS栅极，GPIO4/GPIO5连接ASRPRO串口。两路PWM频率均为10 kHz，只改变占空比Dc、Dw，不改变频率。"
        )
    )

    insert_after(body, p13, extra)

    tree.write(str(DOC_XML), xml_declaration=True, encoding="UTF-8", standalone=True)
    pack_docx(UNPACKED, SRC)
    print("updated", SRC)
    print("backup", BACKUP)


if __name__ == "__main__":
    main()
