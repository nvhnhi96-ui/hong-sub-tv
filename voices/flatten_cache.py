"""Turn the Hugging Face cache into plain files (no symlinks), so the zip unpacks on any Windows PC."""
import os, shutil, sys
root = sys.argv[1]
n = 0
for dp, dn, fn in os.walk(root):
    for f in fn:
        p = os.path.join(dp, f)
        if os.path.islink(p):
            t = os.path.realpath(p)
            os.unlink(p)
            shutil.copy2(t, p)
            n += 1
for dp, dn, fn in list(os.walk(root)):
    if os.path.basename(dp) == 'blobs' and os.path.isdir(dp):
        shutil.rmtree(dp)
print('copied', n, 'linked files')
