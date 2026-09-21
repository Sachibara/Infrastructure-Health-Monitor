from __future__ import annotations

import os
import platform
import socket
import sqlite3
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "health.db"
DB_LOCK = threading.RLock()
STOP_EVENT = threading.Event()
MONITOR_THREAD: threading.Thread | None = None

PORT_NAMES = {
    22: "SSH", 53: "DNS", 80: "HTTP", 88: "Kerberos", 389: "LDAP",
    443: "HTTPS", 445: "SMB", 1433: "SQL Server", 3306: "MySQL",
    3389: "RDP", 5432: "PostgreSQL", 8080: "HTTP Alt", 8820: "InfraPulse API",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with DB_LOCK, db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS hosts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hostname TEXT NOT NULL UNIQUE,
                address TEXT NOT NULL,
                role TEXT NOT NULL,
                site TEXT NOT NULL,
                platform TEXT NOT NULL,
                ports_json TEXT NOT NULL DEFAULT '[]',
                warning_threshold INTEGER NOT NULL DEFAULT 75,
                critical_threshold INTEGER NOT NULL DEFAULT 90,
                maintenance INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL DEFAULT 'Healthy',
                reachable INTEGER NOT NULL DEFAULT 0,
                response_ms INTEGER NOT NULL DEFAULT 0,
                cpu REAL NOT NULL DEFAULT 0,
                memory REAL NOT NULL DEFAULT 0,
                disk REAL NOT NULL DEFAULT 0,
                uptime_seconds INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS services(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                port INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'Unknown',
                response_ms INTEGER NOT NULL DEFAULT 0,
                uptime_pct REAL NOT NULL DEFAULT 100,
                owner TEXT NOT NULL DEFAULT 'Infrastructure',
                dependency TEXT NOT NULL DEFAULT 'Network',
                updated_at TEXT NOT NULL,
                UNIQUE(host_id, port),
                FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS alerts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                service_id INTEGER,
                severity TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT NOT NULL,
                metric TEXT NOT NULL,
                value REAL NOT NULL DEFAULT 0,
                threshold REAL NOT NULL DEFAULT 0,
                opened_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE CASCADE,
                FOREIGN KEY(service_id) REFERENCES services(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS incidents(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                severity TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                owner TEXT NOT NULL,
                impact TEXT NOT NULL,
                root_cause TEXT NOT NULL DEFAULT '',
                host_id INTEGER,
                FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS samples(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                at TEXT NOT NULL,
                reachable INTEGER NOT NULL,
                response_ms INTEGER NOT NULL,
                cpu REAL NOT NULL,
                memory REAL NOT NULL,
                disk REAL NOT NULL,
                health TEXT NOT NULL,
                FOREIGN KEY(host_id) REFERENCES hosts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS events(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at TEXT NOT NULL,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                detail TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_samples_host_time ON samples(host_id, at);
            CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, updated_at);
            """
        )
        seed(conn)
        conn.commit()


def seed(conn: sqlite3.Connection) -> None:
    if conn.execute("SELECT 1 FROM hosts LIMIT 1").fetchone():
        return
    now = utc_now()
    rows = [
        ("MON-NODE-01","127.0.0.1","Monitoring Node","HQ",platform.system()+" "+platform.release(),"[8820]",80,92,0),
        ("APP-SRV-01","10.22.10.20","Application Server","Datacenter","Windows Server 2022","[80,443]",75,90,0),
        ("DB-SRV-01","10.22.10.21","Database Server","Datacenter","Windows Server 2022","[1433]",75,90,0),
        ("SRV-AD01","10.20.30.10","Domain Controller","HQ","Windows Server 2022","[53,88,389,445]",75,90,0),
    ]
    for row in rows:
        conn.execute(
            """
            INSERT INTO hosts(
                hostname,address,role,site,platform,ports_json,warning_threshold,
                critical_threshold,maintenance,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)
            """,
            (*row,now),
        )
    for host in conn.execute("SELECT * FROM hosts").fetchall():
        sync_services(conn,host["id"],parse_ports(host["ports_json"]))
    conn.execute(
        "INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",
        (now,"system","Monitoring initialized","Initial infrastructure monitor inventory created."),
    )


def parse_ports(raw: str) -> list[int]:
    import json
    try:
        values=json.loads(raw or "[]")
    except Exception:
        values=[]
    return sorted({int(v) for v in values if isinstance(v,(int,float)) and 0<int(v)<65536})


def service_name(port: int) -> str:
    return PORT_NAMES.get(port,f"TCP/{port}")


def sync_services(conn: sqlite3.Connection, host_id: int, ports: list[int]) -> None:
    now=utc_now()
    existing={r["port"]:r["id"] for r in conn.execute("SELECT id,port FROM services WHERE host_id=?",(host_id,)).fetchall()}
    wanted=set(ports)
    for port in wanted:
        if port not in existing:
            conn.execute(
                "INSERT INTO services(host_id,name,port,state,response_ms,uptime_pct,owner,dependency,updated_at) VALUES(?,?,?,'Unknown',0,100,'Infrastructure','Network',?)",
                (host_id,service_name(port),port,now),
            )
    stale=[sid for port,sid in existing.items() if port not in wanted]
    if stale:
        conn.executemany("DELETE FROM services WHERE id=?",[(sid,) for sid in stale])


def ping_host(address: str) -> tuple[bool,int]:
    if address in {"127.0.0.1","localhost","::1"}:
        return True,1
    flag="-n" if os.name=="nt" else "-c"
    timeout_flag="-w" if os.name=="nt" else "-W"
    timeout_value="1200" if os.name=="nt" else "1"
    started=time.perf_counter()
    try:
        result=subprocess.run(
            ["ping",flag,"1",timeout_flag,timeout_value,address],
            capture_output=True,text=True,timeout=3,
        )
        ms=max(1,round((time.perf_counter()-started)*1000))
        return result.returncode==0,ms
    except Exception:
        return False,0


def tcp_check(address: str, port: int) -> tuple[bool,int]:
    started=time.perf_counter()
    try:
        with socket.create_connection((address,port),timeout=1.5):
            return True,max(1,round((time.perf_counter()-started)*1000))
    except OSError:
        return False,max(1,round((time.perf_counter()-started)*1000))


def local_telemetry() -> tuple[float,float,float,int]:
    cpu=psutil.cpu_percent(interval=0.1)
    memory=psutil.virtual_memory().percent
    disk=psutil.disk_usage(Path.home().anchor or "/").percent
    uptime=max(0,int(time.time()-psutil.boot_time()))
    return round(cpu,1),round(memory,1),round(disk,1),uptime


def evaluate_health(host: sqlite3.Row, reachable: bool, cpu: float, memory: float, disk: float) -> str:
    if host["maintenance"]:
        return "Maintenance"
    if not reachable:
        return "Critical"
    peak=max(cpu,memory,disk)
    if peak>=host["critical_threshold"]:
        return "Critical"
    if peak>=host["warning_threshold"]:
        return "Warning"
    return "Healthy"


def active_alert(conn: sqlite3.Connection,host_id: int,metric: str,service_id: int|None=None) -> sqlite3.Row|None:
    if service_id is None:
        return conn.execute(
            "SELECT * FROM alerts WHERE host_id=? AND metric=? AND service_id IS NULL AND status<>'Resolved' ORDER BY id DESC LIMIT 1",
            (host_id,metric),
        ).fetchone()
    return conn.execute(
        "SELECT * FROM alerts WHERE host_id=? AND metric=? AND service_id=? AND status<>'Resolved' ORDER BY id DESC LIMIT 1",
        (host_id,metric,service_id),
    ).fetchone()


def open_or_resolve_alert(
    conn: sqlite3.Connection,host: sqlite3.Row,metric: str,is_active: bool,severity: str,
    message: str,value: float,threshold: float,service_id: int|None=None
) -> None:
    current=active_alert(conn,host["id"],metric,service_id)
    now=utc_now()
    if is_active and not host["maintenance"]:
        if current:
            conn.execute(
                "UPDATE alerts SET severity=?,message=?,value=?,threshold=?,updated_at=? WHERE id=?",
                (severity,message,value,threshold,now,current["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO alerts(host_id,service_id,severity,status,message,metric,value,threshold,opened_at,updated_at)
                VALUES(?,? ,?,'Open',?,?,?,?,?,?)
                """,
                (host["id"],service_id,severity,message,metric,value,threshold,now,now),
            )
            conn.execute(
                "INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",
                (now,"alert",f"{severity} alert opened",f"{host['hostname']} · {message}"),
            )
    elif current:
        conn.execute(
            "UPDATE alerts SET status='Resolved',updated_at=? WHERE id=?",
            (now,current["id"]),
        )
        conn.execute(
            "INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",
            (now,"resolve","Alert resolved",f"{host['hostname']} · {current['message']}"),
        )


def monitor_host(host_id: int) -> None:
    with DB_LOCK, db() as conn:
        host=conn.execute("SELECT * FROM hosts WHERE id=?",(host_id,)).fetchone()
        if not host:
            return
        ports=parse_ports(host["ports_json"])

    reachable,response_ms=ping_host(host["address"])
    if host["address"] in {"127.0.0.1","localhost","::1"}:
        cpu,memory,disk,uptime=local_telemetry()
    else:
        cpu,memory,disk,uptime=host["cpu"],host["memory"],host["disk"],host["uptime_seconds"]

    state=evaluate_health(host,reachable,cpu,memory,disk)
    now=utc_now()

    with DB_LOCK, db() as conn:
        conn.execute(
            """
            UPDATE hosts SET reachable=?,response_ms=?,cpu=?,memory=?,disk=?,uptime_seconds=?,state=?,updated_at=?
            WHERE id=?
            """,
            (int(reachable),response_ms,cpu,memory,disk,uptime,state,now,host_id),
        )
        conn.execute(
            "INSERT INTO samples(host_id,at,reachable,response_ms,cpu,memory,disk,health) VALUES(?,?,?,?,?,?,?,?)",
            (host_id,now,int(reachable),response_ms,cpu,memory,disk,state),
        )
        conn.execute(
            "DELETE FROM samples WHERE id IN (SELECT id FROM samples WHERE host_id=? ORDER BY at DESC,id DESC LIMIT -1 OFFSET 500)",
            (host_id,),
        )

        fresh=conn.execute("SELECT * FROM hosts WHERE id=?",(host_id,)).fetchone()
        open_or_resolve_alert(conn,fresh,"reachability",not reachable,"Critical",f"{fresh['hostname']} is unreachable.",0,1)
        for metric,value in (("cpu",cpu),("memory",memory),("disk",disk)):
            crit=value>=fresh["critical_threshold"]
            warn=value>=fresh["warning_threshold"] and not crit
            active=crit or warn
            sev="Critical" if crit else "Warning"
            threshold=fresh["critical_threshold"] if crit else fresh["warning_threshold"]
            msg=f"{metric.capitalize()} utilization is {value:.0f}%, above {sev.lower()} threshold {threshold}%."
            open_or_resolve_alert(conn,fresh,metric,active,sev,msg,value,threshold)

        for service in conn.execute("SELECT * FROM services WHERE host_id=? ORDER BY port",(host_id,)).fetchall():
            up,latency=tcp_check(fresh["address"],service["port"]) if reachable else (False,0)
            service_state="Up" if up else "Down"
            previous=float(service["uptime_pct"])
            uptime_pct=round(max(0,min(100,previous*0.98+(100 if up else 0)*0.02)),2)
            conn.execute(
                "UPDATE services SET state=?,response_ms=?,uptime_pct=?,updated_at=? WHERE id=?",
                (service_state,latency,uptime_pct,now,service["id"]),
            )
            open_or_resolve_alert(
                conn,fresh,f"service:{service['port']}",not up,"Critical",
                f"{service['name']} TCP/{service['port']} is not responding.",0,1,service["id"]
            )
        conn.commit()


def monitor_cycle() -> None:
    with DB_LOCK, db() as conn:
        ids=[r["id"] for r in conn.execute("SELECT id FROM hosts ORDER BY id").fetchall()]
    for host_id in ids:
        if STOP_EVENT.is_set():
            return
        try:
            monitor_host(host_id)
        except Exception as exc:
            print(f"[InfraPulse] Monitor error for host {host_id}: {exc}")


def monitor_loop() -> None:
    while not STOP_EVENT.is_set():
        monitor_cycle()
        STOP_EVENT.wait(30)


def host_dict(row: sqlite3.Row) -> dict[str,Any]:
    item=dict(row)
    item["ports"]=parse_ports(item.pop("ports_json"))
    item["maintenance"]=bool(item["maintenance"])
    item["reachable"]=bool(item["reachable"])
    return item


def bootstrap() -> dict[str,Any]:
    with DB_LOCK, db() as conn:
        hosts=[host_dict(r) for r in conn.execute("SELECT * FROM hosts ORDER BY site,hostname").fetchall()]
        names={h["id"]:h["hostname"] for h in hosts}
        services=[]
        for r in conn.execute("SELECT * FROM services ORDER BY host_id,port").fetchall():
            item=dict(r);item["host"]=names.get(item["host_id"],"Unknown");services.append(item)
        alerts=[]
        for r in conn.execute("SELECT * FROM alerts ORDER BY opened_at DESC,id DESC LIMIT 500").fetchall():
            item=dict(r);item["host"]=names.get(item["host_id"],"Unknown");alerts.append(item)
        incidents=[dict(r) for r in conn.execute("SELECT * FROM incidents ORDER BY started_at DESC,id DESC LIMIT 200").fetchall()]
        samples=[dict(r) for r in conn.execute("SELECT * FROM samples ORDER BY at DESC,id DESC LIMIT 3000").fetchall()]
        events=[dict(r) for r in conn.execute("SELECT * FROM events ORDER BY at DESC,id DESC LIMIT 300").fetchall()]
    return {"generated_at":utc_now(),"hosts":hosts,"services":services,"alerts":alerts,"incidents":incidents,"samples":samples,"events":events}


class HostPayload(BaseModel):
    hostname: str = Field(min_length=1,max_length=120)
    address: str = Field(min_length=1,max_length=255)
    role: str = Field(min_length=1,max_length=120)
    site: str = Field(min_length=1,max_length=120)
    platform: str = Field(min_length=1,max_length=120)
    ports: list[int] = Field(default_factory=list)
    warning_threshold: int = Field(default=75,ge=1,le=99)
    critical_threshold: int = Field(default=90,ge=2,le=100)
    maintenance: bool = False


class AlertUpdate(BaseModel):
    status: str


@asynccontextmanager
async def lifespan(_: FastAPI):
    global MONITOR_THREAD
    init_db()
    STOP_EVENT.clear()
    MONITOR_THREAD=threading.Thread(target=monitor_loop,daemon=True,name="infra-health-monitor")
    MONITOR_THREAD.start()
    yield
    STOP_EVENT.set()
    if MONITOR_THREAD and MONITOR_THREAD.is_alive():
        MONITOR_THREAD.join(timeout=2)


app=FastAPI(title="Infrastructure Health Monitor API",version="1.0.0",lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8820","http://localhost:8820","https://sachibara.github.io"],
    allow_credentials=False,
    allow_methods=["GET","POST","PUT"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
def api_health():
    return {"ok":True,"service":"Infrastructure Health Monitor","database":str(DB_PATH)}


@app.get("/api/bootstrap")
def api_bootstrap():
    return bootstrap()


@app.post("/api/hosts")
def api_create_host(request: HostPayload):
    if request.warning_threshold>=request.critical_threshold:
        raise HTTPException(status_code=400,detail="Warning threshold must be below critical threshold.")
    ports=sorted({p for p in request.ports if 0<p<65536})
    import json
    with DB_LOCK, db() as conn:
        if conn.execute("SELECT 1 FROM hosts WHERE hostname=?",(request.hostname.strip(),)).fetchone():
            raise HTTPException(status_code=409,detail="Hostname already exists.")
        cur=conn.execute(
            """
            INSERT INTO hosts(
                hostname,address,role,site,platform,ports_json,warning_threshold,critical_threshold,
                maintenance,state,reachable,response_ms,cpu,memory,disk,uptime_seconds,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,'Healthy',0,0,0,0,0,0,?)
            """,
            (
                request.hostname.strip(),request.address.strip(),request.role.strip(),request.site.strip(),
                request.platform.strip(),json.dumps(ports),request.warning_threshold,request.critical_threshold,
                int(request.maintenance),utc_now(),
            ),
        )
        host_id=int(cur.lastrowid)
        sync_services(conn,host_id,ports)
        conn.execute("INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",(utc_now(),"inventory","Host added",request.hostname.strip()+" added to monitoring inventory."))
        conn.commit()
        row=conn.execute("SELECT * FROM hosts WHERE id=?",(host_id,)).fetchone()
    threading.Thread(target=monitor_host,args=(host_id,),daemon=True).start()
    return host_dict(row)


@app.put("/api/hosts/{host_id}")
def api_update_host(host_id: int,request: HostPayload):
    if request.warning_threshold>=request.critical_threshold:
        raise HTTPException(status_code=400,detail="Warning threshold must be below critical threshold.")
    ports=sorted({p for p in request.ports if 0<p<65536})
    import json
    with DB_LOCK, db() as conn:
        current=conn.execute("SELECT * FROM hosts WHERE id=?",(host_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404,detail="Host not found.")
        duplicate=conn.execute("SELECT 1 FROM hosts WHERE hostname=? AND id<>?",(request.hostname.strip(),host_id)).fetchone()
        if duplicate:
            raise HTTPException(status_code=409,detail="Hostname already exists.")
        conn.execute(
            """
            UPDATE hosts SET hostname=?,address=?,role=?,site=?,platform=?,ports_json=?,
            warning_threshold=?,critical_threshold=?,maintenance=?,state=?,updated_at=? WHERE id=?
            """,
            (
                request.hostname.strip(),request.address.strip(),request.role.strip(),request.site.strip(),
                request.platform.strip(),json.dumps(ports),request.warning_threshold,request.critical_threshold,
                int(request.maintenance),"Maintenance" if request.maintenance else current["state"],utc_now(),host_id,
            ),
        )
        sync_services(conn,host_id,ports)
        conn.execute("INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",(utc_now(),"inventory","Host updated",request.hostname.strip()+" monitoring settings updated."))
        conn.commit()
        row=conn.execute("SELECT * FROM hosts WHERE id=?",(host_id,)).fetchone()
    return host_dict(row)


@app.put("/api/alerts/{alert_id}")
def api_update_alert(alert_id: int,request: AlertUpdate):
    if request.status not in {"Open","Acknowledged","Resolved"}:
        raise HTTPException(status_code=400,detail="Invalid alert status.")
    with DB_LOCK, db() as conn:
        row=conn.execute("SELECT a.*,h.hostname FROM alerts a JOIN hosts h ON h.id=a.host_id WHERE a.id=?",(alert_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail="Alert not found.")
        conn.execute("UPDATE alerts SET status=?,updated_at=? WHERE id=?",(request.status,utc_now(),alert_id))
        conn.execute("INSERT INTO events(at,type,title,detail) VALUES(?,?,?,?)",(utc_now(),"alert","Alert "+request.status.lower(),row["hostname"]+" · "+row["message"]))
        conn.commit()
    return {"ok":True,"id":alert_id,"status":request.status}


@app.post("/api/monitor/run")
def api_run_monitor():
    monitor_cycle()
    return {"ok":True,"sampled_at":utc_now()}


@app.get("/")
def ui():
    return FileResponse(ROOT/"index.html")


@app.get("/styles.css")
def styles():
    return FileResponse(ROOT/"styles.css",media_type="text/css")


@app.get("/demo-data.js")
def demo():
    return FileResponse(ROOT/"demo-data.js",media_type="application/javascript")


@app.get("/app.js")
def script():
    return FileResponse(ROOT/"app.js",media_type="application/javascript")


def main() -> None:
    import uvicorn
    print("Infrastructure Health Monitor: http://127.0.0.1:8820")
    uvicorn.run(app,host="127.0.0.1",port=8820,log_level="info")


if __name__=="__main__":
    main()
