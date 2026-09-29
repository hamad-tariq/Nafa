import hashlib, hmac, json, os, secrets, time
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

import core

# No Swagger, ReDoc or OpenAPI schema: the few endpoints exist only for this app's own page.
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
PAGE = (core.ROOT / "page.html").read_text(encoding="utf-8")
FRESH = {"Cache-Control": "no-store"}
TOKEN_TTL = 6 * 3600


def _sign(exp):
    key = hashlib.sha256(b"page-token:" + os.getenv("CRON_SECRET", "").encode()).digest()
    return hmac.new(key, exp.encode(), "sha256").hexdigest()


def from_page(request):
    """Allow only calls made by this site's own page: browsers mark them Sec-Fetch-Site: same-origin (scripts on
    other sites can't fake that), and they carry the signed token the page was served with. Anything else gets
    a 404, so the endpoint looks like it doesn't exist. A determined visitor can still copy the token from the
    page, but that gives them nothing the page doesn't already show."""
    exp, _, sig = request.headers.get("x-board", "").partition(".")
    if not (os.getenv("CRON_SECRET") and request.headers.get("sec-fetch-site") == "same-origin"
            and exp.isdigit() and int(exp) > time.time() and hmac.compare_digest(sig, _sign(exp))):
        raise HTTPException(404)


def owner(authorization):  # Vercel Cron and the owner's uploads send "Authorization: Bearer <CRON_SECRET>"
    secret = os.getenv("CRON_SECRET")
    return bool(secret) and secrets.compare_digest(authorization or "", f"Bearer {secret}")


def public(st):
    """Update status without anything that says where prices come from; details stay in the server logs."""
    problem = "setup" if not st["configured"] else "failed" if st["error"] else None
    return {"updating": st["running"], "checked": st["checked"], "done": st["emails"], "left": st["left"],
            "next_check": st["next_check"], "version": st["version"], "problem": problem}


def json_response(data):
    return Response(json.dumps(data), media_type="application/json", headers=FRESH)


@app.get("/", response_class=HTMLResponse)
def page():
    """The dashboard, with all prices and history inside it, so there's no data API to call."""
    eng = core.db()
    empty = json.dumps({k: v for k, v in core.EMPTY.items() if k != "history"})
    data = '{"summary":%s,"history":%s,"version":%s}' % (
        core.snapshot(eng, "summary") or empty, core.snapshot(eng, "history") or "{}", json.dumps(core.status(eng)["version"]))
    exp = str(int(time.time()) + TOKEN_TTL)
    html = PAGE.replace("__TOKEN__", f"{exp}.{_sign(exp)}").replace("__DATA__", data.replace("<", "\\u003c"))
    return HTMLResponse(html, headers={"Cache-Control": "public, s-maxage=60, stale-while-revalidate=600"})


@app.get("/api/status")
def status(request: Request):
    from_page(request)
    return json_response(public(core.status(core.db())))


@app.api_route("/api/refresh", methods=["GET", "POST"])
def refresh(request: Request, authorization: Annotated[str | None, Header()] = None):
    """Look for new prices; runs at most once every 10 minutes. The page POSTs in ~25 second steps so it can show
    progress; Vercel Cron GETs with the CRON_SECRET and a longer budget."""
    if owner(authorization):
        return json_response(public(core.sync(core.db(), budget=240)))
    from_page(request)
    return json_response(public(core.sync(core.db(), budget=25)))


@app.post("/api/ingest")
async def ingest(request: Request, authorization: Annotated[str | None, Header()] = None):
    """Owner only: add a saved message (message/rfc822), its HTML (text/html) or a screenshot (image/png, image/jpeg)."""
    if not owner(authorization):
        raise HTTPException(404)
    body = await request.body()
    n = await run_in_threadpool(core.ingest_upload, core.db(), body, request.headers.get("content-type", ""))
    return {"funds": n}


app.mount("/assets", StaticFiles(directory=core.ROOT / "web"), name="assets")
