(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const qsa = (s,r=document) => [...r.querySelectorAll(s)];
  const pageMeta = {
    overview:["Infrastructure posture","Overview"],
    hosts:["Infrastructure inventory","Hosts"],
    services:["Dependency health","Services"],
    alerts:["Alert lifecycle","Alerts"],
    incidents:["Reliability record","Incidents"],
    history:["Telemetry history","History"],
    about:["Project architecture","About InfraPulse"]
  };

  const state = {
    mode:localStorage.getItem("infra_health_mode") || (location.port==="8820"?"live":"demo"),
    backendUrl:localStorage.getItem("infra_health_backend_url") || (location.port==="8820"?location.origin:"http://127.0.0.1:8820"),
    data:null,activePage:"overview",selectedHost:null,lastRefresh:null
  };

  function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
  function slug(v){return String(v||"").toLowerCase().replaceAll(" ","-")}
  function fmtTime(iso){if(!iso)return "—";const d=new Date(iso),diff=Math.max(0,Date.now()-d.getTime());if(diff<60000)return "just now";if(diff<3600000)return Math.round(diff/60000)+"m ago";if(diff<86400000)return Math.round(diff/3600000)+"h ago";return Math.round(diff/86400000)+"d ago"}
  function fmtUptime(seconds){let s=Number(seconds)||0;const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600);return d?d+"d "+h+"h":h+"h"}
  function toast(title,msg="",type="info"){const n=document.createElement("div");n.className="toast "+type;n.innerHTML="<strong>"+esc(title)+"</strong><span>"+esc(msg)+"</span>";$("toastRegion").appendChild(n);setTimeout(()=>n.remove(),4200)}
  function cloneDemo(){const saved=sessionStorage.getItem("infra_health_demo_state");if(saved){try{return JSON.parse(saved)}catch{}}return JSON.parse(JSON.stringify(window.INFRA_HEALTH_DEMO))}
  function persistDemo(){if(state.mode==="demo")sessionStorage.setItem("infra_health_demo_state",JSON.stringify(state.data))}
  async function fetchJson(path,options={}){const c=new AbortController(),timer=setTimeout(()=>c.abort(),options.timeout||10000);try{const r=await fetch(state.backendUrl.replace(/\/$/,"")+path,{...options,signal:c.signal,headers:{"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.detail||d.error||"Request failed ("+r.status+")");return d}finally{clearTimeout(timer)}}
  function setMode(kind,title,detail){$("modeLed").className="mode-led"+(kind?" "+kind:"");$("modeTitle").textContent=title;$("modeDetail").textContent=detail}

  async function loadData(showToast=false){
    if(state.mode==="demo"){state.data=cloneDemo();state.lastRefresh=new Date();setMode("","Demo observability","Representative telemetry");renderAll();if(showToast)toast("Telemetry refreshed","Demo infrastructure state reloaded.");return}
    setMode("","Connecting…",state.backendUrl);
    try{state.data=await fetchJson("/api/bootstrap");state.lastRefresh=new Date();setMode("live","Live monitoring",state.backendUrl.replace(/^https?:\/\//,""));renderAll();if(showToast)toast("Telemetry refreshed","Latest persistent monitoring state loaded.")}
    catch(e){setMode("error","Backend unavailable",state.backendUrl.replace(/^https?:\/\//,""));toast("Could not reach monitoring backend",e.message,"error");if(!state.data){state.data=cloneDemo();renderAll()}}
  }

  function openPage(page){
    state.activePage=page;
    qsa("[data-page-panel]").forEach(p=>p.classList.toggle("active",p.dataset.pagePanel===page));
    qsa("[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
    $("pageEyebrow").textContent=pageMeta[page][0];$("pageTitle").textContent=pageMeta[page][1];$("rail").classList.remove("open");
    if(page==="hosts")renderHosts();if(page==="services")renderServices();if(page==="alerts")renderAlerts();if(page==="incidents")renderIncidents();if(page==="history")renderHistory();
  }
  qsa("[data-page]").forEach(b=>b.addEventListener("click",()=>openPage(b.dataset.page)));
  qsa("[data-go]").forEach(b=>b.addEventListener("click",()=>openPage(b.dataset.go)));
  $("menuButton").addEventListener("click",()=>$("rail").classList.toggle("open"));

  function currentAlerts(){return (state.data?.alerts||[]).filter(a=>a.status!=="Resolved")}
  function healthScore(){
    const hosts=state.data?.hosts||[];if(!hosts.length)return 100;
    const scores={Healthy:100,Warning:72,Critical:35,Maintenance:90};
    return Math.round(hosts.reduce((s,h)=>s+(scores[h.state]??60),0)/hosts.length);
  }
  function meterClass(v,h){return Number(v)>=Number(h.critical_threshold)?"crit":Number(v)>=Number(h.warning_threshold)?"warn":""}

  function renderOverview(){
    const hosts=state.data?.hosts||[],alerts=currentAlerts();
    const healthy=hosts.filter(h=>h.state==="Healthy").length,warning=hosts.filter(h=>h.state==="Warning").length,critical=hosts.filter(h=>h.state==="Critical").length;
    const reachable=hosts.filter(h=>h.reachable),avg=reachable.length?Math.round(reachable.reduce((s,h)=>s+Number(h.response_ms||0),0)/reachable.length):0,score=healthScore();
    $("healthScore").textContent=score;$("scoreRing").style.setProperty("--score",score+"%");$("healthyHostSummary").textContent=healthy+" / "+hosts.length;
    $("statHealthy").textContent=healthy;$("statWarning").textContent=warning;$("statCritical").textContent=critical;$("statAlerts").textContent=alerts.length;$("statResponse").textContent=avg+" ms";
    $("hostCountBadge").textContent=hosts.length;$("alertCountBadge").textContent=alerts.length;

    $("hostHealthGrid").innerHTML=hosts.slice(0,6).map(h=>'<article class="health-card" data-host="'+h.id+'"><div class="health-card-top"><div><strong>'+esc(h.hostname)+'</strong><small>'+esc(h.role+" · "+h.site)+'</small></div><span class="health-state '+slug(h.state)+'">'+esc(h.state)+'</span></div><div class="mini-meters">'+[
      ["CPU",h.cpu],["MEM",h.memory],["DISK",h.disk]
    ].map(([k,v])=>'<div class="mini-meter"><span>'+k+' '+v+'%</span><div class="meter"><i class="'+meterClass(v,h)+'" style="width:'+Math.min(100,v)+'%"></i></div></div>').join("")+'</div></article>').join("");

    $("overviewAlerts").innerHTML=alerts.length?alerts.slice().sort((a,b)=>new Date(b.opened_at)-new Date(a.opened_at)).slice(0,6).map(a=>'<div class="alert-row"><i class="severity-dot '+slug(a.severity)+'"></i><div><strong>'+esc(a.host+" · "+a.severity)+'</strong><small>'+esc(a.message)+'</small></div><time>'+fmtTime(a.opened_at)+'</time></div>').join(""):'<div class="empty">No active alerts.</div>';

    const services=state.data?.services||[];
    $("serviceBands").innerHTML=services.slice(0,7).map(s=>{
      const history=[1,1,1,1,1,s.state==="Degraded"?2:s.state==="Down"?3:1,1,1,1,1];
      return '<div class="service-band"><span>'+esc(s.name+" · "+s.host)+'</span><div class="band-track">'+history.map(x=>'<i class="'+(x===2?"warn":x===3?"down":"")+'"></i>').join("")+'</div><strong>'+Number(s.uptime_pct||0).toFixed(2)+'%</strong></div>';
    }).join("");

    const events=[...(state.data?.events||[]),...(state.data?.incidents||[]).map(i=>({at:i.started_at,title:"Incident · "+i.title,detail:i.impact}))].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,6);
    $("recentEvents").innerHTML=events.map(e=>'<div class="event-row"><i class="severity-dot '+(String(e.title).toLowerCase().includes("resolved")?"resolved":"")+'"></i><div><strong>'+esc(e.title)+'</strong><small>'+esc(e.detail)+'</small></div><time>'+fmtTime(e.at)+'</time></div>').join("");

    qsa("[data-host]",$("hostHealthGrid")).forEach(n=>n.addEventListener("click",()=>openHost(Number(n.dataset.host))));
  }

  function refreshHostFilters(){
    const sites=[...new Set((state.data?.hosts||[]).map(h=>h.site))].sort(),sel=$("hostSiteFilter"),cur=sel.value;
    sel.innerHTML='<option value="all">All sites</option>'+sites.map(s=>'<option>'+esc(s)+'</option>').join("");if(sites.includes(cur))sel.value=cur;
  }
  function renderHosts(){
    refreshHostFilters();
    const q=$("hostSearch").value.trim().toLowerCase(),st=$("hostStateFilter").value,site=$("hostSiteFilter").value;
    const list=(state.data?.hosts||[]).filter(h=>{const hay=[h.hostname,h.address,h.role,h.site,h.platform].join(" ").toLowerCase();return(!q||hay.includes(q))&&(st==="all"||h.state===st)&&(site==="all"||h.site===site)});
    $("hostGrid").innerHTML=list.length?list.map(h=>'<article class="host-card" data-id="'+h.id+'"><div class="host-card-head"><div><h3>'+esc(h.hostname)+'</h3><p>'+esc(h.address+" · "+h.role)+'</p></div><span class="host-pill '+slug(h.state)+'">'+esc(h.state)+'</span></div><div class="mini-meters">'+[["CPU",h.cpu],["Memory",h.memory],["Disk",h.disk]].map(([k,v])=>'<div class="mini-meter"><span>'+k+' '+v+'%</span><div class="meter"><i class="'+meterClass(v,h)+'" style="width:'+Math.min(100,v)+'%"></i></div></div>').join("")+'</div><div class="host-meta"><span>'+esc(h.site)+'</span><span>'+esc(h.platform)+'</span><span>'+esc(h.response_ms+" ms")+'</span><span>'+fmtUptime(h.uptime_seconds)+'</span></div><div class="host-foot"><span>'+(h.reachable?"Reachable":"Unreachable")+'</span><span>Updated '+fmtTime(h.updated_at)+'</span></div></article>').join(""):'<div class="empty">No hosts match the filters.</div>';
    qsa("[data-id]",$("hostGrid")).forEach(c=>c.addEventListener("click",()=>openHost(Number(c.dataset.id))));
  }

  function renderServices(){
    $("serviceGrid").innerHTML=(state.data?.services||[]).map(s=>'<article class="service-card"><div class="service-card-top"><div><p class="eyebrow">'+esc(s.host)+'</p><h3>'+esc(s.name+" · TCP/"+s.port)+'</h3></div><span class="service-state '+slug(s.state)+'">'+esc(s.state)+'</span></div><p>'+esc(s.owner+" · dependency: "+s.dependency)+'</p><div class="service-stats"><div><span>Response</span><strong>'+s.response_ms+' ms</strong></div><div><span>Uptime</span><strong>'+Number(s.uptime_pct).toFixed(2)+'%</strong></div><div><span>Host</span><strong>'+esc(s.host)+'</strong></div></div></article>').join("");
  }

  function renderAlerts(){
    const q=$("alertSearch").value.trim().toLowerCase(),sev=$("alertSeverityFilter").value,st=$("alertStatusFilter").value;
    const list=(state.data?.alerts||[]).filter(a=>{const hay=[a.host,a.message,a.severity,a.status,a.metric].join(" ").toLowerCase();return(!q||hay.includes(q))&&(sev==="all"||a.severity===sev)&&(st==="all"||a.status===st)}).sort((a,b)=>new Date(b.opened_at)-new Date(a.opened_at));
    $("alertTable").innerHTML=list.length?list.map(a=>'<article class="alert-card"><i class="severity-dot '+slug(a.severity)+'"></i><div><h3>'+esc(a.host+" · "+a.severity)+'</h3><p>'+esc(a.message)+'</p></div><div class="alert-meta">'+esc(a.status)+'<br>'+fmtTime(a.opened_at)+'</div><div class="alert-actions">'+(a.status==="Open"?'<button class="tiny-btn ack" data-ack="'+a.id+'">Acknowledge</button>':'')+(a.status!=="Resolved"?'<button class="tiny-btn resolve" data-resolve="'+a.id+'">Resolve</button>':'')+'</div></article>').join(""):'<div class="empty">No alerts match the filters.</div>';
    qsa("[data-ack]").forEach(b=>b.addEventListener("click",()=>updateAlert(Number(b.dataset.ack),"Acknowledged")));
    qsa("[data-resolve]").forEach(b=>b.addEventListener("click",()=>updateAlert(Number(b.dataset.resolve),"Resolved")));
  }

  async function updateAlert(id,status){
    if(state.mode==="live"){try{await fetchJson("/api/alerts/"+id,{method:"PUT",body:JSON.stringify({status})});await loadData();toast("Alert updated",status)}catch(e){toast("Could not update alert",e.message,"error")}return}
    const a=state.data.alerts.find(x=>x.id===id);if(!a)return;a.status=status;a.updated_at=new Date().toISOString();state.data.events.unshift({id:Date.now(),at:new Date().toISOString(),type:"alert",title:"Alert "+status.toLowerCase(),detail:a.host+" · "+a.message});persistDemo();renderAll();toast("Alert updated",a.host+" · "+status);
  }

  function renderIncidents(){
    $("incidentGrid").innerHTML=(state.data?.incidents||[]).slice().sort((a,b)=>new Date(b.started_at)-new Date(a.started_at)).map(i=>'<article class="incident-card '+slug(i.status==="Resolved"?"resolved":"open")+'"><p class="eyebrow">'+esc(i.severity+" · "+i.status)+'</p><h3>'+esc(i.title)+'</h3><p>'+esc(i.impact)+'</p><div class="incident-meta"><div><span>Owner</span><strong>'+esc(i.owner)+'</strong></div><div><span>Started</span><strong>'+fmtTime(i.started_at)+'</strong></div><div><span>Duration</span><strong>'+(i.ended_at?Math.round((new Date(i.ended_at)-new Date(i.started_at))/60000)+" min":"Ongoing")+'</strong></div><div><span>Root cause</span><strong>'+esc(i.root_cause)+'</strong></div></div></article>').join("");
  }

  function spark(values){
    const max=Math.max(1,...values);return '<div class="sparkline">'+values.map(v=>'<i style="height:'+Math.max(8,v/max*100)+'%"></i>').join("")+'</div>';
  }
  function renderHistory(){
    const sel=$("historyHost"),cur=sel.value;
    sel.innerHTML=(state.data?.hosts||[]).map(h=>'<option value="'+h.id+'">'+esc(h.hostname)+'</option>').join("");if([...sel.options].some(o=>o.value===cur))sel.value=cur;
    const hostId=Number(sel.value),samples=(state.data?.samples||[]).filter(s=>s.host_id===hostId).sort((a,b)=>new Date(a.at)-new Date(b.at)),latest=samples[samples.length-1];
    const cards=[["CPU",latest?.cpu||0,samples.map(s=>s.cpu),"%"],["Memory",latest?.memory||0,samples.map(s=>s.memory),"%"],["Disk",latest?.disk||0,samples.map(s=>s.disk),"%"],["Response",latest?.response_ms||0,samples.map(s=>s.response_ms)," ms"]];
    $("sparkGrid").innerHTML=cards.map(([k,v,vals,suffix])=>'<div class="spark-card"><span>'+k+'</span><strong>'+v+suffix+'</strong>'+spark(vals)+'</div>').join("");
    $("historyTableBody").innerHTML=samples.slice().reverse().map(s=>'<tr><td>'+new Date(s.at).toLocaleString()+'</td><td>'+(s.reachable?"Yes":"No")+'</td><td>'+s.response_ms+' ms</td><td>'+s.cpu+'%</td><td>'+s.memory+'%</td><td>'+s.disk+'%</td><td><span class="health-state '+slug(s.health)+'">'+esc(s.health)+'</span></td></tr>').join("");
  }

  async function openHost(id){
    const h=(state.data?.hosts||[]).find(x=>x.id===id);if(!h)return;state.selectedHost=id;
    $("hostDialogTitle").textContent=h.hostname;$("detailHostname").textContent=h.hostname;$("detailAddress").textContent=h.address;$("detailRole").textContent=h.role+" · "+h.site;$("detailStateDot").className="host-state-dot "+slug(h.state);
    $("editHostname").value=h.hostname;$("editAddress").value=h.address;$("editRole").value=h.role;$("editSite").value=h.site;$("editPlatform").value=h.platform;$("editPorts").value=(h.ports||[]).join(",");$("editWarning").value=h.warning_threshold;$("editCritical").value=h.critical_threshold;$("editMaintenance").checked=!!h.maintenance;
    $("detailTelemetry").innerHTML=[["CPU",h.cpu+"%"],["Memory",h.memory+"%"],["Disk",h.disk+"%"],["Uptime",fmtUptime(h.uptime_seconds)]].map(([k,v])=>'<div class="telemetry-tile"><span>'+k+'</span><strong>'+v+'</strong></div>').join("");
    $("detailServices").innerHTML=(state.data.services||[]).filter(s=>s.host_id===id).map(s=>'<div class="mini-row"><i class="severity-dot '+(s.state==="Down"?"critical":s.state==="Degraded"?"":"resolved")+'"></i><div><strong>'+esc(s.name+" · TCP/"+s.port)+'</strong><small>'+esc(s.state+" · "+s.response_ms+" ms")+'</small></div><time>'+Number(s.uptime_pct).toFixed(2)+'%</time></div>').join("")||'<div class="empty">No services configured.</div>';
    $("detailAlerts").innerHTML=(state.data.alerts||[]).filter(a=>a.host_id===id).slice(0,5).map(a=>'<div class="mini-row"><i class="severity-dot '+slug(a.severity)+'"></i><div><strong>'+esc(a.severity+" · "+a.status)+'</strong><small>'+esc(a.message)+'</small></div><time>'+fmtTime(a.opened_at)+'</time></div>').join("")||'<div class="empty">No alerts for this host.</div>';
    $("hostDialog").showModal();
  }

  $("saveHostButton").addEventListener("click",async()=>{
    const id=state.selectedHost;if(!id)return;const body={hostname:$("editHostname").value.trim(),address:$("editAddress").value.trim(),role:$("editRole").value.trim(),site:$("editSite").value.trim(),platform:$("editPlatform").value.trim(),ports:$("editPorts").value.split(",").map(x=>Number(x.trim())).filter(x=>Number.isInteger(x)&&x>0&&x<65536),warning_threshold:Number($("editWarning").value)||75,critical_threshold:Number($("editCritical").value)||90,maintenance:$("editMaintenance").checked};
    if(body.warning_threshold>=body.critical_threshold){toast("Invalid thresholds","Warning threshold must be below critical threshold.","error");return}
    if(state.mode==="live"){try{await fetchJson("/api/hosts/"+id,{method:"PUT",body:JSON.stringify(body)});$("hostDialog").close();await loadData();toast("Host updated",body.hostname)}catch(e){toast("Could not update host",e.message,"error")}return}
    const h=state.data.hosts.find(x=>x.id===id);Object.assign(h,body,{state:body.maintenance?"Maintenance":h.state,updated_at:new Date().toISOString()});persistDemo();$("hostDialog").close();renderAll();toast("Host updated",h.hostname);
  });

  $("addHostButton").addEventListener("click",()=>{$("addHostForm").reset();$("addHostDialog").showModal()});
  $("addHostForm").addEventListener("submit",async e=>{
    e.preventDefault();const body={hostname:$("newHostname").value.trim(),address:$("newAddress").value.trim(),role:$("newRole").value.trim(),site:$("newSite").value.trim(),platform:$("newPlatform").value.trim(),ports:$("newPorts").value.split(",").map(x=>Number(x.trim())).filter(x=>Number.isInteger(x)&&x>0&&x<65536),warning_threshold:75,critical_threshold:90,maintenance:false};
    if(state.mode==="live"){try{const h=await fetchJson("/api/hosts",{method:"POST",body:JSON.stringify(body)});$("addHostDialog").close();await loadData();toast("Host added",h.hostname)}catch(err){toast("Could not add host",err.message,"error")}return}
    const id=Math.max(0,...state.data.hosts.map(h=>h.id))+1,h={id,...body,state:"Healthy",reachable:true,response_ms:0,cpu:0,memory:0,disk:0,uptime_seconds:0,updated_at:new Date().toISOString()};state.data.hosts.push(h);persistDemo();$("addHostDialog").close();renderAll();toast("Host added",h.hostname+" added to demo inventory.");
  });

  function downloadCsv(filename,rows){const csv=rows.map(r=>r.map(v=>'"'+String(v??"").replaceAll('"','""')+'"').join(",")).join("\r\n"),blob=new Blob([csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  $("exportHostsButton").addEventListener("click",()=>downloadCsv("infrastructure-hosts.csv",[["Hostname","Address","Role","Site","Platform","State","CPU","Memory","Disk","ResponseMs","UptimeSeconds"],...(state.data?.hosts||[]).map(h=>[h.hostname,h.address,h.role,h.site,h.platform,h.state,h.cpu,h.memory,h.disk,h.response_ms,h.uptime_seconds])]));
  $("exportHistoryButton").addEventListener("click",()=>{const id=Number($("historyHost").value),h=state.data.hosts.find(x=>x.id===id),samples=(state.data.samples||[]).filter(s=>s.host_id===id);downloadCsv((h?.hostname||"host")+"-telemetry.csv",[["Timestamp","Reachable","ResponseMs","CPU","Memory","Disk","Health"],...samples.map(s=>[s.at,s.reachable,s.response_ms,s.cpu,s.memory,s.disk,s.health])])});

  ["hostSearch"].forEach(id=>$(id).addEventListener("input",renderHosts));["hostStateFilter","hostSiteFilter"].forEach(id=>$(id).addEventListener("change",renderHosts));$("alertSearch").addEventListener("input",renderAlerts);$("alertSeverityFilter").addEventListener("change",renderAlerts);$("alertStatusFilter").addEventListener("change",renderAlerts);$("historyHost").addEventListener("change",renderHistory);$("refreshButton").addEventListener("click",()=>loadData(true));

  const conn=$("connectionDialog");$("connectionButton").addEventListener("click",()=>{qsa('input[name="mode"]').forEach(r=>r.checked=r.value===state.mode);$("backendUrlInput").value=state.backendUrl;conn.showModal()});
  $("saveConnectionButton").addEventListener("click",()=>{const mode=qsa('input[name="mode"]').find(r=>r.checked)?.value||"demo",url=$("backendUrlInput").value.trim().replace(/\/$/,"");if(mode==="live"&&!/^https?:\/\//i.test(url)){toast("Invalid backend URL","Use http://127.0.0.1:8820","error");return}state.mode=mode;state.backendUrl=url||"http://127.0.0.1:8820";localStorage.setItem("infra_health_mode",mode);localStorage.setItem("infra_health_backend_url",state.backendUrl);conn.close();state.data=null;loadData(true)});

  function renderAll(){if(!state.data)return;$("lastRefresh").textContent=(state.lastRefresh||new Date()).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});renderOverview();renderHosts();renderServices();renderAlerts();renderIncidents();renderHistory()}
  setInterval(()=>{if(state.mode==="live"&&document.visibilityState==="visible")loadData(false)},30000);
  loadData();
})();