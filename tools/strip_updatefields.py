# -*- coding: utf-8 -*-
"""删掉 word/settings.xml 里的 <w:updateFields>，避免每次打开弹"更新域"提示。
直接改 zip，不经过 python-docx 重新序列化，避免动到 TOC 域结构。"""
import shutil
import sys
import zipfile

DOCX = r"C:\Users\34516\Desktop\心情.docx"

TARGET = "word/settings.xml"

with zipfile.ZipFile(DOCX, "r") as z:
    names = z.namelist()
    data = {n: z.read(n) for n in names}

xml = data[TARGET].decode("utf-8")

had = "updateFields" in xml
# 自闭合与带内容两种形态都处理
import re

xml2 = re.sub(r"<w:updateFields\b[^>]*/>", "", xml)
xml2 = re.sub(r"<w:updateFields\b[^>]*>.*?</w:updateFields>", "", xml2)

if xml2 != xml:
    data[TARGET] = xml2.encode("utf-8")
    tmp = DOCX + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for n in names:
            out.writestr(n, data[n])
    shutil.move(tmp, DOCX)
    print("updateFields present before:", had)
    print("removed: yes")
else:
    print("updateFields present before:", had)
    print("removed: no (nothing matched)")
print("toc field still in document.xml:",
      b'TOC \\o' in data["word/document.xml"] or b"TOC" in data["word/document.xml"])
