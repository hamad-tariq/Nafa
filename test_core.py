"""python test_core.py -- parser, metrics and API self-check on an email-shaped HTML fixture."""
import json, os, re, tempfile

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/test.db"
os.environ.update(CRON_SECRET="s3cret", MI_EMAIL="", MI_APP_PASSWORD="")  # blank beats the real .env: no Gmail in tests
from fastapi.testclient import TestClient
import app, core

EMAIL = """<html><body><table width="100%"><tr><td><img src="banner.jpg">
<table border="1">
<tr><td colspan="6"></td><td colspan="6"><b>RETURNS ^</b></td></tr>
<tr><th>Funds</th><th>Launch<br>Date</th><th>Validity<br>Date</th><th>Repurchase</th><th>Offer</th><th>NAV</th>
    <th>MTD</th><th>FYTD</th><th>CYTD</th><th>2026</th><th>2025</th><th>Since<br>Inception</th></tr>
<tr><td>Money Market Fund</td><td colspan="11"></td></tr>
<tr><td>Meezan Cash Fund</td><td>15 Jun<br>2009</td><td>{day}</td><td></td><td>&nbsp;</td><td>52.8760</td>
    <td>9.94%</td><td>{mm_fytd}</td><td>9.69%</td><td>9.55%</td><td>13.34%</td><td>24.37%</td></tr>
<tr><td>Meezan Rozana Amdani Fund***</td><td>26 Dec 2018</td><td>{day}</td><td></td><td></td><td>50.0000</td>
    <td>9.95%</td><td>10.07%</td><td>9.73%</td><td>9.49%</td><td>13.62%</td><td>5.51%</td></tr>
<tr><td>Meezan Islamic Asaan Cash Fund</td><td>28 Jan 2026</td><td>{day}</td><td></td><td></td><td>51.3272</td>
    <td>9.93%</td><td>10.04%</td><td>10.18%</td><td>10.02%</td><td>0.00%</td><td>10.18%</td></tr>
<tr><td>Equity Funds</td><td colspan="11"></td></tr>
<tr><td>Meezan Islamic Fund</td><td>08 Aug 2003</td><td>{day}</td><td>{nav}</td><td>{offer}</td><td>{nav}</td>
    <td>(1.20%)</td><td>{eq_fytd}</td><td>12.00%</td><td>30.00%</td><td>40.00%</td><td>900.00%</td></tr>
</table>
<p>*** Rozana Amdani distributes daily</p></td></tr></table></body></html>"""

# Day 1, then day 2 where the equity fund pays a 10/unit dividend: NAV falls 100 -> 91 but FYTD rises 5% -> 6.05%.
day1 = EMAIL.format(day="25 Sep 2026", mm_fytd="9.98%", nav="100.0000", offer="103.0000", eq_fytd="5.00%")
day2 = EMAIL.format(day="28 Sep 2026", mm_fytd="9.99%", nav="91.0000", offer="93.7300", eq_fytd="6.05%")

recs = core.records(core.html_grid(day2))
by = {r["fund"]: r for r in recs}
assert len(recs) == 4, recs
assert "Meezan Rozana Amdani Fund" in by  # footnote asterisks stripped
cash = by["Meezan Cash Fund"]
assert cash["category"] == "Money Market Fund" and cash["date"] == "2026-09-28" and cash["launch"] == "2009-06-15"
assert cash["nav"] == 52.876 and cash["offer"] is None and cash["si"] == 24.37 and cash["seq"] == 0
assert json.loads(cash["fy"]) == {"2026": 9.55, "2025": 13.34}
eq = by["Meezan Islamic Fund"]
assert eq["category"] == "Equity Funds" and eq["mtd"] == -1.2  # (1.20%) is negative

api = TestClient(app.app)


def page():  # the dashboard HTML carries all data plus a token for the two API calls it makes
    html = api.get("/").text
    data = json.loads(re.search(r'<script id="data" type="application/json">(.*?)</script>', html, re.S)[1])
    token = re.search(r'name="board-token" content="([^"]+)"', html)[1]
    return html, data, {"X-Board": token, "Sec-Fetch-Site": "same-origin"}


assert page()[1]["summary"]["asof"] is None  # empty database still renders
auth = {"Authorization": "Bearer s3cret"}
assert api.post("/api/ingest", content=day1, headers={"Content-Type": "text/html"}).status_code == 404
for html in (day1, day2, day2):  # the same email twice must not duplicate rows
    res = api.post("/api/ingest", content=html, headers={**auth, "Content-Type": "text/html"})
    assert res.json() == {"funds": 4}, res.text
with core.db().connect() as c:
    assert c.execute(core.text("select count(*) from nav")).scalar() == 8

html, data, mine = page()
out = data["summary"]
f = {x["fund"]: x for x in out["funds"]}
assert out["asof"] == "2026-09-28" and out["fy"] == ["2026", "2025"] and "history" not in out
assert out["funds"][0]["fund"] == "Meezan Cash Fund"  # email order kept
e = f["Meezan Islamic Fund"]
assert e["move"] == 1.0, e["move"]  # total return, not the -9% NAV drop from the dividend
assert e["max_dd"] == 0 and e["entry_load"] == 3.0 and not e["ann"] and e["prev_date"] == "2026-09-25"
years = (core.pd.Timestamp("2026-09-28") - core.pd.Timestamp("2003-08-08")).days / 365.25
assert e["cagr"] == round((10 ** (1 / years) - 1) * 100, 2)  # 900% since inception = 10x
a = f["Meezan Islamic Asaan Cash Fund"]
assert a["ann"] and a["fy1"] is None and a["fy0"] == 10.02  # "0.00%" before launch is not a return
assert a["cagr"] == 10.18 and a["vol"] is None  # annualized funds: SI is already a yearly rate
assert f["Meezan Cash Fund"]["rank"] == 3 and f["Meezan Cash Fund"]["n_cat"] == 3
assert any("Meezan Rozana Amdani Fund" in t for t in out["insights"]["new"]), out["insights"]  # best cash yield

assert [p[0] for p in data["history"]["Meezan Islamic Fund"]] == ["2026-09-25", "2026-09-28"]

# nothing public: no docs or schema, no data API, and the two page calls answer only the page itself
for path in ("/docs", "/redoc", "/openapi.json", "/api/summary", "/api/history?fund=x", "/api/sync"):
    assert api.get(path).status_code == 404, path
assert api.get("/api/status").status_code == 404  # no token
assert api.get("/api/status", headers={**mine, "Sec-Fetch-Site": "cross-site"}).status_code == 404  # another site
assert api.get("/api/status", headers={**mine, "X-Board": "9999999999.forged"}).status_code == 404
assert api.get("/api/refresh").status_code == 404  # the cron call needs the CRON_SECRET
st = api.post("/api/refresh", headers=mine).json()
assert st["problem"] == "setup" and not st["updating"] and st["checked"] and st["version"] == data["version"], st
again = api.post("/api/refresh", headers=mine).json()
assert again["checked"] == st["checked"] and again["next_check"] > again["checked"]  # rate limited: too soon
assert api.get("/api/status", headers=mine).headers["cache-control"] == "no-store"
assert api.get("/api/refresh", headers=auth).status_code == 200  # Vercel Cron

# no word anywhere public about where the prices come from (fund names aside)
public = page()[0].split('<script id="data"')[0] + api.get("/assets/app.js").text + api.get("/assets/app.css").text
public += json.dumps(st) + json.dumps(out["insights"])
assert not re.search(r"e-?mail|inbox|gmail|imap|newsletter|al meezan|almeezan|mi_", public, re.I),     re.search(r".{40}(e-?mail|inbox|gmail|imap|newsletter|al meezan|almeezan|mi_).{40}", public, re.I | re.S)[0]

# the older email template: styled headings, "Jun 15, 2009" dates, FY25 headers, NAV left blank for load funds,
# pension sub-funds named only "Equity Sub Fund", and a fund renamed later
OLD = """<table><tr><td>Funds Category</td><td>Launch Date</td><td>Validity Date</td><td>Repurchase (Rs.)</td>
<td>Offer (Rs.)</td><td>NAV (Rs.)</td><td>MTD</td><td>FYTD</td><td>CYTD</td><td>FY25</td><td>FY24</td><td>Since Inception</td></tr>
<tr style='background:#7030A0;color:white'><td>Equity Funds</td><td colspan='11'></td></tr>
<tr><td>Meezan Islamic Fund</td><td>Aug 08, 2003</td><td>{day}</td><td>{nav}</td><td>{offer}</td><td></td>
    <td>1.00%</td><td>{fytd}</td><td>2.00%</td><td>30.00%</td><td>40.00%</td><td>900.00%</td></tr>
<tr style='background:#7030A0;color:white'><td>Voluntary Pension Scheme</td><td colspan='11'></td></tr>
<tr style='background:#EFEFEF'><td>Meezan Tahaffuz Pension Fund</td><td colspan='11'></td></tr>
<tr><td>Equity Sub Fund</td><td>Jun 28, 2007</td><td>{day}</td><td></td><td></td><td>1,751.5858*</td>
    <td>-4.22%</td><td>-5.89%</td><td>-4.89%</td><td>30.36%</td><td>65.72%</td><td>1,651.53%</td></tr>
<tr><td>{plan}</td><td>Feb 26, 2026</td><td>{day}</td><td></td><td></td><td>{plan_nav}</td>
    <td>13.00%</td><td>13.50%</td><td>12.00%</td><td>0.00%</td><td>0.00%</td><td>12.00%</td></tr>
</table>"""
old = core.records(core.html_grid(OLD.format(day="Sep 29, 2026", nav="91.9418", offer="94.0000", fytd="6.20%",
                                             plan="MFTF-Meezan Paidaar Munafa Plan-34", plan_nav="51.4394")))
o = {r["fund"]: r for r in old}
assert o["Meezan Islamic Fund"]["nav"] == 91.9418 and o["Meezan Islamic Fund"]["date"] == "2026-09-29"  # repurchase = NAV
assert json.loads(o["Meezan Islamic Fund"]["fy"]) == {"2025": 30.0, "2024": 40.0}
sub = o["Meezan Tahaffuz Pension Fund (Equity Sub Fund)"]  # grey heading is a family, not a category
assert sub["category"] == "Voluntary Pension Scheme" and sub["nav"] == 1751.5858 and sub["si"] == 1651.53

# the renamed plan continues its history under the newer name
with core.db().begin() as c:
    core.store(c, [dict(r, fund="MFTF-Meezan Paidaar Munafa Plan-34", date=d, nav=n) for r in old if "Plan" in r["fund"]
                   for d, n in (("2026-09-10", 51.30), ("2026-09-14", 51.4394))])
    core.store(c, [dict(r, fund="MFTF-Meezan Paidar Munafa Plan 34", date=d, nav=n) for r in old if "Plan" in r["fund"]
                   for d, n in (("2026-09-15", 51.4579), ("2026-09-17", 51.4949))])
    core.store(c, [dict(r, fund="MFTF-Meezan Paidaar Munafa Plan-38", date="2026-09-16", nav=50.46) for r in old if "Plan" in r["fund"]])
    names = core.aliases(core.pd.read_sql(core.text("select * from nav"), c, parse_dates=["date", "launch"]))
assert names["MFTF-Meezan Paidaar Munafa Plan-34"] == "MFTF-Meezan Paidar Munafa Plan 34"
assert names["MFTF-Meezan Paidaar Munafa Plan-38"] == "MFTF-Meezan Paidaar Munafa Plan-38"  # different plan number
assert "Fund Board" in api.get("/").text and api.get("/assets/app.js").status_code == 200
print("ok")
