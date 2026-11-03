#!/usr/bin/env python3
"""Upload forecast data to the Cloudflare R2 bucket the website reads from.

  python r2_sync.py upload data    # model job: upload the run folders staged in data/ (no index change)
  python r2_sync.py publish data   # publish job: upload data/index.json, then delete runs no longer needed

Needs env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT optional, for tests).

Order matters so visitors never see half-uploaded runs:
  1. model jobs upload new run folders (PNG / isobar JSON first, meta.json last)
  2. the publish job checks every folder in the new index.json is really in the bucket (drops it if not),
     then uploads index.json - only then does the site switch to the new runs
  3. files in folders that are in neither the new nor the previous index.json are deleted
     (the previous folders stay one more refresh, for visitors who still have the old index open)
"""
import json, os, sys, time, mimetypes
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

def run_prefixes(ix):
    """folders referenced by an index.json (the shown folder 'dir' plus all kept folders 'dirs')"""
    out = set()
    for m in (ix or {}).get("models", []):
        for r in m.get("runs", []):
            for d in set(r.get("dirs", [])) | {r.get("dir", r["id"])}:
                out.add(m["path"] + d + "/")
    return out

def put(s3, bucket, key, path):
    ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
    # run files never change once published; meta.json/index.json are re-checked by the site
    cc = "no-cache" if key.endswith(("meta.json", "index.json")) else "public, max-age=86400"
    with open(path, "rb") as f:
        s3.put_object(Bucket=bucket, Key=key, Body=f, ContentType=ctype, CacheControl=cc)

def upload(root):
    bucket = os.environ["R2_BUCKET"]; s3 = client(); t0 = time.time()
    local = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(dp, f); k = os.path.relpath(p, root).replace(os.sep, "/")
            if k != "index.json": local[k] = p
    files = sorted(k for k in local if not k.endswith("meta.json"))
    metas = sorted(k for k in local if k.endswith("meta.json"))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda k: put(s3, bucket, k, local[k]), files))
        list(ex.map(lambda k: put(s3, bucket, k, local[k]), metas))
    size = sum(os.path.getsize(p) for p in local.values())
    print(f"uploaded {len(local)} files ({size / 1e6:.0f} MB) in {time.time() - t0:.0f} s")

def publish(root):
    bucket = os.environ["R2_BUCKET"]; s3 = client(); t0 = time.time()
    remote = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for o in page.get("Contents", []): remote[o["Key"]] = o["Size"]
    try: prev = json.loads(s3.get_object(Bucket=bucket, Key="index.json")["Body"].read())
    except s3.exceptions.NoSuchKey: prev = None
    except Exception as e: print("note: could not read previous index.json:", e); prev = None
    ipath = os.path.join(root, "index.json"); ix = json.load(open(ipath))
    # safety: only publish folders that are complete in the bucket (meta.json is uploaded last)
    for m in ix["models"]:
        ok = [r for r in m["runs"] if m["path"] + r["dir"] + "/meta.json" in remote]
        for r in ok: r["dirs"] = [d for d in r.get("dirs", [r["dir"]]) if m["path"] + d + "/meta.json" in remote]
        if len(ok) < len(m["runs"]):
            print(f"warning: {m['key']}: {len(m['runs']) - len(ok)} run(s) not in the bucket, left out of the index")
        m["runs"] = ok
    ix["models"] = [m for m in ix["models"] if m["runs"]]
    if not ix["models"]: raise SystemExit("no model has any run in the bucket - not publishing")
    ix["runs"] = ix["models"][0]["runs"] if ix["models"][0]["key"] == "ifs" else ix.get("runs", [])
    json.dump(ix, open(ipath, "w"), separators=(",", ":"))
    put(s3, bucket, "index.json", ipath)
    keep = run_prefixes(ix) | run_prefixes(prev)
    stale = [k for k in remote if k != "index.json" and not any(k.startswith(p) for p in keep)]
    for i in range(0, len(stale), 1000):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]], "Quiet": True})
    left = {k: v for k, v in remote.items() if k not in set(stale)}
    print(f"published index.json; deleted {len(stale)} old files ({sum(remote[k] for k in stale) / 1e6:.0f} MB)")
    for m in ix["models"]:
        cur = sum(v for k, v in left.items() if any(k.startswith(m["path"] + d + "/") for r in m["runs"] for d in r["dirs"]))
        allm = sum(v for k, v in left.items() if k.startswith(m["path"]))
        print(f"  {m['key']}: {len(m['runs'])} runs, {cur / 1e6:.0f} MB in use, {allm / 1e6:.0f} MB stored incl. previous")
    print(f"R2 bucket now {sum(left.values()) / 1e9:.2f} GB in {len(left)} files; publish took {time.time() - t0:.0f} s")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    root = sys.argv[2] if len(sys.argv) > 2 else "data"
    if mode == "upload": upload(root)
    elif mode == "publish": publish(root)
    else: raise SystemExit(__doc__)
