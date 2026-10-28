"""Locate paragraphs containing the P_loss leftovers and show math content."""
from docx import Document
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
d = Document(str(p))

for i, para in enumerate(d.paragraphs):
    txt = ''.join(n.text or '' for n in para._p.iter() if n.tag.endswith('}t'))
    maths = [
        ''.join(x.text or '' for x in m.iter() if x.tag.endswith('}t'))
        for m in para._p.iter()
        if m.tag.endswith('}oMath')
    ]
    if maths or 'Ploss' in txt or 'RDS' in txt:
        print(f"P{i:03d} txt={txt.strip()[:120]!r}")
        print(f"       math={maths}")
