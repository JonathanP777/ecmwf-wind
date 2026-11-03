# Encode GeoJSON lines as {"s":scale,"l":[[x0,y0,dx,dy,...],...]} (delta-encoded integer lon/lat). Used by build_lines.sh.
import json,sys
src,dst,scale=sys.argv[1],sys.argv[2],int(sys.argv[3])
g=json.load(open(src))
geoms=[f['geometry'] for f in g['features']] if 'features' in g else g['geometries']
lines=[]
for gm in geoms:
    if not gm: continue
    cs=[gm['coordinates']] if gm['type']=='LineString' else gm['coordinates'] if gm['type']=='MultiLineString' else []
    for c in cs:
        pts=[(round(x*scale),round(y*scale)) for x,y in c]
        dd=[pts[0]]
        for p in pts[1:]:
            if p!=dd[-1]: dd.append(p)
        if len(dd)<2: continue
        out=[dd[0][0],dd[0][1]]
        for a,b in zip(dd,dd[1:]): out+= [b[0]-a[0],b[1]-a[1]]
        lines.append(out)
json.dump({"s":scale,"l":lines},open(dst,'w'),separators=(',',':'))
import os,gzip
print(dst,len(lines),os.path.getsize(dst),len(gzip.compress(open(dst,'rb').read())))
