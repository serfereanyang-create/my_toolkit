from docx import Document
from pathlib import Path
from lxml import etree

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
d = Document(str(p))

para = d.paragraphs[26]
print("=== children structure ===")
for child in para._p:
    tag = etree.QName(child).localname
    txt = "".join(n.text or "" for n in child.iter() if n.tag.endswith("}t"))
    print(f"  <{tag}> {txt[:80]!r}")

print()
print("=== full XML (tail 2000) ===")
x = etree.tostring(para._p, pretty_print=True).decode()
print(x[-2000:])
