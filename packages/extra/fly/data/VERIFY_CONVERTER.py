import importlib.util,pathlib,tempfile,struct,zlib
import numpy as np,pyarrow as pa,pyarrow.feather as feather
root=pathlib.Path(__file__).resolve().parent
sp=importlib.util.spec_from_file_location('fly_convert',root/'convert_flywire.py');c=importlib.util.module_from_spec(sp);sp.loader.exec_module(c)
with tempfile.TemporaryDirectory() as td:
 p=pathlib.Path(td);ids=np.array([720575940600000001,720575940600000003,720575940600000007],dtype=np.int64);np.save(p/'neurons.npy',ids)
 # Signed Arrow IDs only two units apart expose accidental float64 promotion.
 t=pa.table({'pre_pt_root_id':[int(ids[1]),int(ids[0]),int(ids[0])],'post_pt_root_id':[int(ids[2]),int(ids[1]),int(ids[1])],'syn_count':[9,25,4],
 'gaba_avg':[1.,None,0.],'ach_avg':[None,1.,1.],'glut_avg':[None,None,None],'oct_avg':[0.,0.,0.],'ser_avg':[0.,0.,0.],'da_avg':[0.,0.,0.]})
 feather.write_feather(t,p/'edges.feather')
 a=c.parser().parse_args(['--neurons',str(p/'neurons.npy'),'--connections',str(p/'edges.feather'),'--output',str(p/'out.flybrain'),'--weight-scale','.2']);m=c.convert(a);b=(p/'out.flybrain').read_bytes()
 assert struct.unpack_from('<QQQ',b,128)==tuple(map(int,ids));o=struct.unpack_from('<I',b,48)[0];assert struct.unpack_from('<III',b,o)==(1,1,2)
 o=struct.unpack_from('<I',b,52)[0];assert np.allclose(struct.unpack_from('<fff',b,o),(5.,.8,-1.8))
 assert m['synapse_count']==38 and m['edges']==3;assert zlib.crc32(b[128:])==struct.unpack_from('<I',b,36)[0]
 print('PASS: exact uint64 ID lookup, nullable NT probabilities, signed weights, stable CSR order, parallel edges, full synapse counts, CRC')
