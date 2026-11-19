#!/usr/bin/env python3
"""Pack real FlyWire data as FLYBRAIN/1, preserving uint64 IDs and every edge row.
Feather conversion is vectorized in bounded batches. Requires numpy and pyarrow.
Supports CSV(.gz) edge/neuron inputs and explicit or opt-in proxy sensorimotor maps.
"""
import argparse,csv,gzip,hashlib,json,math,mmap,os,pathlib,struct,tempfile,zlib
from collections import Counter
import numpy as np
NT=['gaba','ach','glut','oct','ser','da']
SIGNS={'GABA':-1,'ACH':1,'GLUT':-1,'OCT':0,'SER':0,'DA':0,'UNKNOWN':0,'':0,
       'ACETYLCHOLINE':1,'GLUTAMATE':-1,'DOPAMINE':0,'SEROTONIN':0,'OCTOPAMINE':0}
EDGE=np.dtype([('pre','<u4'),('post','<u4'),('weight','<f4'),('delay','u1')])
MAP=np.dtype([('id','<u4'),('channel','<u2'),('motor','u1'),('reserved','u1'),('gain','<f4'),('motor_gain','<f4')])

def sha(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  while data:=f.read(4<<20):h.update(data)
 return h.hexdigest()
def textrows(path):
 op=gzip.open if str(path).endswith('.gz') else open
 with op(path,'rt',encoding='utf-8-sig',newline='') as f:
  yield from csv.DictReader(f,delimiter='\t' if '.tsv' in str(path) else ',')
def pick(r,*keys,default=None):
 for k in keys:
  if r.get(k) is not None and str(r[k]).strip()!='':return r[k]
 return default
def integer(v):
 if isinstance(v,(float,bool)) or not str(v).strip().isdigit():raise ValueError(f'Exact unsigned integer required: {v!r}')
 return int(str(v).strip())
def ids_from(path):
 if str(path).endswith('.npy'):
  ids=np.load(path,allow_pickle=False)
  if ids.ndim!=1 or ids.dtype.kind not in 'iu':raise ValueError('Neuron NPY must be a 1D integer array')
  if np.any(ids<=0):raise ValueError('IDs must be positive')
  ids=ids.astype('<u8')
 else:ids=np.asarray([integer(pick(r,'root_id','id','neuron_id')) for r in textrows(path)],dtype='<u8')
 ids=np.sort(ids)
 if not 1<=len(ids)<=250000 or ids[0]==0 or np.any(ids[1:]<=ids[:-1]):raise ValueError('Neuron IDs must be nonempty, unique positive uint64 integers')
 return ids

def mappings(args,ids):
 index={int(r):i for i,r in enumerate(ids)};out=[];summary={}
 if args.mapping:
  for r in textrows(args.mapping):
   rid=integer(pick(r,'root_id','neuron_id'))
   if rid not in index:raise ValueError(f'Mapping ID missing from snapshot: {rid}')
   ch=int(r.get('channel') or 0);mo=int(r.get('motor') or 0);g=float(r.get('input_gain') or 0);mg=float(r.get('motor_gain') or 0)
   if not 0<=ch<=64 or not 0<=mo<=6 or not math.isfinite(g) or not math.isfinite(mg) or abs(g)>100 or abs(mg)>100:raise ValueError('Invalid mapping row')
   out.append((index[rid],ch,mo,0,g,mg))
 elif args.proxy_annotations:
  groups={k:[] for k in ['vision_left','vision_right','auditory','dn_left','dn_right','dn_mid']}
  for r in textrows(args.proxy_annotations):
   rid=integer(pick(r,'root_id','neuron_id'))
   if rid not in index:continue
   cell=str(pick(r,'cell_type','type',default=''));cls=str(pick(r,'cell_class','class',default='')).lower();sc=str(pick(r,'super_class','superclass',default='')).lower();side=str(pick(r,'side','hemisphere',default='')).lower()
   if cell in ('R1','R2','R3','R4','R5','R6','R7','R8') or cls=='photoreceptor' or (sc=='sensory' and cls=='visual'):
    if side in ('left','l'):groups['vision_left'].append(rid)
    elif side in ('right','r'):groups['vision_right'].append(rid)
   elif str(pick(r,'cell_sub_class',default='')).lower()=='auditory' or cls=='auditory':groups['auditory'].append(rid)
   elif sc=='descending' or cls=='descending':groups['dn_left' if side in ('left','l') else 'dn_right' if side in ('right','r') else 'dn_mid'].append(rid)
  for name,values in groups.items():
   values=sorted(set(values));summary[name]=len(values)
   for j,rid in enumerate(values):
    if name.startswith('vision'):out.append((index[rid],1+(0 if name.endswith('left') else 24)+j%24,0,0,3.,0.))
    elif name=='auditory':out.append((index[rid],49+j%8,0,0,4.,0.))
    else:
     out.append((index[rid],0,1,0,0.,1.))
     if name!='dn_mid':out.append((index[rid],0,2 if name=='dn_left' else 3,0,0.,1.))
  if not out:raise ValueError('No recognized annotations; supply an explicit mapping profile')
 if len(out)>1000000:raise ValueError('Too many mappings')
 return np.array(sorted(out),dtype=MAP),summary

def edge_batches(path,default_delay,signs):
 if str(path).endswith('.feather'):
  import pyarrow as pa
  with pa.memory_map(str(path),'r') as src:
   r=pa.ipc.open_file(src)
   for i in range(r.num_record_batches):
    b=r.get_batch(i)
    # Slice oversized record batches rather than materializing the whole table.
    for start in range(0,len(b),65536):
     bb=b.slice(start,min(65536,len(b)-start))
     pre=bb['pre_pt_root_id'].to_numpy();post=bb['post_pt_root_id'].to_numpy();count=bb['syn_count'].to_numpy()
     probs=np.column_stack([bb[k+'_avg'].cast(pa.float64()).fill_null(0).to_numpy(zero_copy_only=False) for k in NT])
     if not np.isfinite(probs).all() or np.any(probs<0) or np.any(probs>1):raise ValueError('Invalid neurotransmitter probability')
     kinds=np.argmax(probs,axis=1);kinds[np.max(probs,axis=1)==0]=6
     s=np.array([signs[k.upper()] for k in NT]+[signs['UNKNOWN']])[kinds]
     yield pre,post,count,s,np.full(len(bb),default_delay,dtype=np.uint8),kinds
 else:
  block=[]
  for row in textrows(path):
   block.append(row)
   if len(block)==65536:yield csv_batch(block,default_delay,signs);block=[]
  if block:yield csv_batch(block,default_delay,signs)
def csv_batch(rows,delay,signs):
 pre=[];post=[];count=[];sg=[];ds=[];ks=[]
 for r in rows:
  pre.append(integer(pick(r,'pre_pt_root_id','pre_root_id','pre')));post.append(integer(pick(r,'post_pt_root_id','post_root_id','post')));count.append(integer(pick(r,'syn_count','synapse_count','weight')))
  nt=str(pick(r,'nt_type','neurotransmitter',default='')).strip().upper()
  if not nt:
   probs=[float(pick(r,k+'_avg',k,default=0)) for k in NT]
   if any(not math.isfinite(x) or x<0 or x>1 for x in probs):raise ValueError('Invalid NT probability')
   nt=NT[max(range(6),key=probs.__getitem__)].upper() if max(probs)>0 else 'UNKNOWN'
  sg.append(signs.get(nt,0));ks.append(NT.index(nt.lower()) if nt.lower() in NT else 6);ds.append(int(pick(r,'delay_ms',default=delay)))
 return np.asarray(pre,dtype='<u8'),np.asarray(post,dtype='<u8'),np.asarray(count,dtype=np.int64),np.asarray(sg),np.asarray(ds,dtype=np.int64),np.asarray(ks)

def convert(args):
 ids=ids_from(args.neurons);n=len(ids)
 if args.expected_neurons and n!=args.expected_neurons:raise ValueError(f'Expected {args.expected_neurons}, found {n}')
 if args.mapping and args.proxy_annotations:raise ValueError('Choose explicit mappings or proxies, not both')
 maps,summary=mappings(args,ids);signs=dict(SIGNS)
 if args.nt_signs:
  signs.update({k.upper():float(v) for k,v in json.loads(pathlib.Path(args.nt_signs).read_text()).items()})
  if any(not math.isfinite(v) or abs(v)>1 for v in signs.values()):raise ValueError('Signs must be finite in [-1,1]')
 output=pathlib.Path(args.output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
 degree=np.zeros(n,dtype=np.uint32);stats=Counter();nt_counts=Counter();nt_syn=Counter();e=0
 with tempfile.TemporaryDirectory(prefix='fly-convert-',dir=output.parent) as temp:
  spool=pathlib.Path(temp)/'edges.tmp'
  with spool.open('wb') as f:
   for pre,post,cnt,sign,delay,kinds in edge_batches(args.connections,args.delay_ms,signs):
    if pre.dtype.kind not in 'iu' or post.dtype.kind not in 'iu' or np.any(pre<=0) or np.any(post<=0):raise ValueError('Endpoints must be positive integer IDs')
    pre=pre.astype('<u8',copy=False);post=post.astype('<u8',copy=False)
    if np.any(cnt<1) or np.any(delay<1) or np.any(delay>15):raise ValueError('Invalid count or delay')
    a=np.searchsorted(ids,pre);b=np.searchsorted(ids,post);valid=(a<n)&(b<n)
    valid &= ids[np.minimum(a,n-1)]==pre;valid &= ids[np.minimum(b,n-1)]==post
    if not valid.all():
     if not args.allow_outside:raise ValueError('Edge endpoint missing from proofread neuron list')
     stats['outside_rows_skipped']+=int((~valid).sum());a=a[valid];b=b[valid];cnt=cnt[valid];sign=sign[valid];delay=delay[valid];kinds=kinds[valid]
    weight=cnt*args.weight_scale*sign
    if not np.isfinite(weight).all() or np.any(abs(weight)>100):raise ValueError('Weight exceeds [-100,100]; lower --weight-scale. No silent clipping.')
    rec=np.empty(len(a),dtype=EDGE);rec['pre']=a;rec['post']=b;rec['weight']=weight;rec['delay']=delay;rec.tofile(f)
    degree+=np.bincount(a,minlength=n).astype(np.uint32);e+=len(a);stats['synapses']+=int(cnt.sum());stats['zero_effect_edges']+=int((sign==0).sum())
    for k,name in enumerate(NT+['UNKNOWN']):
     mask=kinds==k;nt_counts[name.upper()]+=int(mask.sum());nt_syn[name.upper()]+=int(cnt[mask].sum())
    if e>32000000:raise ValueError('Too many edge rows')
   print('Read',e,'edge rows;',stats['synapses'],'synapses',flush=True)
  row=np.zeros(n+1,dtype='<u4');row[1:]=np.cumsum(degree,dtype=np.uint32)
  off={'ids':128,'rows':128+n*8};off['targets']=off['rows']+(n+1)*4;off['weights']=off['targets']+e*4;off['delays']=off['weights']+e*4;off['maps']=(off['delays']+e+3)&~3;off['metadata']=off['maps']+len(maps)*16
  meta={'format':'FLYBRAIN/1','graph_kind':'external_user_supplied','dataset':args.dataset,'neurons':n,'edges':e,'synapse_count':stats['synapses'],'mappings':len(maps),'mapping_mode':'explicit_user_profile' if args.mapping else 'uncalibrated_annotation_proxy' if args.proxy_annotations else 'none','proxy_summary':summary,'stats':dict(stats),'nt_edge_counts':dict(nt_counts),'nt_synapse_counts':dict(nt_syn),'sign_policy':signs,'weight_scale':args.weight_scale,'default_delay_ms':args.delay_ms,'tau_mem_ms':args.tau_mem,'tau_syn_ms':args.tau_syn,'threshold':args.threshold,'refractory_ms':args.refractory,'synapse_gain':args.synapse_gain,'input_gain':args.input_gain,'audio_gain':args.audio_gain,
        'source_sha256':{'neurons':sha(args.neurons),'connections':sha(args.connections)},'mapping_sha256':sha(args.mapping) if args.mapping else None,'annotation_sha256':sha(args.proxy_annotations) if args.proxy_annotations else None,
        'assumptions':['Dimensionless common LIF parameters, fixed 1-ms integration','Signed current impulses derived from counts and dominant per-edge neurotransmitter prediction','GABA and glutamate inhibitory; ACh excitatory; receptor-specific effects unknown','DA/SER/OCT/unknown connections retained with zero current effect unless overridden','All edge rows preserved, including parallel neuropil edges; no synapse-count threshold','Retinal channels assigned by sorted ID within each side; not measured retinotopy','Auditory frequency assignment and descending-neuron body readout are uncalibrated proxies','Synapse gain 4 and input gain 3 were selected for software response, not biological fitting','No VNC, muscles, calibrated antenna, plasticity or validated whole-animal behavior']}
  metadata=json.dumps(meta,ensure_ascii=False,sort_keys=True).encode();total=off['metadata']+len(metadata)
  if total>440*1024*1024:raise ValueError('Output too large')
  path=pathlib.Path(temp)/'output.flybrain'
  with path.open('w+b') as f:
   f.truncate(total)
   with mmap.mmap(f.fileno(),total) as mm:
    mm[:8]=b'FLYBRAIN'
    for o,v in {8:1,12:0x01020304,16:n,20:e,24:len(maps),28:1,32:total,40:off['ids'],44:off['rows'],48:off['targets'],52:off['weights'],56:off['delays'],60:off['maps'],76:args.refractory,80:len(metadata),88:off['metadata']}.items():struct.pack_into('<I',mm,o,v)
    for o,v in [(64,args.tau_mem),(68,args.tau_syn),(72,args.threshold),(92,args.synapse_gain),(96,args.input_gain),(100,args.audio_gain)]:struct.pack_into('<f',mm,o,v)
    mm[off['ids']:off['rows']]=ids.astype('<u8').tobytes();mm[off['rows']:off['targets']]=row.tobytes();mm[off['maps']:off['metadata']]=maps.tobytes();mm[off['metadata']:]=metadata
    targets=np.ndarray((e,),dtype='<u4',buffer=mm,offset=off['targets']);weights=np.ndarray((e,),dtype='<f4',buffer=mm,offset=off['weights']);delays=np.ndarray((e,),dtype='u1',buffer=mm,offset=off['delays']);cursor=row[:-1].copy()
    with spool.open('rb') as ef:
     while True:
      rec=np.fromfile(ef,dtype=EDGE,count=262144)
      if not len(rec):break
      order=np.argsort(rec['pre'],kind='stable');rr=rec[order];a=rr['pre'];starts=np.r_[0,1+np.flatnonzero(a[1:]!=a[:-1])];groups=a[starts];counts=np.diff(np.r_[starts,len(a)])
      rank=np.arange(len(a))-np.repeat(starts,counts);positions=cursor[a].astype(np.int64)+rank
      targets[positions]=rr['post'];weights[positions]=rr['weight'];delays[positions]=rr['delay'];cursor[groups]+=counts.astype(np.uint32)
    assert np.array_equal(cursor,row[1:]);del targets,weights,delays
    crc=0
    for start in range(128,total,4<<20):crc=zlib.crc32(mm[start:min(start+(4<<20),total)],crc)
    struct.pack_into('<I',mm,36,crc);mm.flush()
  os.replace(path,output)
 meta.update(output_bytes=total,output_sha256=sha(output));pathlib.Path(str(output)+'.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding='utf-8')
 with pathlib.Path(str(output)+'.mapping.csv').open('w',newline='') as f:
  w=csv.writer(f);w.writerow(['root_id','channel','motor','input_gain','motor_gain'])
  for r in maps:w.writerow([int(ids[r['id']]),int(r['channel']),int(r['motor']),float(r['gain']),float(r['motor_gain'])])
 print(json.dumps({k:meta[k] for k in ['neurons','edges','synapse_count','mappings','output_bytes','output_sha256']},indent=2));return meta

def parser():
 p=argparse.ArgumentParser(description=__doc__)
 for k in ['neurons','connections','output']:p.add_argument('--'+k,required=True)
 p.add_argument('--mapping');p.add_argument('--proxy-annotations');p.add_argument('--nt-signs');p.add_argument('--allow-outside',action='store_true');p.add_argument('--dataset',default='FlyWire user-supplied snapshot');p.add_argument('--expected-neurons',type=int,default=0)
 for name,default,typ in [('weight-scale',.02,float),('delay-ms',1,int),('tau-mem',20.,float),('tau-syn',5.,float),('threshold',1.,float),('refractory',2,int),('synapse-gain',1.,float),('input-gain',1.,float),('audio-gain',1.,float)]:p.add_argument('--'+name,type=typ,default=default)
 return p
if __name__=='__main__':
 args=parser().parse_args()
 if not(math.isfinite(args.weight_scale) and 0<args.weight_scale<=100 and 1<=args.delay_ms<=15 and 2<=args.tau_mem<=1000 and 1<=args.tau_syn<=1000 and .01<=args.threshold<=100 and 0<=args.refractory<=50 and 0<args.synapse_gain<=4 and 0<args.input_gain<=8 and 0<args.audio_gain<=8):raise SystemExit('Invalid model parameters')
 convert(args)
