#!/usr/bin/env python3
"""Upload the built forecast data (data/) to the Cloudflare R2 bucket the website reads from.

  python r2_sync.py data

Needs env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT optional, for tests).

Order matters so visitors never see half-uploaded runs:
  1. new or changed run files (PNG / isobar JSON / meta.json); unchanged files are skipped (MD5 = R2 ETag)
  2. index.json last - only then does the site switch to the new runs
  3. delete files of runs that are in neither the new nor the previous index.json
     (the previous runs stay one more refresh, for visitors who still have the old index open)
"""
import hashlib, json, os, sys, time, mimetypes
from concurrent.futures import ThreadPoolExecutor
import boto3
from botocore.config import Config

def client():
    ep = os.environ.get("R2_ENDPOINT") or f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return boto3.client("s3", endpoint_url=ep, region_name="auto",
                        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                        config=Config(retries={"max_attempts": 8, "mode": "standard"}, max_pool_connections=32,
                                      request_checksum_calculation="when_required",
                                      response_checksum_validation="when_required"))

def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

def run_prefixes(ix):
    """folders referenced by an index.json"""
    out = set()
    if not ix: return out
    for m in ix.get("models", []):
        for r in m.get("runs", []):
            out.add(m["path"] + r.get("dir", r["id"]) + "/")
    return out

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "data"
    bucket = os.environ["R2_BUCKET"]; s3 = client(); t0 = time.time()
    remote = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for o in page.get("Contents", []): remote[o["Key"]] = o["ETag"].strip('"')
    try: prev = json.loads(s3.get_object(Bucket=bucket, Key="index.json")["Body"].read())
    except s3.exceptions.NoSuchKey: prev = None
    except Exception as e: print("note: could not read previous index.json:", e); prev = None
    local = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f); local[os.path.relpath(p, root).replace(os.sep, "/")] = p
    todo = [k for k in local if k != "index.json" and remote.get(k) != md5(local[k])]
    def put(k):
        ctype = mimetypes.guess_type(k)[0] or "application/octet-stream"
        # run folders never change once published; meta.json/index.json are always re-checked by the site
        cc = "no-cache" if k.endswith(("meta.json", "index.json")) else "public, max-age=86400"
        with open(local[k], "rb") as f:
            s3.put_object(Bucket=bucket, Key=k, Body=f, ContentType=ctype, CacheControl=cc)
    files = sorted((k for k in todo if not k.endswith("meta.json")))
    metas = sorted((k for k in todo if k.endswith("meta.json")))
    size = sum(os.path.getsize(local[k]) for k in todo)
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(put, files)); list(ex.map(put, metas))
    put("index.json")
    print(f"uploaded {len(todo) + 1} files ({size / 1e6:.0f} MB), skipped {len(local) - len(todo) - 1} unchanged")
    keep = run_prefixes(json.load(open(local["index.json"]))) | run_prefixes(prev)
    stale = [k for k in remote if k not in local and not any(k.startswith(p) for p in keep)]
    for i in range(0, len(stale), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]], "Quiet": True})
    total = sum(os.path.getsize(p) for p in local.values())
    print(f"deleted {len(stale)} old files; kept previous runs: {len(run_prefixes(prev) - run_prefixes(json.load(open(local['index.json']))))} folders")
    print(f"R2 sync done in {time.time() - t0:.0f} s; current data {total / 1e6:.0f} MB in {len(local)} files")

if __name__ == "__main__":
    main()
