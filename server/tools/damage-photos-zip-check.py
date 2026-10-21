"""Verify browser ZIP output with the independent standard-library reader."""
from pathlib import Path
import json
import zipfile

OUT=Path(__file__).resolve().parents[1]/'test-artifacts/damage-photos-20261001/candidate'
results=[]
for filename,count in [('unit-photos.zip',5),('browser-photos.zip',3),('unicode.zip',1)]:
    with zipfile.ZipFile(OUT/filename) as archive:
        names=archive.namelist()
        assert len(names)==count and len(set(names))==count
        assert archive.testzip() is None
        assert all('/' not in name and '\\' not in name for name in names)
        if filename=='browser-photos.zip':
            assert names[:2]==['IT00571_line-007_UNI-PISAS-COP-SAFARI_photo-01.png','IT00571_line-007_UNI-PISAS-COP-SAFARI_photo-02.png']
            assert 'report-uncertain-report' in names[2]
            assert all(archive.read(name).startswith(bytes.fromhex('89504e47')) for name in names)
        if filename=='unicode.zip':
            assert '损坏砖' in names[0]
            assert archive.read(names[0])==bytes([0,1,2,3,255])
        results.append({'file':filename,'entries':len(names),'crc':'pass','names':names})
(OUT/'zip-reader.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'standardZipReader':'pass','archives':len(results),'images':sum(r['entries'] for r in results)}))
