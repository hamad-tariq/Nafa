"""Fund-price emails -> history in SQL -> metrics and insights. Used by app.py."""
import base64, email, functools, imaplib, io, json, logging, os, re, time
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from email import policy
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen

from dotenv import load_dotenv

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")  # local secrets; on Vercel they come from the project's environment variables
SENDER = os.getenv("MI_SENDER") or "newsletters@almeezangroup.com"
# The email's footnote: money market and fixed income returns are annualized, other categories absolute.
# Pension money-market/debt sub-funds and fixed-term Munafa plans quote yearly rates too.
# ponytail: name-based; add an explicit fund->basis table if a fund lands in the wrong bucket.
ANNUALIZED = re.compile(r"money|mmkt|\(mm\)|mmsf|cash|income|debt|sukuk|fixed|saving|munafa|circular", re.I)
COLS = ["fund", "date", "category", "launch", "seq", "nav", "repurchase", "offer", "mtd", "fytd", "cytd", "fy", "si"]
log = logging.getLogger("core")


@functools.cache
def db():
    """Postgres on Vercel (DATABASE_URL, e.g. Neon from the Vercel Marketplace), SQLite file locally."""
    url = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL")
    if not url and os.getenv("VERCEL"):
        raise RuntimeError("DATABASE_URL is not set: add a Postgres database to the Vercel project")
    url = url or f"sqlite:///{ROOT / 'data' / 'funds.db'}"
    if url.startswith("sqlite:///"):
        Path(url[len("sqlite:///"):]).parent.mkdir(parents=True, exist_ok=True)
    pg = not url.startswith("sqlite")
    eng = create_engine(re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", url),
                        poolclass=NullPool if pg else None)  # serverless: no pool held between requests
    with eng.begin() as c:
        c.execute(text("""create table if not exists nav (fund text, date text, category text, launch text,
            seq integer, nav double precision, repurchase double precision, offer double precision,
            mtd double precision, fytd double precision, cytd double precision, fy text, si double precision,
            primary key (fund, date))"""))
        c.execute(text("create table if not exists emails (id text primary key, received text, subject text, rows integer)"))
        c.execute(text("create table if not exists snapshot (id text primary key, data text, updated text)"))
    return eng


# ---------- parsing: email HTML (or an image transcribed by Claude) -> grid of cell strings -> records

class Row(list):
    style = ""  # the <tr>'s style/bgcolor: tells category headings apart from sub-headings


class _Grid(HTMLParser):
    """Every <tr> in document order as a list of cell texts. Nested tables get their own rows."""
    def __init__(self):
        super().__init__()
        self.rows, self.open = [], []  # open: current row at each table nesting level

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.open.append(None)
        elif not self.open:
            return
        elif tag == "tr":
            a = dict(attrs)
            self.open[-1] = Row()
            self.open[-1].style = f"{a.get('style') or ''}{a.get('bgcolor') or ''}".replace(" ", "").lower()
            self.rows.append(self.open[-1])
        elif tag in ("td", "th") and self.open[-1] is not None:
            self.open[-1].append("")
        elif tag == "br":
            self.handle_data(" ")

    def handle_endtag(self, tag):
        if tag == "table" and self.open:
            self.open.pop()

    def handle_data(self, data):
        if self.open and self.open[-1]:
            self.open[-1][-1] += data


def _clean(cell):
    cell = " ".join(cell.split())
    # the emails contain a literal U+FFFD where a curly apostrophe or dash was: "SECP?s", "MGSF ? Plan"
    return re.sub(r"(?<=\w)\ufffd(?=\w)", "\u2019", cell).replace("\ufffd", "\u2013")


def html_grid(html):
    p = _Grid()
    p.feed(html)
    rows = []
    for r in p.rows:
        rows.append(Row(_clean(c) for c in r))
        rows[-1].style = r.style
    return rows


def _num(s):
    s = re.sub(r"[^\d.()-]", "", s or "")  # drops %, commas, "Rs." and footnote marks like 54.8644*
    try:
        v = float(s.strip("() "))
    except ValueError:
        return None
    return -v if s.startswith("(") else v  # accounting style: (1.23%) is negative


def _date(s):
    for f in ("%d %b %Y", "%b %d, %Y", "%d-%b-%Y", "%d-%b-%y", "%d %B %Y", "%B %d, %Y", "%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime((s or "").strip(), f).date().isoformat()
        except ValueError:
            pass


def _fy(key):
    m = re.fullmatch(r"fy(\d{2})|(?:fy)?(\d{4})", key)
    return m and (m[2] or "20" + m[1])


def records(grid):
    """Grid -> one dict per fund row. A row with only its first cell filled is a heading: the first
    heading's look marks categories (purple "Equity Funds"); headings that look different are fund
    families inside a category (grey "Meezan Tahaffuz Pension Fund")."""
    out, cols, cat, family, top = [], None, None, None, None
    for r in grid:
        keys = [re.sub(r"\W", "", c.split()[0]).lower() if c else "" for c in r]
        if "nav" in keys and "mtd" in keys:  # header row: Funds, Launch Date, ..., NAV, MTD, ...
            cols = keys
            continue
        if not cols or not any(r):
            continue
        if r[0] and not any(r[1:]):
            style = getattr(r, "style", "")
            top = style if top is None else top
            if style == top:
                cat, family = r[0], None
            else:
                family = r[0]
            continue
        d = dict(zip(cols, r))
        # funds with a front-end load leave NAV blank; their repurchase price is the NAV
        nav, day = _num(d.get("nav")) or _num(d.get("repurchase")), _date(d.get("validity"))
        if nav is None or day is None:
            continue
        name = re.sub(r"[*^#\s]+$", "", r[0])
        if family and name.lower().endswith("sub fund"):  # "Equity Sub Fund" alone doesn't say whose
            name = f"{family} ({name})"
        out.append(dict(
            fund=name, category=cat or "Other", date=day, seq=len(out),
            launch=_date(d.get("launch")), nav=nav, repurchase=_num(d.get("repurchase")),
            offer=_num(d.get("offer")), mtd=_num(d.get("mtd")), fytd=_num(d.get("fytd")),
            cytd=_num(d.get("cytd")), si=_num(d.get("since")),
            # year columns ("2026" or "FY26") are full fiscal-year returns
            fy=json.dumps({_fy(k): _num(v) for k, v in d.items() if _fy(k)}),
        ))
    return out


VISION_PROMPT = """These images are consecutive slices (slightly overlapping) of one fund prices table.
Transcribe it top to bottom as rows of cell strings exactly as printed: keep % signs and dates as shown,
use "" for blank cells, and write each table row only once even if it appears in two slices.
Include the column header row (Funds, Launch Date, Validity Date, Repurchase, Offer, NAV, MTD, ...).
Section heading rows (e.g. "Money Market Fund") are a single cell. Skip banners and footnotes."""


def vision_grid(images):
    """Fallback for image-only emails and screenshots: Claude transcribes the table into a grid."""
    import anthropic
    from PIL import Image

    content = []
    for b in images:
        im = Image.open(io.BytesIO(b)).convert("RGB")
        w, h = im.size
        step = int(w * 1.2)  # the API downscales tall images until digits blur, so send ~square slices
        for y in range(0, h, step - 60):  # 60px overlap so no row is only half visible
            buf = io.BytesIO()
            im.crop((0, y, w, min(h, y + step))).save(buf, "PNG")
            content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                        "data": base64.standard_b64encode(buf.getvalue()).decode()}})
            if y + step >= h:
                break
    schema = {"type": "object", "additionalProperties": False, "required": ["rows"],
              "properties": {"rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}}}
    resp = anthropic.Anthropic().beta.messages.create(
        model="claude-opus-5-5", max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": schema}},
        messages=[{"role": "user", "content": content + [{"type": "text", "text": VISION_PROMPT}]}],
    )
    if resp.stop_reason != "end_turn":
        raise RuntimeError(f"table transcription stopped early: {resp.stop_reason}")
    return json.loads(next(b.text for b in resp.content if b.type == "text"))["rows"]


def email_images(msg, html):
    imgs = [p.get_content() for p in msg.walk() if p.get_content_maintype() == "image"]
    if not imgs:  # newsletters usually link images instead of attaching them
        for url in re.findall(r'<img[^>]+src="(https?://[^"]+)"', html, re.I):
            with urlopen(url, timeout=30) as r:
                b = r.read()
            if len(b) > 20_000:  # skip logos and tracking pixels
                imgs.append(b)
    return imgs


UPSERT = text(f"insert into nav ({', '.join(COLS)}) values ({', '.join(':' + c for c in COLS)}) "
              f"on conflict (fund, date) do update set {', '.join(f'{c} = excluded.{c}' for c in COLS[2:])}")


def store(c, recs):
    if recs:
        c.execute(UPSERT, recs)
    return len(recs)


def ingest_msg(c, msg):
    part = msg.get_body(("html",))
    html = part.get_content() if part else ""
    recs = records(html_grid(html))
    if not recs:
        imgs = email_images(msg, html)
        recs = records(vision_grid(imgs)) if imgs else []
    return store(c, recs)


def ingest_upload(eng, body, content_type):
    """A saved .eml, the email's HTML, or a screenshot of the table."""
    with eng.begin() as c:
        if content_type.startswith("image/"):
            n = store(c, records(vision_grid([body])))
        elif content_type.startswith("text/html"):
            n = store(c, records(html_grid(body.decode("utf-8", "replace"))))
        else:
            n = ingest_msg(c, email.message_from_bytes(body, policy=policy.default))
    rebuild(eng)
    return n


def read_inbox(eng, budget):
    """Import new price emails over IMAP, oldest first. Stops after `budget` seconds; the next call
    picks up where this one stopped. Emails are opened read-only and never marked as read."""
    deadline = time.monotonic() + budget
    with eng.connect() as c:
        last = c.execute(text("select max(received) from emails")).scalar()
    crit = ["FROM", f'"{SENDER}"', "SUBJECT", '"Fund Prices"']
    if last:  # the first run has no SINCE, so it imports every past email still in the mailbox
        crit += ["SINCE", (datetime.fromisoformat(last) - timedelta(days=2)).strftime("%d-%b-%Y")]
    added, failed = 0, []
    with imaplib.IMAP4_SSL(os.getenv("MI_IMAP_HOST") or "imap.gmail.com") as m:
        m.login(os.environ["MI_EMAIL"], os.environ["MI_APP_PASSWORD"])
        m.select(f'"{os.getenv("MI_IMAP_FOLDER") or "INBOX"}"', readonly=True)
        ids = m.search(None, *crit)[1][0].split()
        for n, i in enumerate(ids):
            if time.monotonic() > deadline:
                return {"added": added, "failed": failed, "left": len(ids) - n}
            msg = email.message_from_bytes(m.fetch(i, "(BODY.PEEK[])")[1][0][1], policy=policy.default)
            mid = msg["Message-ID"] or f"{msg['Date']}|{msg['Subject']}"
            try:
                with eng.begin() as c:
                    if c.execute(text("select 1 from emails where id = :id"), {"id": mid}).first():
                        continue
                    rows = ingest_msg(c, msg)
                    c.execute(text("insert into emails values (:id, :received, :subject, :rows)"), {
                        "id": mid, "subject": str(msg["Subject"]), "rows": rows,
                        "received": parsedate_to_datetime(msg["Date"]).astimezone(timezone.utc).isoformat()})
                added += 1
            except Exception as e:  # left unrecorded, so the next run retries it
                log.exception("failed on %s", msg["Subject"])
                failed.append(f"{msg['Subject']}: {e}")
    return {"added": added, "failed": failed, "left": 0}


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def sync(eng, budget=240, cooldown=600):
    """Check the inbox unless a check is running or one finished less than `cooldown` seconds ago
    (anyone may trigger it, so this is the rate limit). State lives in snapshot row 'sync':
    `updated` is the earliest time the next check may start, `data` the last result."""
    now = datetime.now(timezone.utc)
    with eng.begin() as c:
        c.execute(text("insert into snapshot (id, data, updated) values ('sync', '{}', '') on conflict (id) do nothing"))
        prev = json.loads(c.execute(text("select data from snapshot where id = 'sync'")).scalar() or "{}")
        got = c.execute(text("update snapshot set updated = :lock, data = :data where id = 'sync' and updated <= :now"), {
            "lock": _iso(now + timedelta(seconds=budget + 60)), "now": _iso(now),
            "data": json.dumps({**prev, "running": True, "started": _iso(now)})}).rowcount
    if not got:
        return status(eng)
    result = {"added": 0, "failed": [], "left": 0, "error": None}
    try:
        if os.getenv("MI_EMAIL") and os.getenv("MI_APP_PASSWORD"):
            result.update(read_inbox(eng, budget))
        else:
            result["error"] = ("No inbox configured: set MI_EMAIL and MI_APP_PASSWORD (.env locally, "
                               "Environment Variables on Vercel), then restart the server.")
    except imaplib.IMAP4.error as e:
        result["error"] = f"Gmail rejected the sign-in ({e}). Check MI_EMAIL and use an app password, not your Gmail password."
    except OSError as e:
        result["error"] = f"Couldn't reach the mail server: {e}"
    except Exception as e:
        log.exception("sync failed")
        result["error"] = str(e)
    if result["error"] or result["failed"]:  # the page only says "didn't finish"; the details are for the owner's logs
        log.warning("price update: %s %s", result["error"] or "", "; ".join(result["failed"]))
    if result["added"]:
        rebuild(eng)
    done = datetime.now(timezone.utc)
    wait = 0 if result["left"] else 60 if result["error"] else cooldown  # no wait while backfilling
    with eng.begin() as c:
        c.execute(text("update snapshot set updated = :next, data = :data where id = 'sync'"), {
            "next": _iso(done + timedelta(seconds=wait)),
            "data": json.dumps({**result, "running": False, "checked": _iso(done)})})
    return status(eng)


def status(eng):
    with eng.connect() as c:
        times = dict(c.execute(text("select id, updated from snapshot")).all())
        state = json.loads(c.execute(text("select data from snapshot where id = 'sync'")).scalar() or "{}")
        emails = c.execute(text("select count(*) from emails")).scalar()
    return {"configured": bool(os.getenv("MI_EMAIL") and os.getenv("MI_APP_PASSWORD")),
            # a run that crashed never clears `running`, but its lock time passes
            "running": bool(state.get("running")) and times.get("sync", "") > _iso(datetime.now(timezone.utc)),
            "checked": state.get("checked"), "added": state.get("added", 0), "left": state.get("left", 0),
            "failed": state.get("failed", []), "error": state.get("error"), "emails": emails,
            "next_check": times.get("sync") or None, "version": times.get("summary")}


# ---------- analysis

def total_return(g, ann):
    """Total-return index rebuilt from the reported FYTD returns, so dividend payouts (which drop
    the NAV) don't show up as losses. g = one fund's rows sorted by date."""
    fy = g.date.dt.year + (g.date.dt.month >= 7)  # Pakistan FY: FY2027 = Jul 2026 - Jun 2027
    r = g.fytd / 100
    if ann:  # annualized yield -> return actually earned so far this FY (simple annualization)
        start = pd.to_datetime((fy - 1).astype(str) + "-06-30")
        start = start.where(~(g.launch > start), g.launch)
        r = r * (g.date - start).dt.days / 365
    full = r.groupby(fy).last().to_dict()  # each FY's return: last FYTD we saw in it...
    if not ann:  # ...or better, the full-year figure the email reports once the year closes
        for s in g.fy.dropna():
            full.update({int(y): v / 100 for y, v in json.loads(s).items() if v is not None and int(y) in full})
    start_of, base = {}, 1.0
    for y in sorted(full):
        start_of[y], base = base, base * (1 + full[y])
    return fy.map(start_of) * (1 + r)


def _despike(s):
    """Drop one-day glitches in the emailed returns: a big move that fully reverses at the next price."""
    if len(s) < 3:
        return s
    r = np.log(s).diff()
    spike = (r.abs() > 5 * r.abs().median()) & (r * r.shift(-1) < 0) & ((r + r.shift(-1)).abs() < 0.3 * r.abs())
    return s[~spike]


def _r(v, n=2):
    return None if v is None or pd.isna(v) else round(float(v), n)


EMPTY = {"asof": None, "fy": [], "funds": [], "history": {}, "insights": {"active": [], "new": []}}


def _key(name):
    s = name.casefold().replace("paidaar", "paidar").replace("money market", "mm").replace("mmsf", "mm")
    return " ".join(re.sub(r"\b(meezan|fund|plan|units|sub)\b|[^a-z0-9 ]", " ", s).split())


def aliases(df):
    """The AMC renames funds between email templates ("Paidaar Munafa Plan-34" -> "Paidar Munafa Plan 34",
    "(MTPF-Money Market sub Fund)" -> "(MM)"), sometimes runs both templates side by side, and even changes
    launch dates. Two names are one fund when plan numbers match, the names are alike, and the NAV runs on
    continuously from one name to the other.
    The more recent name wins. Returns name -> display name."""
    navs = {n: g.set_index("date").nav.sort_index() for n, g in df.groupby("fund")}
    spans = df.groupby("fund").agg(start=("date", "min"), end=("date", "max"))
    nums = lambda n: set(re.findall(r"\d+|\b[ivx]+\b", _key(n)))
    pairs = []
    for old, a in spans.iterrows():
        for new, b in spans.iterrows():
            score = SequenceMatcher(None, _key(old), _key(new)).ratio()
            if (a.end, a.start) >= (b.end, b.start) or nums(old) != nums(new) or score < 0.5:
                continue
            # the two names' prices, each carried forward, compared where they first meet
            both = pd.concat([navs[old].rename("a"), navs[new].rename("b")], axis=1).sort_index().ffill().dropna()
            if len(both) and (both.b / both.a - 1).abs().head(5).median() < 0.02:
                pairs.append((score, old, new))
    nxt = {}
    for _, old, new in sorted(pairs, reverse=True):  # best matches first, one successor per name
        if old not in nxt and new not in nxt.values():
            nxt[old] = new
    final = {}
    for n in spans.index:
        final[n] = n
        while final[n] in nxt:
            final[n] = nxt[final[n]]
    display = {}
    for n, f in final.items():  # "MFPF-AGGRESSIVE ALLOCATION PLAN" reads better as its older "MFPF-Aggressive Allocation Plan"
        if f.isupper() and n.casefold() == f.casefold() and not n.isupper():
            display[f] = n
    return {n: display.get(f, f) for n, f in final.items()}


def analyze(c):
    df = pd.read_sql(text("select * from nav"), c, parse_dates=["date", "launch"])
    if df.empty:
        return dict(EMPTY)
    df["fund"] = df.fund.map(aliases(df))
    df = df.sort_values(["date", "seq"]).drop_duplicates(["fund", "date"], keep="last")
    asof = df.date.max()
    latest = df[df.date == asof]
    fy_labels = sorted({k for s in latest.fy.dropna() for k in json.loads(s)}, reverse=True)[:2]
    rows, history = [], {}
    for fund, g in df.sort_values("date").groupby("fund"):
        last = g.iloc[-1]
        if last.date < asof - pd.Timedelta(days=10):
            continue  # matured or discontinued: no longer priced
        # a NAV that creeps up ~0.03% a day is a cash-like fund quoting yearly rates, whatever its name
        ann = bool(ANNUALIZED.search(f"{last.category} {fund}")) or (len(g) >= 5 and g.nav.pct_change().abs().median() < 0.0005)
        s = total_return(g, ann) if g.fytd.notna().any() else g.nav
        s = _despike(pd.Series(s.values, index=g.date).dropna())
        span = (s.index[-1] - s.index[0]).days if len(s) else 0

        def trailing(days):
            base = s[s.index <= s.index[-1] - pd.Timedelta(days=days - 3)]
            if base.empty:
                return None
            ret = s.iloc[-1] / base.iloc[-1] - 1
            return 100 * (ret * 365 / days if ann else ret)

        vol = mdd = dd = None
        if not ann and len(s) >= 2:
            under = s / s.cummax() - 1
            mdd, dd = 100 * under.min(), 100 * under.iloc[-1]
        if not ann and len(s) >= 10:
            d = s.index.values.astype("datetime64[D]")
            gaps = np.maximum(np.busday_count(d[:-1], d[1:]), 1)  # prices only move on trading days
            vol = 100 * np.std(np.diff(np.log(s.values)) / np.sqrt(gaps), ddof=1) * np.sqrt(252)
        age = (last.date - last.launch).days / 365.25 if pd.notna(last.launch) else None
        cagr = last.si if ann else ((1 + last.si / 100) ** (1 / age) - 1) * 100 if age and age >= 1 and pd.notna(last.si) else None
        fy = json.loads(last.fy or "{}")
        for y in fy:  # "0.00%" for a year the fund didn't exist yet isn't a real return
            if pd.notna(last.launch) and last.launch > pd.Timestamp(f"{y}-06-30"):
                fy[y] = None
        prev = g.date.iloc[-2].strftime("%Y-%m-%d") if len(g) > 1 else None
        rows.append(dict(
            fund=fund, category=last.category, seq=last.seq, ann=ann, date=last.date.strftime("%Y-%m-%d"),
            prev_date=prev, launch=last.launch.strftime("%Y-%m-%d") if pd.notna(last.launch) else None,
            age=_r(age, 1), nav=_r(last.nav, 4), move=_r(100 * (s.iloc[-1] / s.iloc[-2] - 1) if len(s) > 1 else None, 2),
            mtd=_r(last.mtd), fytd=_r(last.fytd), cytd=_r(last.cytd), si=_r(last.si), cagr=_r(cagr),
            fy0=_r(fy.get(fy_labels[0])) if fy_labels else None,
            fy1=_r(fy.get(fy_labels[1])) if len(fy_labels) > 1 else None,
            r1m=_r(trailing(30)), r3m=_r(trailing(91)), r1y=_r(trailing(365)),
            vol=_r(vol), max_dd=_r(mdd), dd=_r(dd), at_high=bool(not ann and span >= 30 and dd == 0),
            entry_load=_r(100 * (last.offer / last.nav - 1)) if pd.notna(last.offer) else None,
            exit_load=_r(100 * (1 - last.repurchase / last.nav)) if pd.notna(last.repurchase) else None,
        ))
        history[fund] = [[d.strftime("%Y-%m-%d"), round(float(v), 6)] for d, v in s.items()]
    F = pd.DataFrame(rows).sort_values("seq")  # email order
    num = F.columns.difference(["fund", "category", "date", "prev_date", "launch", "ann", "at_high"])
    F[num] = F[num].astype(float)  # all-None columns would otherwise stay object and break comparisons
    # peers share a category and a return basis: a cash-like plan inside Fund of Funds isn't ranked
    # against plans quoting absolute returns
    mixed = F.groupby("category").ann.transform("nunique") > 1
    F["peer"] = F.category.where(~mixed, F.category + np.where(F.ann, " (per year)", " (market-linked)"))
    F["rank"] = F.groupby("peer").fytd.rank(ascending=False, method="min")
    F["n_cat"] = F.groupby("peer").fund.transform("size")
    funds = [{k: (None if isinstance(v, float) and np.isnan(v) else v) for k, v in r.items() if k != "seq"}
             for r in F.to_dict("records")]
    return {"asof": asof.strftime("%Y-%m-%d"), "since": df.date.min().strftime("%Y-%m-%d"),
            "dates": int(df.date.nunique()), "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "fy": fy_labels, "funds": funds, "history": history, "insights": insights(F, fy_labels)}


def insights(F, fy_labels):
    act, new = [], []
    mk = F[~F.ann]  # market-linked funds (absolute returns)
    m = mk.dropna(subset=["move"]).sort_values("move")
    if len(m) > 1:
        act.append(f"{(m.move > 0).sum()} of {len(m)} market-linked funds rose since the previous price. "
                   f"Best: {m.fund.iloc[-1]} ({m.move.iloc[-1]:+.2f}%); worst: {m.fund.iloc[0]} ({m.move.iloc[0]:+.2f}%).")
    if mk.at_high.any():
        act.append("At a record high (total return, within tracked history): " + ", ".join(mk[mk.at_high].fund) + ".")
    for r in mk[mk.dd <= -10].sort_values("dd").itertuples():
        act.append(f"{r.fund} is {-r.dd:.1f}% below its tracked peak (FYTD {r.fytd:+.2f}%).")
    c = F[F.ann].dropna(subset=["mtd", "fytd"])
    if len(c):
        trend = "rising" if (c.mtd - c.fytd).mean() > 0 else "easing"
        act.append(f"Cash and income fund yields are {trend}: this month averages {c.mtd.mean():.2f}% "
                   f"vs {c.fytd.mean():.2f}% so far this fiscal year (annualized).")

    cols = ["fytd"] + [k for k in ("fy0", "fy1") if F[k].notna().any()]
    top_half = (F.groupby("peer")[cols].rank(pct=True, ascending=False) <= 0.5).all(axis=1)
    cons = F[top_half & (F.n_cat >= 3)]
    if len(cons) and len(cols) > 1:
        years = " and ".join("FY" + fy_labels[int(k[-1])] for k in cols[1:])
        new.append(f"Consistent: top half of their category this year and in {years}: " + ", ".join(cons.fund) + ".")
    lr = F[~F.ann & (F.age >= 5)].dropna(subset=["cagr"]).sort_values("cagr", ascending=False).head(3)
    if len(lr):
        new.append("Strongest long-run records (5+ years, annualized since launch): "
                   + "; ".join(f"{r.fund} {r.cagr:.1f}%" for r in lr.itertuples()) + ".")
    cash = F[F.ann & F.category.str.contains("money", case=False)].dropna(subset=["mtd"]).sort_values("mtd")
    if len(cash):
        r = cash.iloc[-1]
        new.append(f"Parking cash short-term: {r.fund} pays the highest money-market yield this month "
                   f"({r.mtd:.2f}% annualized)" + (", with no entry load." if not r.entry_load > 0 else "."))
    ld = F[F.entry_load >= 1]
    if len(ld):
        new.append(f"{len(ld)} funds charge an entry load, up to {ld.entry_load.max():.1f}% "
                   f"({ld.fund[ld.entry_load.idxmax()]}). That comes off your money before any return.")
    return {"active": act, "new": new}


SAVE = text("insert into snapshot (id, data, updated) values (:id, :data, :updated) "
            "on conflict (id) do update set data = excluded.data, updated = excluded.updated")


def rebuild(eng):
    """Recompute everything once per data change; the API then serves the stored JSON as-is."""
    with eng.begin() as c:
        data = analyze(c)
        history = data.pop("history")
        now = datetime.now(timezone.utc).isoformat()
        c.execute(SAVE, [{"id": "summary", "data": json.dumps(data), "updated": now},
                         {"id": "history", "data": json.dumps(history), "updated": now}])
    return data


def snapshot(eng, key):
    with eng.connect() as c:
        return c.execute(text("select data from snapshot where id = :id"), {"id": key}).scalar()
