import sys,re
from pypdf import PdfReader
r=PdfReader(sys.argv[1]); tags=[]; cont=0; contzh=0
for pg in r.pages:
    t=pg.extract_text() or ''; zh=sum(1 for ch in t if '\u4e00'<=ch<='\u9fff')
    if re.search(r'第 \d+ 页(左栏|右栏)?（续）',t): tags.append(f'续{zh}'); cont+=1; contzh+=zh
    elif re.search(r'\d+ 左栏',t): tags.append(f'左{zh}')
    elif re.search(r'\d+ 右栏',t): tags.append(f'右{zh}')
    else: tags.append(f'整{zh}')
print(len(r.pages),'张：',' '.join(tags)); print('续页',cont,'张，续页中文',contzh,'字')
