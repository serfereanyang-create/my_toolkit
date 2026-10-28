import re, zipfile
from pathlib import Path

p = Path(r"C:\Users\34516\Desktop\水课\led声控.docx")
z = zipfile.ZipFile(p)
xml = z.read("word/document.xml").decode("utf-8")
z.close()

i = xml.find("Ploss")
while i != -1:
    seg = xml[i - 100:i + 100]
    print("--- occurrence at", i, "---")
    print(seg)
    print()
    i = xml.find("Ploss", i + 1)
