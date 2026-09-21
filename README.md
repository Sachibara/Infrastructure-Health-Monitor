# Infrastructure Health Monitor

A portfolio-grade infrastructure observability and reliability platform for IT Operations, NOC, Systems Administration, Network Support, and Infrastructure roles.

## Operating Modes

- **Portfolio Demo Mode** — public static deployment with realistic host telemetry, service health, alerts, incidents, uptime, and history.
- **Live Backend Mode** — local FastAPI + SQLite backend with psutil telemetry for the monitoring host plus explicitly configured reachability and TCP service checks.

## Core Features

- Host / server inventory
- CPU, memory, disk, and uptime telemetry
- Reachability checks
- TCP service health checks
- Response-time history
- Warning / critical thresholds
- Infrastructure health score
- Alert lifecycle
- Incident history
- Maintenance mode
- Service dependency documentation
- Uptime and SLO-style views
- Telemetry history
- CSV export
- REST API
- SQLite persistence
- Responsive observability UI

## Run Live Mode

```powershell
python -m pip install -r backend/requirements.txt
python backend/health_api.py
```

Then open:

```text
http://127.0.0.1:8820
```

## Monitoring Scope

The live backend does not sweep or discover networks automatically. It monitors only the local machine and hosts/services explicitly entered by the operator.

Use it only for systems you own or are authorized to monitor.

## Developer

**Jim Rodmark Camus**  
BSIT — Network Technology  
GitHub: [@Sachibara](https://github.com/Sachibara)
