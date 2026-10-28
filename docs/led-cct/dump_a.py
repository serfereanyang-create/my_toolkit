import re, zipfile
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
z = zipfile.ZipFile(p)
xml = z.read("word/document.xml").decode("utf-8")
z.close()

paras = re.findall(r"<w:p [^>]*>.*?</w:p>|<w:p>.*?</w:p>", xml, re.S)
print("paras found:", len(paras))
for i, para in enumerate(paras):
    txt = "".join(re.findall(r"<[wm]:t[^>]*>(.*?)</[wm]:t>", para, re.S))
    if "Ploss" in para and "RDS" in para:
        print("=" * 20, "P026-ish idx", i, "=" * 20)
        print(para[-2500:])
