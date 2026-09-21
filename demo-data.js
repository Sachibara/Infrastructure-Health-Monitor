window.INFRA_HEALTH_DEMO = (() => {
  const now = Date.now();
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const hoursAgo = (h) => new Date(now - h * 3600000).toISOString();

  const hosts = [
    {id:1,hostname:"APP-SRV-01",address:"10.22.10.20",role:"Application Server",site:"Datacenter",platform:"Windows Server 2022",state:"Healthy",reachable:true,response_ms:18,cpu:42,memory:61,disk:55,uptime_seconds:1189440,warning_threshold:75,critical_threshold:90,maintenance:false,ports:[80,443],updated_at:ago(1)},
    {id:2,hostname:"DB-SRV-01",address:"10.22.10.21",role:"Database Server",site:"Datacenter",platform:"Windows Server 2022",state:"Warning",reachable:true,response_ms:21,cpu:76,memory:82,disk:69,uptime_seconds:864000,warning_threshold:75,critical_threshold:90,maintenance:false,ports:[1433],updated_at:ago(1)},
    {id:3,hostname:"SRV-AD01",address:"10.20.30.10",role:"Domain Controller",site:"HQ",platform:"Windows Server 2022",state:"Healthy",reachable:true,response_ms:8,cpu:28,memory:49,disk:46,uptime_seconds:2188800,warning_threshold:75,critical_threshold:90,maintenance:false,ports:[53,88,389,445],updated_at:ago(1)},
    {id:4,hostname:"SRV-FILE01",address:"10.20.30.15",role:"File Server",site:"HQ",platform:"Windows Server 2022",state:"Critical",reachable:true,response_ms:12,cpu:58,memory:73,disk:94,uptime_seconds:1749600,warning_threshold:75,critical_threshold:90,maintenance:false,ports:[445],updated_at:ago(1)},
    {id:5,hostname:"MON-NODE-01",address:"127.0.0.1",role:"Monitoring Node",site:"HQ",platform:"Windows 11 Pro",state:"Healthy",reachable:true,response_ms:1,cpu:24,memory:57,disk:48,uptime_seconds:392400,warning_threshold:80,critical_threshold:92,maintenance:false,ports:[8820],updated_at:ago(1)},
    {id:6,hostname:"BR-APP-01",address:"10.21.10.20",role:"Branch App Server",site:"Branch",platform:"Ubuntu Server 24.04",state:"Maintenance",reachable:true,response_ms:34,cpu:16,memory:33,disk:41,uptime_seconds:615600,warning_threshold:75,critical_threshold:90,maintenance:true,ports:[22,443],updated_at:ago(1)}
  ];

  const services = [
    {id:1,host_id:1,host:"APP-SRV-01",name:"HTTPS",port:443,state:"Up",response_ms:24,uptime_pct:99.98,owner:"Application Team",dependency:"DB-SRV-01"},
    {id:2,host_id:1,host:"APP-SRV-01",name:"HTTP",port:80,state:"Up",response_ms:20,uptime_pct:99.99,owner:"Application Team",dependency:"HTTPS redirect"},
    {id:3,host_id:2,host:"DB-SRV-01",name:"SQL Server",port:1433,state:"Degraded",response_ms:86,uptime_pct:99.91,owner:"Database Team",dependency:"Storage"},
    {id:4,host_id:3,host:"SRV-AD01",name:"DNS",port:53,state:"Up",response_ms:9,uptime_pct:100,owner:"Infrastructure",dependency:"Network"},
    {id:5,host_id:3,host:"SRV-AD01",name:"LDAP",port:389,state:"Up",response_ms:11,uptime_pct:99.99,owner:"Infrastructure",dependency:"DNS"},
    {id:6,host_id:4,host:"SRV-FILE01",name:"SMB",port:445,state:"Up",response_ms:15,uptime_pct:99.94,owner:"Infrastructure",dependency:"Storage"},
    {id:7,host_id:6,host:"BR-APP-01",name:"HTTPS",port:443,state:"Up",response_ms:39,uptime_pct:99.7,owner:"Branch IT",dependency:"WAN"}
  ];

  const alerts = [
    {id:1,host_id:4,host:"SRV-FILE01",service_id:null,severity:"Critical",status:"Open",message:"Disk utilization reached 94%, above critical threshold 90%.",metric:"disk",value:94,threshold:90,opened_at:ago(18),updated_at:ago(1)},
    {id:2,host_id:2,host:"DB-SRV-01",service_id:null,severity:"Warning",status:"Open",message:"Memory utilization is 82%, above warning threshold 75%.",metric:"memory",value:82,threshold:75,opened_at:ago(34),updated_at:ago(1)},
    {id:3,host_id:2,host:"DB-SRV-01",service_id:3,severity:"Warning",status:"Acknowledged",message:"SQL Server response time increased to 86 ms.",metric:"response_ms",value:86,threshold:75,opened_at:ago(46),updated_at:ago(12)},
    {id:4,host_id:1,host:"APP-SRV-01",service_id:1,severity:"Warning",status:"Resolved",message:"HTTPS health check briefly exceeded response threshold.",metric:"response_ms",value:72,threshold:60,opened_at:hoursAgo(5),updated_at:hoursAgo(4.7)}
  ];

  const incidents = [
    {id:1,title:"File server storage pressure",status:"Open",severity:"High",started_at:ago(18),ended_at:null,owner:"Infrastructure",impact:"File services remain online but disk capacity is above critical threshold.",root_cause:"Capacity growth under review.",host_id:4},
    {id:2,title:"Database response-time degradation",status:"Monitoring",severity:"Medium",started_at:ago(46),ended_at:null,owner:"Database Team",impact:"Higher application query latency.",root_cause:"Memory pressure and query workload under review.",host_id:2},
    {id:3,title:"Application HTTPS latency spike",status:"Resolved",severity:"Low",started_at:hoursAgo(5),ended_at:hoursAgo(4.7),owner:"Application Team",impact:"Brief increase in page response time.",root_cause:"Short-lived deployment warm-up.",host_id:1}
  ];

  function series(host, count=16){
    const list=[];
    for(let i=count-1;i>=0;i--){
      const seed=host.id*13+i*7;
      const cpu=Math.max(5,Math.min(99,host.cpu + ((seed%13)-6)));
      const memory=Math.max(10,Math.min(99,host.memory + ((seed%9)-4)));
      const disk=Math.max(5,Math.min(99,host.disk + ((seed%5)-2)));
      const response=Math.max(1,host.response_ms + ((seed%11)-5));
      const max=Math.max(cpu,memory,disk);
      let health=host.maintenance?"Maintenance":max>=host.critical_threshold?"Critical":max>=host.warning_threshold?"Warning":"Healthy";
      list.push({id:host.id*1000+i,host_id:host.id,at:ago(i*5+1),reachable:host.reachable,response_ms:response,cpu,memory,disk,health});
    }
    return list;
  }

  const samples=hosts.flatMap(h=>series(h));

  const events = [
    {id:1,at:ago(1),type:"sample",title:"Telemetry collected",detail:"Latest infrastructure sample stored."},
    {id:2,at:ago(18),type:"alert",title:"Critical alert opened",detail:"SRV-FILE01 disk utilization exceeded 90%."},
    {id:3,at:ago(34),type:"alert",title:"Warning alert opened",detail:"DB-SRV-01 memory utilization exceeded 75%."},
    {id:4,at:ago(46),type:"incident",title:"Incident opened",detail:"Database response-time degradation under investigation."},
    {id:5,at:hoursAgo(4.7),type:"resolve",title:"Alert resolved",detail:"APP-SRV-01 HTTPS response time returned to normal."}
  ];

  return {generated_at:new Date(now).toISOString(),hosts,services,alerts,incidents,samples,events};
})();