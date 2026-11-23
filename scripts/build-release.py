#!/usr/bin/env python3
"""Deterministic source ZIP; no dependencies, runtime databases or credentials."""
import argparse,hashlib,json,pathlib,subprocess,zipfile,re
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--output',type=pathlib.Path,required=True);args=p.parse_args()
version=json.loads((ROOT/'package.json').read_text())['version']
exclude={'.git','node_modules','data','demo-data','security-ledger','__pycache__','release'}
try:
 result=subprocess.run(['git','ls-files','-z'],cwd=ROOT,check=True,capture_output=True)
 names=result.stdout.decode().split('\0');names=[x for x in names if x]
except (OSError,subprocess.CalledProcessError):
 names=[str(x.relative_to(ROOT)) for x in ROOT.rglob('*') if x.is_file()]
names=sorted(n for n in names if not exclude.intersection(pathlib.PurePosixPath(n).parts) and n!='RELEASE_FILES.sha256')
for n in names:
 if pathlib.PurePosixPath(n).name in {'.env','db.json','secret.txt','session-revocations.json','session-revocations.pre-ledger.json','security-ledger-binding.json','support-grants.json','key.json','events.jsonl','head.json','writer.lock','layout.json','initialization.json','security-ledger-binding.json.enrollment'} or re.match(r'^(?:archive-|snapshot-|journal-)',pathlib.PurePosixPath(n).name) or (ROOT/n).is_symlink():raise SystemExit('Refusing runtime/secret/symlink path: '+n)
files={n:(ROOT/n).read_bytes() for n in names}
manifest=''.join(hashlib.sha256(b).hexdigest()+'  '+n+'\n' for n,b in files.items()).encode()
files['RELEASE_FILES.sha256']=manifest
output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 z.comment=('GuildHub '+version+' release candidate; independent audit required').encode()
 for n in sorted(files):
  info=zipfile.ZipInfo(n,(2026,11,14,0,0,0));info.create_system=3;info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED
  z.writestr(info,files[n],compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
sha=hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(sha+'  '+output.name+'\n')
inventory={'version':version,'baselineZipSha256':'0288e997fdd6bc458fb178d121d21021b930c171c39883147b8fe4ecc6ec8ef2','sourceManifestSha256':hashlib.sha256(manifest).hexdigest(),'zipSha256':sha,'files':[{'path':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in sorted(files.items())]}
output.with_suffix('.inventory.json').write_text(json.dumps(inventory,indent=2)+'\n')
print(json.dumps({'archive':str(output),'sha256':sha,'files':len(files),'bytes':output.stat().st_size}))
