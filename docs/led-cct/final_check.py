import re
import zipfile
from html import unescape
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
z = zipfile.ZipFile(p)
xml = z.read("word/document.xml").decode("utf-8")
z.close()

tbls = re.findall(r"<w:tbl>.*?</w:tbl>", xml, re.S)
print("tables:", len(tbls))
for i, t in enumerate(tbls):
    tops = len(re.findall(r'<w:top w:val="single"', t))
    bots = len(re.findall(r'<w:bottom w:val="single"', t))
    has_math = "<m:oMath" in t
    print(f"  T{i}: topRules={tops} bottomRules={bots} hasMath={has_math}")

print()
maths = re.findall(r"<m:oMath\b.*?</m:oMath>", xml, re.S)
print("total formulas:", len(maths))
for i, m in enumerate(maths):
    txt = "".join(unescape(x) for x in re.findall(r"<m:t[^>]*>(.*?)</m:t>", m, re.S))
    kinds = []
    if "<m:f>" in m:
        kinds.append("FRAC")
    if "<m:sSup>" in m:
        kinds.append("SUP")
    if "<m:sSub>" in m:
        kinds.append("SUB")
    print(f"  #{i:02d} [{'+'.join(kinds) or 'plain'}] {txt!r}")
