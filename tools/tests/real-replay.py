import json, re, urllib.parse
RZ=json.load(open('/home/claude/realzh.json'));_pos=[0]
def zh_for(t):
    t=t.strip()
    if t in RZ['exact']: return RZ['exact'][t].replace('\n',' ')
    n=max(2,int(len(t)*0.29)); P=RZ['pool']; i=_pos[0]%len(P); _pos[0]+=n
    return (P[i:]+P)[:n].replace('\n',' ')
from playwright.sync_api import sync_playwright
FILES={'/Users/x/papers/real10.pdf':'/home/claude/real10.pdf','/Users/x/papers/real1.pdf':'/home/claude/real1.pdf','/Users/x/papers/paper2col.pdf':'/home/claude/paper2col.pdf','/Users/x/Zotero/storage/AB12/book11.pdf':'/home/claude/book11.pdf','/Users/x/papers/devcities.pdf':'/home/claude/devcities.pdf'}
saved={}; calls={'merge':0,'trans':0}
MOCK="""
window.__inv=[];window.__ev={};
window.__TAURI__={
 fs:{readFile:async function(p){var r=await fetch('/__file?p='+encodeURIComponent(p));if(!r.ok)throw new Error('没有文件');return new Uint8Array(await r.arrayBuffer())},
     writeFile:async function(p,b){await fetch('/__save?p='+encodeURIComponent(p),{method:'POST',body:b})},mkdir:async function(){}},
 path:{appDataDir:async function(){return '/Users/x/Library/Application Support/com.xiaohu.pdfyi/'}},
 core:{invoke:async function(c,a){window.__inv.push({cmd:c,args:JSON.parse(JSON.stringify(a||{}))});if(c==='zotero_attach')return JSON.stringify({ok:true});if(c==='take_jobs'){var j=window.__pending||[];window.__pending=[];return j}return null}},
 dialog:{open:async function(){return []}},
 event:{listen:async function(n,cb){(window.__ev[n]=window.__ev[n]||[]).push(cb)}},
 deepLink:{getCurrent:async function(){return []},onOpenUrl:function(cb){window.__dl=cb}},
 notification:{isPermissionGranted:async function(){return true},requestPermission:async function(){},sendNotification:function(n){window.__inv.push({cmd:'notify',args:n})}}
};"""
def route(r):
    u=r.request.url
    if '/__file?' in u:
        p=urllib.parse.parse_qs(urllib.parse.urlparse(u).query)['p'][0]; return r.fulfill(path=FILES[p],content_type='application/pdf') if p in FILES else r.fulfill(status=404,body='')
    if '/__save?' in u:
        p=urllib.parse.parse_qs(urllib.parse.urlparse(u).query)['p'][0]; saved[p]=r.request.post_data_buffer; return r.fulfill(status=200,body='ok')
    if u.startswith('http://127.0.0.1:3427'): return r.continue_()
    if u.startswith('http://127.0.0.1:3426'):
        if u.endswith('/models'): return r.fulfill(json={'data':[{'id':'x'}]})
        p=json.loads(r.request.post_data)['messages'][-1]['content']
        if 'You are looking at a book' in p: c=json.dumps({'chapters':[{'title':'Ch','start':1}]})
        elif 'group consecutive lines' in p:
            calls['merge']+=1
            nums=re.findall(r'^\[(\d+)\] (.*)$',p,re.M); groups=[[int(n) for n,_ in nums]]   # 最坏情况：模型把整页合成一段
            c=json.dumps(groups)
        else:
            calls['trans']+=1; c='\n'.join(f'[{n}] '+zh_for(t) for n,t in re.findall(r'^\[(\d+)\] (.*)$',p,re.M))
        return r.fulfill(json={'choices':[{'message':{'content':c},'finish_reason':'stop'}]})
    return r.abort()
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(viewport={'width':1400,'height':900})
    pg=ctx.new_page(); pg.route('**/*',route); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.add_init_script(MOCK)
    pg.goto('http://127.0.0.1:3427/worker.html'); pg.wait_for_timeout(800)
    pg.evaluate("window.__pending=['file:'+(window.__REALDOC||'/Users/x/papers/real10.pdf')];window.__ev['pdfyi-job'].forEach(function(cb){cb({})})")
    for i in range(120):
        pg.wait_for_timeout(500)
        st=pg.evaluate('PDFYI_WORKER.state()')
        if not st['job'] and not st['queue'] and len(saved)>=1: break
    inv=pg.evaluate('window.__inv')
    print('后台引擎：等了约',(i+1)/2,'秒 | 合并请求',calls['merge'],'次，翻译请求',calls['trans'],'次 | 页面错误',errs)
    print('  交回 Zotero：',[x['args']['body'] for x in inv if x['cmd']=='zotero_attach'])
    print('  写出的文件：',list(saved.keys()))
    print('  通知：',[x['args'] for x in inv if x['cmd']=='notify'])
    ups=[x['args']['state'] for x in inv if x['cmd']=='tray_update']
    print('  菜单栏更新',len(ups),'次，带图',sum(1 for u in ups if u.get('image')),'次，两行字（去重前 8 个）：',[u['lines'] for u in ups][:1]+list({json.dumps(u['lines'],ensure_ascii=False):1 for u in ups}.keys())[:8])
    wtexts=pg.evaluate("(function(){return null})()")
    for p,bts in saved.items(): open('/home/claude/wk_'+p.split('/')[-1],'wb').write(bts)
    pg.close()
    b.close()
